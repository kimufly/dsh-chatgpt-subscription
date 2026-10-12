import { outputReservation } from '../common/output-reservation.ts'
import {
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  type GenerateOptions as HarnessGenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  normalizeGenerateOptions,
  type GenerateOptions,
  type Message,
  type ToolResultBlock,
} from '../common/llm-compat.ts'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  FALLBACK_MODELS,
  KEYS_URL,
  POOL_COOLDOWN_MS,
  PROVIDER_ID,
  PROVIDER_NAME,
  contextWindowFor,
  isMoarkChatModel,
  moarkModelSupportsImage,
  reasoningEffortForCall,
  wireForModel,
  type MoarkCatalogModel,
} from './types.ts'
import { FileCredentialStore, FileModelSettingsStore, type MoarkCredentials } from './token-store.ts'
import { MoarkAccountPool } from './account-pool.ts'
import { loadCatalog, type MoarkCatalogResult } from './catalog.ts'
import { startCall as startOpenAi } from './openai.ts'
import { startCall as startResponses } from './responses.ts'
import { startCall as startAnthropic } from './anthropic.ts'
import { applyEvent, closeStream, createStreamState } from './mapper.ts'
import type { MoarkRequest, MoarkStreamEvent, MoarkSurfaceCall, MoarkTool } from './wire.ts'
import type { MoarkWire } from '../../shared/moark-contracts.ts'
import { isMoarkWire } from '../../shared/moark-contracts.ts'
import {
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
  wrapStreamWithWatchdog,
  type StreamActivity,
} from '../common/idle-watchdog.ts'
import { retryAfterMs } from '../wire-auth.ts'

/**
 * Retry policy for the `moark` route.
 *
 * A 5xx from a shared inference service says nothing about this token, so it is
 * classified as `SERVER` and given the same bounded backoff the other lines use.
 * Deliberately outside the set: `INVALID_CREDENTIAL` (a rejected token fails
 * identically every time, and the pool rotates past it instead) and `ABORTED`.
 */
const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.moark.retry')

export interface MoarkAdapterOptions {
  fetchFn?: typeof fetch
  /** Test seam; production reads `/v1/models` with the active account's token. */
  loadCatalog?: (fetchFn: typeof fetch, credentials: MoarkCredentials) => Promise<MoarkCatalogResult>
  /**
   * Attachment store used to read image bytes for the request.
   *
   * DSH delivers an image as a durable reference, not as bytes, so a route that
   * declares image input has to resolve those references before building the
   * body. Without it the image is dropped and the turn silently becomes
   * text-only while the model picker still advertises image support.
   */
  attachments?: Pick<AttachmentStore, 'readImage'>
}

export class MoarkAdapter extends LlmAdapter {
  /**
   * Rotation pool, or null for the single stored token.
   *
   * Only the plugin entry installs it, because the entry owns the storage; an
   * adapter built without one must keep reading the one credential file rather
   * than minting pool state that would outlive the process.
   */
  private readonly accountPool: MoarkAccountPool | null

