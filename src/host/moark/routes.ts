import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginMutation } from '../common/same-origin.ts'
import type { MoarkAccountPool } from './account-pool.ts'
import { loadCatalog, type MoarkCatalogResult } from './catalog.ts'
import type { FileModelSettingsStore, MoarkCredentials } from './token-store.ts'
import { KEYS_URL, OPENAI_BASE_URL, MODELS_PATH } from './types.ts'
import { MOARK_ROUTE_PREFIX, isMoarkWire } from '../../shared/moark-contracts.ts'
import type { MoarkPoolStatusDto, MoarkWebStatus } from '../../shared/moark-contracts.ts'

const ROUTE_PREFIX = MOARK_ROUTE_PREFIX

/** Where a user creates the access tokens this line stores. */
export const MOARK_KEYS_URL = KEYS_URL

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(payload)
}

function sendMethodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { ok: false, error: 'Method not allowed.' })
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    // A pasted token is short; anything far past that is not a credential and is
    // refused before it is buffered whole.
    if (size > 8_192) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

export interface MoarkRouteOptions {
  accountPool: MoarkAccountPool
  modelSettings: FileModelSettingsStore
  fetchFn?: typeof fetch
}

/**
 * The sentence the card shows for a catalogue read that produced nothing.
 *
 * The four causes have four different remedies, so they are named apart rather
 * than collapsed into one "could not read the model list": a rejected token
 * needs a new token, an upstream status needs a retry or a bug report, an
 * unreachable host needs a network check, and a malformed body usually means a
 * proxy rewrote the reply. Telling a user the wrong one costs them the fix.
 */
function catalogFailureMessage(result: MoarkCatalogResult): string {
  switch (result.failure) {
    case 'auth':
      return `MoArk rejected the stored access token (HTTP ${result.status ?? 401}). Create or re-paste one at ${KEYS_URL}.`
    case 'upstream':
      return `MoArk answered HTTP ${result.status ?? '?'} for ${OPENAI_BASE_URL}${MODELS_PATH}.`
    case 'unreachable':
      return 'Could not reach MoArk. Check the network or proxy, then sync again.'
    case 'malformed':
      return 'MoArk answered with something that is not a /v1/models document (a proxy or filter may be rewriting the reply).'
    default:
      return 'Could not read the model list from MoArk.'
  }
}

/** Whether one account can serve a request right now. */
function isUsable(account: { cooldownUntil?: number; authStatus?: string }, now: number): boolean {
  if (account.authStatus !== undefined && account.authStatus !== 'ok') return false
  if (typeof account.cooldownUntil === 'number' && account.cooldownUntil > now) return false
  return true
}

/** Assemble the whole status payload the MoArk tab renders. */
export async function getMoarkWebStatus(options: MoarkRouteOptions): Promise<MoarkWebStatus> {
  const { accountPool, modelSettings } = options
  // A pool that cannot be read must not take the tab down: an empty list is a
  // truthful answer and the card renders its own 'add a token' state from it.
  const data = await accountPool.read().catch(() => null)
  const accounts = await accountPool.listAccounts().catch(() => [])
  const now = Date.now()
  const pool: MoarkPoolStatusDto = {
    accounts,
    rotationStrategy: data?.rotationStrategy ?? 'sequential',
    ...(data?.activeAccountId === undefined ? {} : { activeAccountId: data.activeAccountId }),
  }
  const fallbackSettings = {
    enabled: true, enabledModelIds: null, catalogModels: [], defaultReasoningEffort: null, defaultWire: 'openai' as const,
  }
  const settings = await modelSettings.read().catch(() => fallbackSettings)
  return {
    pool,
    models: settings.catalogModels.map((model) => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(isMoarkWire(model.wire) ? { wire: model.wire } : {}),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    })),
    enabledModelIds: settings.enabledModelIds,
    defaultWire: isMoarkWire(settings.defaultWire) ? settings.defaultWire : 'openai',
    usable: accounts.some((account) => isUsable(account, now)),
    catalogSynced: settings.catalogModels.length > 0,
    keyUrl: KEYS_URL,
  }
}

/**
 * Register the MoArk settings API.
 *
 * The surface is deliberately the same one every other line exposes - status,
 * accounts, settings, models, catalog/refresh - so the shared settings card and
 * the client API helper work against it without a per-provider special case.
 */
