/**
 * The live model catalogue, read from MoArk's own `/v1/models`.
 *
 * This is the line's only source of model truth. There is deliberately no
 * shipped fallback table (see `FALLBACK_MODELS` in `types.ts`), because every
 * name in one would be a guess about what a given resource pack entitles its
 * owner to, and a guess that reaches the picker becomes a model a user can
 * select and then fail on.
 *
 * The endpoint needs no authentication - it answers a 208-entry list to an
 * anonymous GET - but the request is still sent with the caller's token when one
 * is available, because the list a token is entitled to use is the list that
 * token should see, and a resource pack bounds it. An unauthenticated read is
 * used only when the caller has no token yet, which is exactly the case where
 * showing the platform's public catalogue is better than showing nothing.
 *
 * FAILURE IS A RESULT, NOT AN EXCEPTION
 *
 * Every failure mode is reported in the returned value rather than thrown, and
 * each one is named apart because each has a different remedy: a rejected token
 * needs a new token, an upstream status needs a retry, an unreachable host needs
 * a network check, and a malformed body usually means something rewrote the
 * reply. Collapsing them into one message - which is what the sibling line's
 * issue #36 was about - tells the user nothing they can act on.
 */

import {
  CATALOG_TIMEOUT_MS,
  MODELS_PATH,
  OPENAI_BASE_URL,
  isMoarkChatModel,
  moarkBearerHeaders,
  type MoarkCatalogModel,
} from './types.ts'

/** Why a catalogue read produced no list. */
export type MoarkCatalogFailure = 'auth' | 'upstream' | 'unreachable' | 'malformed'

/** The outcome of one catalogue read. */
export interface MoarkCatalogResult {
  /** Chat-capable models, in the service's own order. Empty when `failure` is set. */
  models: MoarkCatalogModel[]
  /** Absent when the read succeeded and produced a list. */
  failure?: MoarkCatalogFailure
  /** The HTTP status, when a response was received at all. */
  status?: number
}

/**
 * Read the catalogue.
 *
 * Never throws: a failed read is reported in the result, because the caller has
 * to render a settings card either way and a rejected promise would reach the
 * card as an unhandled route failure instead of the sentence that names the
 * cause.
 *
 * @param fetchFn - the fetch implementation to use, injected so tests need no network.
 * @param apiKey - the access token to read with; an empty string reads anonymously.
 * @param baseUrl - the surface base to read from; all three answer the same list.
 */
export async function loadCatalog(
  fetchFn: typeof fetch,
  apiKey: string,
  baseUrl: string = OPENAI_BASE_URL,
): Promise<MoarkCatalogResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetchFn(`${baseUrl}${MODELS_PATH}`, {
      method: 'GET',
      headers: apiKey === ''
        ? { accept: 'application/json' }
        : moarkBearerHeaders(apiKey, 'application/json'),
      signal: controller.signal,
    })
  } catch {
    // A transport failure and the timeout above collapse to the same remedy -
    // nothing was learned about the catalogue - so they share one verdict.
    return { models: [], failure: 'unreachable' }
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 401 || response.status === 403) {
    return { models: [], failure: 'auth', status: response.status }
  }
  if (!response.ok) {
    return { models: [], failure: 'upstream', status: response.status }
  }

  let body: unknown
  try {
    body = await response.json() as unknown
  } catch {
    return { models: [], failure: 'malformed', status: response.status }
  }

  const record = typeof body === 'object' && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null
  const data = record?.data
  if (!Array.isArray(data)) {
    return { models: [], failure: 'malformed', status: response.status }
  }

  const fetchedAt = Date.now()
  const models: MoarkCatalogModel[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = (entry as Record<string, unknown>).id
    if (typeof id !== 'string' || id === '') continue
    // The endpoint lists every deployed model, not just chat models. A picker
    // that offered an embedding or a video generator would be offering failures.
    if (!isMoarkChatModel(id)) continue
    models.push({ id, fetchedAt })
  }
  // Stable, case-insensitive order: the service's own order is by creation time,
  // which reshuffles the picker every time a model ships. A user who learned
  // where `qwen3-coder` sits should keep finding it there.
  models.sort((left, right) => left.id.toLowerCase().localeCompare(right.id.toLowerCase()))
  return { models, status: response.status }
}