  constructor(
    private readonly store = new FileCredentialStore(),
    private readonly modelSettings = new FileModelSettingsStore(),
    private readonly options: MoarkAdapterOptions = {},
    accountPool?: MoarkAccountPool,
  ) {
    super()
    this.accountPool = accountPool ?? null
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  providerRetryPolicy(): ResolvedRetryPolicy {
    return RETRY_POLICY
  }

  imageRequestPricing(): undefined {
    return undefined
  }

  private settings() {
    return this.modelSettings.read()
  }

  /**
   * Catalogue for the picker: the live `/v1/models` listing when a token can
   * reach it, the cached list otherwise, narrowed by the user's selection.
   *
   * MoArk's model set moves quickly - the live list already carries 208 entries
   * across a dozen families - so a stale local table would be the wrong default.
   * There is no shipped fallback list at all: every name in a hard-coded table
   * would be a guess about what a resource pack entitles its owner to, and a
   * guess that reaches the picker is a model a user can select and then fail on.
   * So the list starts empty and the card says so, with sync beside it.
   */
  private async catalog(): Promise<MoarkCatalogModel[]> {
    const load = this.options.loadCatalog ?? (async (fetchFn, credentials) =>
      loadCatalog(fetchFn, credentials.apiKey))
    const fetchFn = this.options.fetchFn ?? fetch
    const credentials = await this.anyCredentials()
    if (credentials !== null) {
      // The catalogue read reports failure as a result rather than throwing, so
      // the `.catch` here only covers a test seam that throws; either way an
      // unusable read falls through to the cache instead of failing the picker.
      const result = await load(fetchFn, credentials).catch(() => ({ models: [] as MoarkCatalogModel[] }))
      if (result.models.length > 0) {
        // Persist the sync so a later offline start still sees the last good list.
        await this.modelSettings.storeCatalog(result.models).catch(() => undefined)
        return result.models
      }
    }
    const cached = this.modelSettings.status().catalogModels
    if (cached.length > 0) return cached
    return [...FALLBACK_MODELS]
  }

  /** Any usable token, for the catalogue call; the pool decides real routing later. */
  private async anyCredentials(): Promise<MoarkCredentials | null> {
    if (this.accountPool !== null) {
      const effective = await this.accountPool.getEffectiveCredential(new Set(), this.options.fetchFn ?? fetch)
        .catch(() => null)
      return effective?.credentials ?? null
    }
    return this.store.read().catch(() => null)
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = await this.settings()
    if (settings.enabled === false) return []
    const catalog = await this.catalog()
    // Null means "whatever the catalogue returned" — no filter, so a model the
    // service adds later is not hidden by a selection made before it existed.
    // An array is an explicit selection, and an empty one switches every model
    // off without deleting a token.
    const enabled = settings.enabledModelIds === null ? null : new Set(settings.enabledModelIds)
    const available = enabled === null
      ? catalog
      : catalog.filter((model) => enabled.has(model.id))
    return available.map((model) => ({
      provider: prov,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: moarkModelSupportsImage(model.id) ? ['text', 'image'] : ['text'],
    }))
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('MoArk model resolution aborted', 'ABORTED')
    const catalog = await this.catalog()
    const entry = catalog.find((model) => model.id === modelId)
    return {
      provider,
      id: modelId,
      name: entry?.name ?? modelId,
      inputModalities: moarkModelSupportsImage(modelId) ? ['text', 'image'] : ['text'],
      context: { contextWindow: contextWindowFor(entry) },
      // MoArk publishes no per-model output ceiling, so this is a request-level
      // default rather than a claim about the model.
      ...outputReservation(contextWindowFor(entry), DEFAULT_MAX_OUTPUT_TOKENS),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options: HarnessGenerateOptions): AsyncIterable<StreamChunk> {
    yield* wrapStreamWithWatchdog(
      (watchdogSignal, activity) => this.requestStream(options, watchdogSignal, activity),
      options.signal,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      PROVIDER_NAME,
    )
  }

  /** The surface a request takes: the row's declaration, else the user's choice. */
  private async wireFor(model: string): Promise<MoarkWire> {
    const settings = await this.settings().catch(() => null)
    const declared = settings?.catalogModels.find((entry) => entry.id === model)?.wire
    const preferred = settings?.defaultWire
    return wireForModel(
      model,
      isMoarkWire(declared) ? declared : undefined,
      isMoarkWire(preferred) ? preferred : undefined,
    )
  }

  private async *requestStream(rawOptions: HarnessGenerateOptions, signal: AbortSignal, activity?: StreamActivity): AsyncGenerator<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch
    const options = normalizeGenerateOptions(rawOptions)
    const wire = await this.wireFor(options.model)
    const request = await toMoarkRequest(options, this.options.attachments, signal)

    // Account rotation. The payload is key-independent, so it is built once and
    // replayed unchanged while another token can still serve it: a rate-limited
    // or rejected token ends its part of the turn, not the turn.
    const pool = this.accountPool
    const tried = new Set<string>()
    let lastStatus: number | undefined
    let lastDetail = ''
    let accountId: string | undefined
    /**
     * Set the moment ANY chunk reaches the caller, and never cleared.
     *
     * Deliberately broader than "some text arrived": a block start or a tool call
     * the caller has already seen is exactly as visible as the text, so the
     * conservative reading is the one that cannot be wrong. It also survives the
     * pool rotation below, because output a token produced before failing is
     * still output.
     */
    let outputStarted = false
    /**
     * The code a transient in-band failure becomes, or null for this attempt.
     *
     * Assigned per failure rather than accumulated, so a later attempt that failed
     * for a reason of its own is never judged by an earlier one's wording.
     */
    let lastInBandCode: InBandTransientCode | null = null

    for (;;) {
      let credentials: MoarkCredentials
      if (pool === null) {
        const stored = await this.store.read()
        if (stored === null) {
          throw new LlmError(
            `No ${PROVIDER_NAME} access token configured. Add one from Settings > ${PROVIDER_NAME} (create a token at ${KEYS_URL}).`,
            'MISSING_CREDENTIAL',
          )
        }
        credentials = stored
      } else {
        const effective = await pool.getEffectiveCredential(tried, fetchFn)
        accountId = effective.account.id
        tried.add(accountId)
        credentials = effective.credentials
      }

      const call = startSurface(wire, {
        fetchFn,
        apiKey: credentials.apiKey,
        request: { ...request, signal },
        activity,
      })
      const state = createStreamState()
      let opened = false
      let openedStatus: number | undefined
      void call.status.then((value) => {
        opened = true
        openedStatus = value
      })
      void opened

      // Collected here and recorded only once the turn completes, so a stream that
      // dies part-way does not leave a half-turn counted against the token.
      let spent: { inputTokens: number; outputTokens: number } | null = null

      let failed = false
      for await (const event of call.events) {
        if (event.type === 'error') {
          lastStatus = openedStatus
          lastDetail = event.message
          // A failure the service put INSIDE a successful response is the one case
          // the status rule below reads as the caller's fault, because the response
          // really was a 200. Its wording is re-read here, where the turn is still
          // able to start over - and only here, because this is the only layer that
          // knows whether anything has reached the caller.
          const inBand = openedStatus !== undefined && openedStatus >= 200 && openedStatus < 300
          lastInBandCode = outputStarted || !inBand ? null : inBandTransientCode(event.message)
          failed = true
          break
        }
        if (event.type === 'usage') {
          spent = event.usage
          continue
        }
        if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool_call') {
          for (const chunk of applyEvent(state, event)) {
            outputStarted = true
            yield chunk
          }
          continue
        }
      }
      // A completed turn, including one that legitimately ended on a tool call.
      if (!failed) {
        // Close whatever the stream left open before the turn ends, so a model cut
        // off mid-sentence still yields the text that did arrive.
        for (const chunk of closeStream(state)) {
          outputStarted = true
          yield chunk
        }
        // Counted against the token that actually served the turn, after it
        // completed, and best-effort: a lost count must never fail a reply.
        if (pool !== null && accountId !== undefined && spent !== null) {
          await pool.recordUsage(accountId, spent.inputTokens, spent.outputTokens)
        }
        return
      }

      if (pool === null || accountId === undefined) break
      // Only a status that names this token is a verdict about this token.
      // Anything else is about the request and the same token would fail again.
      if (lastStatus === 401 || lastStatus === 403) {
        await pool.markAuthFailed(
          accountId,
          `${PROVIDER_NAME} rejected the access token (${lastStatus}).`,
          'invalid',
        ).catch(() => undefined)
        if (await pool.hasAnotherAvailableAccount(tried)) continue
        break
      }
      if (lastStatus === 429) {
        await pool.markCooldown(accountId, POOL_COOLDOWN_MS, `${PROVIDER_NAME} 429`).catch(() => undefined)
        if (await pool.hasAnotherAvailableAccount(tried)) continue
        break
      }
      break
    }

    const status = lastStatus
    if (status === 401 || status === 403) {
      throw new LlmError(
        `${PROVIDER_NAME} rejected the access token (${status}). Replace it from Settings > ${PROVIDER_NAME}.${lastDetail ? ` ${lastDetail}` : ''}`,
        'INVALID_CREDENTIAL',
        { status },
      )
    }
    if (status === 429) {
      throw new LlmError(
        `${PROVIDER_NAME} rate limit or resource pack exhausted (429). Add another token, or wait for the cooldown shown in Settings > ${PROVIDER_NAME}.${lastDetail ? ` ${lastDetail}` : ''}`,
        'RATE_LIMIT',
        { status: 429 },
      )
    }
    if (lastStatus === 402) {
      // Payment required is the one status that means something specific on a
      // prepaid platform: the resource pack behind this token is empty. It is NOT
      // a credential failure (the token authenticated fine) and NOT a rate limit
      // (waiting changes nothing), so it is reported as its own state rather than
      // folded into either.
      throw new LlmError(
        `${PROVIDER_NAME} reports no remaining balance for this token (402). Buy or renew a resource pack, or switch to another token in Settings > ${PROVIDER_NAME}.${lastDetail ? ` ${lastDetail}` : ''}`,
        'QUOTA_EXCEEDED',
        { status: 402 },
      )
    }
    // A transient failure the service reported inside its own 200 would end the
    // turn on the one try that matters, because the status rule reads a 200 as a
    // caller's mistake. Only the code changes: the message stays this adapter's own
    // and still names what MoArk said, and no `status` is attached, because the
    // response really was a 200.
    throw new LlmError(
      `${PROVIDER_NAME} request failed${status === undefined ? '' : ` (${status})`}.${lastDetail}`,
      lastInBandCode ?? (status !== undefined && status >= 500 ? 'SERVER' : 'INVALID_REQUEST'),
      status === undefined ? {} : { status },
    )
  }
}