export function registerMoarkRoutes(ctx: Context, options: MoarkRouteOptions): () => void {
  const { accountPool, modelSettings } = options
  const fetchFn = options.fetchFn ?? fetch

  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url || '/', 'http://dsh.local')
      const path = url.pathname.replace(/^\/moark\/api\/?/, '')
      const method = request.method ?? 'GET'

      // Every branch below answers inside this try. A handler that rejects gets no
      // envelope at all: DSH's web server catches it and answers a bare 400 with an
      // empty body, which the card could only report as the browser's "Unexpected
      // end of JSON input" - the real cause was logged on the host and nowhere
      // else. The siblings already wrap their handlers this way.
      try {
        if (path === '' || path === 'status') {
          return sendJson(response, 200, { ok: true, value: await getMoarkWebStatus(options) })
        }

        if (path === 'settings') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          const body = await readRequestJson(request).catch(() => ({}) as Record<string, unknown>)
          let touched = false
          // The hub card's line switch; every sibling line commits the same flag
          // through its own '/settings', and the picker learns of the change
          // through the same event they emit.
          if (typeof body.enabled === 'boolean') {
            await modelSettings.update({ enabled: body.enabled })
            touched = true
          }
          // The surface is a line-level setting because MoArk's own catalogue
          // states no protocol per model - see `types.ts`. An unrecognized value is
          // refused rather than stored, so a typo cannot leave the line pointing at
          // a surface it cannot speak.
          if (body.defaultWire !== undefined) {
            if (!isMoarkWire(body.defaultWire)) {
              return sendJson(response, 400, { ok: false, error: 'Unsupported protocol surface.' })
            }
            await modelSettings.update({ defaultWire: body.defaultWire })
            touched = true
          }
          if (touched) ctx.emit?.('llm/adapters-updated')
          return sendJson(response, 200, { ok: true, value: await modelSettings.read() })
        }

        if (path === 'accounts') {
          if (method === 'GET') {
            return sendJson(response, 200, { ok: true, value: await getMoarkWebStatus(options) })
          }
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          let body: Record<string, unknown>
          try {
            body = await readRequestJson(request)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return sendJson(response, 400, { ok: false, error: message })
          }
          const action = typeof body.action === 'string' ? body.action : ''
          const accountId = typeof body.accountId === 'string' ? body.accountId : undefined
          try {
            if (action === 'add') {
              const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
              if (apiKey === '') {
                return sendJson(response, 400, { ok: false, error: 'Access token is required.' })
              }
              // An alias is how several bare tokens stay distinguishable, since the
              // service names nothing about the account behind one.
              const alias = typeof body.alias === 'string' && body.alias.trim() !== ''
                ? body.alias.trim()
                : undefined
              const credentials: MoarkCredentials = { apiKey, addedAt: Date.now() }
              if (alias !== undefined) credentials.alias = alias
              // No early answer here: the card stores the reply of every account
              // action as the status it renders, so add must fall through to the
              // same full-status answer as its siblings - a bare '{id}' blanked the
              // tab's render.
              await accountPool.addAccount(credentials, alias)
            } else if (action === 'strategy') {
              // Answered BEFORE the accountId guard below, deliberately: the
              // rotation strategy is a pool-level fact that names no account, and
              // the card sends it without one. Behind that guard this branch was
              // unreachable, so the picker answered 'accountId is required.' for
              // every choice — which is exactly what the Ollama line does today.
              if (body.strategy !== 'sequential' && body.strategy !== 'round-robin' && body.strategy !== 'sticky') {
                return sendJson(response, 400, { ok: false, error: 'Unsupported rotation strategy.' })
              }
              await accountPool.setStrategy(body.strategy)
            } else if (accountId === undefined) {
              return sendJson(response, 400, { ok: false, error: 'accountId is required.' })
            } else if (action === 'set-primary') {
              await accountPool.setPrimary(accountId)
            } else if (action === 'set-alias' && typeof body.alias === 'string') {
              await accountPool.setAlias(accountId, body.alias)
            } else if (action === 'delete') {
              await accountPool.deleteAccount(accountId)
            } else if (action === 'clear-cooldown') {
              await accountPool.clearCooldown(accountId)
            } else {
              return sendJson(response, 400, { ok: false, error: 'Unsupported account action.' })
            }
          } catch (error) {
            // The pool's own message names the failure (a full pool, a missing
            // account), so it is what the card should show rather than a generic one.
            const message = error instanceof Error ? error.message : String(error)
            return sendJson(response, 400, { ok: false, error: message })
          }
          return sendJson(response, 200, { ok: true, value: await getMoarkWebStatus(options) })
        }

        if (path === 'models') {
          if (method === 'GET') {
            const settings = await modelSettings.read()
            return sendJson(response, 200, { ok: true, value: {
              models: settings.catalogModels,
              enabled: settings.enabled,
              enabledModelIds: settings.enabledModelIds,
              defaultWire: settings.defaultWire,
            } })
          }
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          const body = await readRequestJson(request).catch(() => ({}) as Record<string, unknown>)
          let touched = false
          if (typeof body.enabled === 'boolean') {
            await modelSettings.update({ enabled: body.enabled })
            touched = true
          }
          // Null is "no filter": every catalogued model, including ones a later
          // sync adds. An array is an explicit selection - and an empty one switches
          // every model off, which an empty-means-all shape could not say at all.
          if (Array.isArray(body.enabledModelIds) || body.enabledModelIds === null) {
            await modelSettings.update({
              enabledModelIds: Array.isArray(body.enabledModelIds)
                ? body.enabledModelIds.filter((id): id is string => typeof id === 'string')
                : null,
            })
            touched = true
          }
          if (body.defaultWire !== undefined) {
            if (!isMoarkWire(body.defaultWire)) {
              return sendJson(response, 400, { ok: false, error: 'Unsupported protocol surface.' })
            }
            await modelSettings.update({ defaultWire: body.defaultWire })
            touched = true
          }
          // The model picker learns the offer changed only through this event;
          // without it an unchecked model stays selectable until another line
          // happens to emit.
          if (touched) ctx.emit?.('llm/adapters-updated')
          return sendJson(response, 200, { ok: true, value: await modelSettings.read() })
        }

        if (path === 'catalog/refresh') {
          if (method !== 'POST') return sendMethodNotAllowed(response)
          if (!isSameOriginMutation(request)) {
            return sendJson(response, 403, { ok: false, error: 'Cross-origin request rejected.' })
          }
          // Sync needs a token; with none there is nothing to authenticate the call
          // and the card is told so rather than receiving a silent empty list.
          let credentials: MoarkCredentials | null = null
          let poolBusy = false
          try {
            const effective = await accountPool.getEffectiveCredential(undefined, fetchFn)
            credentials = effective.credentials
          } catch {
            // Two different refusals share this catch and must not be reported as
            // one. 'No token at all' means the card must ask for a token; 'every
            // token is cooling down' means the pool is busy and waiting is the only
            // move, and telling that user to add a token would send them for a token
            // that changes nothing.
            poolBusy = await accountPool.read().then((data) =>
              data.accounts.length > 0
              && data.accounts.every((account) => isUsable(account, Date.now()) === false),
            ).catch(() => false)
            credentials = null
          }
          if (credentials === null) {
            return sendJson(response, 400, {
              ok: false,
              error: poolBusy
                ? 'Every stored MoArk token is cooling down right now. Wait for the cooldown, then sync again.'
                : 'Add an access token before syncing models.',
            })
          }
          const result = await loadCatalog(fetchFn, credentials.apiKey)
          if (result.models.length === 0) {
            return sendJson(response, 502, { ok: false, error: catalogFailureMessage(result) })
          }
          try {
            await modelSettings.storeCatalog(result.models)
          } catch (error) {
            // The list WAS read; only the local write failed. Saying so is the
            // difference between a user retrying a sync that will fail the same way
            // and a user looking at their settings directory.
            const detail = error instanceof Error ? error.message : String(error)
            return sendJson(response, 500, {
              ok: false,
              error: `Read ${result.models.length} models from MoArk but could not save them locally: ${detail}`,
            })
          }
          return sendJson(response, 200, { ok: true, value: { models: result.models } })
        }

        return sendJson(response, 404, { ok: false, error: 'not-found' })
      } catch (error) {
        // The last line of defence. Anything that still throws - a settings file
        // that cannot be read, a pool document that cannot be parsed - is reported
        // as the reason it is, in the same envelope every other branch uses, rather
        // than as an empty body the card cannot read.
        const message = error instanceof Error ? error.message : String(error)
        return sendJson(response, 500, { ok: false, error: message })
      }
    },
  })
}