/** Dispatch one request to the surface that carries it. */
function startSurface(wire: MoarkWire, call: MoarkSurfaceCall): ReturnType<typeof startOpenAi> {
  if (wire === 'responses') return startResponses(call)
  if (wire === 'anthropic') return startAnthropic(call)
  return startOpenAi(call)
}

/** The only two verdicts an in-band MoArk failure can be retyped as. */
type InBandTransientCode = 'RATE_LIMIT' | 'SERVER'

/**
 * The DSH code an in-band MoArk failure becomes, or null when the message names
 * nothing transient.
 *
 * MoArk's surfaces report a failure inside a 200 in different ways - an OpenAI
 * `{"error": {"message": ...}}` envelope, an Anthropic `event: error`, a
 * Responses `response.failed` - and after normalization all that is left is the
 * wording. So this is a message heuristic, and it is deliberately narrow: the
 * cost of guessing is paid by the user in backoff, and a refusal whose wording
 * the list below does not name is usually the service objecting to the request,
 * which a retry repeats verbatim. Falling back to an invented status would be
 * worse on both counts.
 */
function inBandTransientCode(message: string): InBandTransientCode | null {
  const text = message.toLowerCase()
  if (IN_BAND_RATE_LIMIT.some((phrase) => text.includes(phrase))) return 'RATE_LIMIT'
  if (IN_BAND_SERVER.some((phrase) => text.includes(phrase))) return 'SERVER'
  return null
}

/** Throttling wording, read first because it is the narrower of the two verdicts. */
const IN_BAND_RATE_LIMIT: readonly string[] = [
  'rate limit',
  'rate-limit',
  'rate_limit',
  'too many requests',
  'quota',
  'balance',
  'insufficient',
]

/** Server-side conditions, in no particular order. */
const IN_BAND_SERVER: readonly string[] = [
  'overload',
  'server busy',
  'service unavailable',
  'internal server error',
  'temporarily unavailable',
  'try again later',
  'upstream',
]

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function attachmentLabel(block: Record<string, unknown>): string | undefined {
  const attachment = isRecord(block.attachment) ? block.attachment : undefined
  return asString(attachment?.name) || asString(attachment?.attachmentId)
}

function unavailableImageText(block: Record<string, unknown>): string {
  const label = attachmentLabel(block)
  const subject = label ? `${label} could not be read` : 'the image could not be read'
  return `[image unavailable: ${subject}; ask the user to attach it again if the image is needed]`
}

function abortException(signal?: AbortSignal): Error {
  if (signal?.reason !== undefined) {
    return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
  }
  return new DOMException('The operation was aborted', 'AbortError')
}

function unsupportedImageText(model: string, block: Record<string, unknown>): string {
  const label = attachmentLabel(block)
  const subject = label ? `${label}: ` : ''
  return `[image unsupported: ${subject}model ${model} is not known to declare image support on ${PROVIDER_NAME}; remove the attachment or switch to a vision model]`
}

function combineTextParts(parts: string[]): string {
  let result = ''
  for (const part of parts) {
    if (!part) continue
    if (!result) {
      result = part
    } else if (part.startsWith('[image ') || result.endsWith('\n')) {
      result = result.trimEnd() + '\n\n' + part
    } else {
      result += part
    }
  }
  return result
}

interface ProcessedContent {
  text: string
  images?: string[]
}

async function processMessageContent(
  content: unknown,
  model: string,
  attachments?: Pick<AttachmentStore, 'readImage'>,
  signal?: AbortSignal,
): Promise<ProcessedContent> {
  if (signal?.aborted) throw abortException(signal)
  if (typeof content === 'string') return { text: content }
  if (!Array.isArray(content)) return { text: '' }

  const textParts: string[] = []
  const images: string[] = []

  for (const part of content) {
    if (typeof part === 'string') {
      textParts.push(part)
      continue
    }
    if (!isRecord(part)) continue

    if (part.type === 'text') {
      if (typeof part.text === 'string' && part.text !== '') textParts.push(part.text)
      continue
    }

    if (part.type === 'image') {
      // Claiming image input for a model that cannot take one is worse than
      // claiming too little: the screenshot would vanish and the model would
      // answer as if it had never been sent. So an unrecognized family is told
      // so in the conversation instead of silently dropped.
      if (!moarkModelSupportsImage(model)) {
        textParts.push(unsupportedImageText(model, part))
        continue
      }

      const reference = isImageRef(part.attachment)
        ? part.attachment
        : isImageRef(part.source) ? part.source : null

      if (reference !== null) {
        if (!attachments) {
          textParts.push(unavailableImageText(part))
          continue
        }
        try {
          if (signal?.aborted) throw abortException(signal)
          const loaded = await attachments.readImage(reference, signal)
          if (signal?.aborted) throw abortException(signal)
          if (loaded === null) {
            textParts.push(unavailableImageText(part))
          } else {
            images.push(encodeImage(loaded.data, loaded.ref.mediaType))
          }
        } catch (error) {
          if (isAbort(error, signal)) throw error
          textParts.push(unavailableImageText(part))
        }
        continue
      }

      const inline = part.source
      if (isRecord(inline)) {
        const data = inline.data
        if (typeof data === 'string' && data !== '') {
          images.push(encodeImage(data, asMediaType(inline.mediaType)))
          continue
        }
      }
      if (typeof part.image === 'string' && part.image !== '') {
        images.push(part.image)
        continue
      }
      textParts.push(unavailableImageText(part))
      continue
    }
  }

  const text = combineTextParts(textParts)
  return { text, ...(images.length > 0 ? { images } : {}) }
}

/**
 * Project DSH's request shape onto the line's neutral IR.
 *
 * The IR is surface-independent by construction, so this runs once per turn and
 * the chosen surface module renders it into its own body. Consumes the canonical
 * Message vocabulary produced by `normalizeGenerateOptions`.
 */
export async function toMoarkRequest(
  options: GenerateOptions,
  attachments?: Pick<AttachmentStore, 'readImage'>,
  signal?: AbortSignal,
): Promise<Omit<MoarkRequest, 'signal'>> {
  if (signal?.aborted) throw abortException(signal)
  const messages: MoarkRequest['messages'] = []
  const trimmedSystem = typeof options.system === 'string' && options.system.trim() !== ''
    ? options.system.trim()
    : undefined

  // A one-shot caller may pass its system prompt outside the history.
  if (trimmedSystem !== undefined) {
    messages.push({ role: 'system', content: trimmedSystem })
  }

  for (let index = 0; index < options.messages.length; index++) {
    const message = options.messages[index] as Message

    // Deduplicate only a leading message whose text duplicates options.system;
    // non-leading repeated instructions in conversation context are preserved.
    if (index === 0 && trimmedSystem !== undefined && (message.role === 'system' || message.role === 'developer')) {
      const leadingText = textOf(message.content).trim()
      if (leadingText === trimmedSystem) continue
    }

    // Canonical vocabulary: verify tool provenance or content blocks before the
    // role: 'tool' conversion.
    const isToolResult = message.source?.kind === 'tool' || (
      Array.isArray(message.content) &&
      message.content.some((b) => (b as { type?: string }).type === 'tool-result')
    )
    if (isToolResult && Array.isArray(message.content)) {
      const toolResultBlocks = message.content.filter(
        (b): b is ToolResultBlock => (b as { type?: string }).type === 'tool-result'
      )
      if (toolResultBlocks.length > 0) {
        for (const block of toolResultBlocks) {
          const toolCallId = String(
            block.toolCallId ??
            (isRecord(message.source) ? message.source.callId : '') ??
            ''
          )
          const processed = await processMessageContent(block.content, options.model, attachments, signal)
          messages.push({
            role: 'tool',
            content: processed.text,
            ...(toolCallId !== '' ? { toolCallId } : {}),
            ...(processed.images ? { images: processed.images } : {}),
          })
        }
        continue
      }
    }

    const toolCalls = assistantToolCalls(message.content)
    if (toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: textOf(message.content), toolCalls })
      continue
    }
    if (message.role === 'assistant') {
      messages.push({ role: 'assistant', content: textOf(message.content) })
      continue
    }

    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content).trim()
      if (text !== '') messages.push({ role: 'system', content: text })
      continue
    }

    const processed = await processMessageContent(message.content, options.model, attachments, signal)
    messages.push({
      role: 'user',
      content: processed.text,
      ...(processed.images ? { images: processed.images } : {}),
    })
  }

  const request: Omit<MoarkRequest, 'signal'> = { model: options.model, messages }
  if (options.maxTokens !== undefined) request.maxOutputTokens = options.maxTokens
  if (options.temperature !== undefined) request.temperature = options.temperature
  // The reasoning effort is passed through unnormalized: each surface names its
  // thinking control differently and some have none, so the surface module is the
  // only layer that can decide whether a given value is expressible at all. The
  // one decision made here is turning thinking OFF for a call whose cap is too
  // small to hold both a trace and an answer - see
  // `SMALL_CALL_THINKING_FLOOR_TOKENS` for the measurements behind it.
  const effort = reasoningEffortForCall(options.model, options.reasoningEffort, options.maxTokens)
  if (effort !== undefined) request.reasoningEffort = effort

  const tools = options.tools
  if (Array.isArray(tools) && tools.length > 0) {
    request.tools = tools.map((tool): MoarkTool => ({
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    }))
  }
  return request
}

/** Tool calls an assistant turn carries, read from its content blocks. */
function assistantToolCalls(content: unknown): { id: string; name: string; arguments: string }[] {
  if (!Array.isArray(content)) return []
  const calls: { id: string; name: string; arguments: string }[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const fields = block as Record<string, unknown>
    if (fields.type !== 'tool-call') continue
    const id = fields.id
    const name = fields.name
    if (typeof id !== 'string' || typeof name !== 'string') continue
    calls.push({
      id,
      name,
      arguments: typeof fields.arguments === 'string' ? fields.arguments : JSON.stringify(fields.arguments ?? {}),
    })
  }
  return calls
}

function isImageRef(value: unknown): value is ImageAttachmentRef {
  return typeof value === 'object' && value !== null && typeof (value as { attachmentId?: unknown }).attachmentId === 'string'
}

function asMediaType(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : 'image/png'
}

/**
 * The base64 payload a surface wants, with or without a data URL prefix.
 *
 * Each surface renders it differently (OpenAI an `image_url`, Anthropic a base64
 * `source` block), and both of those accept a `data:` URL, so one encoding
 * serves either and avoids a per-surface guess about what a model accepts.
 */
function encodeImage(data: Uint8Array | string, mediaType: string): string {
  const base64 = typeof data === 'string' ? data : Buffer.from(data).toString('base64')
  return base64.startsWith('data:') ? base64 : `data:${mediaType};base64,${base64}`
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (typeof part === 'object' && part !== null) {
          const text = (part as Record<string, unknown>).text
          if (typeof text === 'string') return text
        }
        return ''
      })
      .join('')
  }
  return ''
}

/** Re-exported so the routes module can name the failure the catalogue read hit. */
export type { MoarkStreamEvent }
