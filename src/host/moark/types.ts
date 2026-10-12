/**
 * Static facts about the MoArk (模力方舟 / Gitee AI) provider API.
 *
 * MoArk is a **token + prepaid resource-pack** platform, not a subscription
 * service: a user registers at moark.com, creates an access token under
 * 工作台 → 设置 → 访问令牌, optionally buys a 全模型资源包 (or a vendor-specific
 * 算力资源包), and calls the API with `Authorization: Bearer <token>`. The token
 * does not expire and is revoked from the console, so — exactly like the Ollama
 * line and unlike every OAuth line here — there is no refresh token, nothing
 * expires, and no identity beyond the key. There is nothing to adopt from
 * another client's credential file either.
 *
 * THE THREE SURFACES
 *
 * MoArk documents three protocol faces over one model catalogue, and this line
 * speaks all three:
 *
 * - **OpenAI-compatible** — `https://api.moark.com/v1/chat/completions`. The
 *   platform's primary documented path; MoArk's own quick-start and OpenAI-client
 *   examples use it. `GET /v1/models` answers here unauthenticated.
 * - **Responses** — `https://moark.com/v1/responses`. This is the base and wire
 *   MoArk's official *Codex* configuration page prescribes
 *   (`wire_api = "responses"`, `base_url = "https://moark.com/v1"`,
 *   `experimental_bearer_token = "<token>"`).
 * - **Anthropic Messages** — `https://moark.com/anthropic/v1/messages`. This is
 *   what MoArk's official *Claude Code* configuration page sets
 *   `ANTHROPIC_BASE_URL` to (`https://moark.com/anthropic`).
 *
 * All three answer: a GET returns 405 (method not allowed) rather than 404,
 * which is how this line's contract probes confirmed each path exists.
 *
 * WHY THE SURFACE IS A SETTING RATHER THAN A PER-MODEL FACT
 *
 * The GLM line routes per model because ZCode's own catalogue states each
 * model's wire. MoArk's `/v1/models` states nothing but an id — no modalities,
 * no context window, no protocol. So there is no per-model wire to transcribe,
 * and inventing one would be a guess dressed as a fact. What the line does
 * instead is let the user pick the surface for the line (defaulting to the
 * platform's own primary OpenAI path) and remember it; a catalogue row may
 * override that later without changing the shape stored on disk.
 *
 * DOCUMENTED LIMITS OF THE CATALOGUE
 *
 * `/v1/models` lists **every** deployed model, not just chat models: embeddings
 * and rerankers, image and video generators, TTS and ASR, OCR and 3D. A chat
 * request sent to one of those fails, and a picker that offered them would be
 * offering failures. So the sync classifies and keeps chat-capable families
 * only, and the classification is conservative and name-based — see
 * `isMoarkChatModel`. Models whose family the classifier does not recognize are
 * kept rather than dropped: an unknown id is far more likely to be a new chat
 * model than a new embedding model, and hiding it would break the line for a
 * model the user came to use.
 */

import type { MoarkWire } from '../../shared/moark-contracts.ts'

/** Provider route id, also the DSH adapter route name. */
export const PROVIDER_ID = 'moark'

/** Display name on the settings card, the hub card and error messages. */
export const PROVIDER_NAME = 'MoArk（模力方舟）'

/** Where a user creates the access token this line stores. */
export const KEYS_URL = 'https://moark.com/dashboard/tokens'

/** OpenAI-compatible surface, per the platform quick-start. */
export const OPENAI_BASE_URL = 'https://api.moark.com/v1'
export const OPENAI_CHAT_PATH = '/chat/completions'

/**
 * Model listing path, relative to a surface base.
 *
 * All three hosts answer `GET /v1/models` with the same 208-entry list, so the
 * sync reads whichever base the line is configured for and gets the same truth.
 */
export const MODELS_PATH = '/models'

/** Responses surface, per MoArk's official Codex configuration page. */
export const RESPONSES_BASE_URL = 'https://moark.com/v1'
export const RESPONSES_PATH = '/responses'

/** Anthropic Messages surface, per MoArk's official Claude Code configuration page. */
export const ANTHROPIC_BASE_URL = 'https://moark.com/anthropic'
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages'

/**
 * The API version header the Anthropic surface documents.
 *
 * Identical to the string the GLM and Claude lines send, because it is
 * Anthropic's own protocol version, not the vendor's.
 */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Default context window for a model whose catalogue row states none.
 *
 * MoArk's `/v1/models` states no context window for any model, and there is no
 * second endpoint that does. MoArk's own Codex page configures
 * `model_context_window = 1000000` for `DeepSeek-V4-Pro`, so the platform does
 * serve very large windows; but that is one model's advertised setting, not a
 * floor the rest share. This value is deliberately conservative and modest
 * rather than flattering: too small a window costs a compaction the user did not
 * need, while too large a one overflows upstream and loses the turn.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * Output cap used when neither the caller nor the catalogue states one.
 *
 * MoArk publishes no per-model output ceiling, so this is a request-level
 * ceiling rather than a claim about what any model can do. It matches the value
 * DSH's other non-subscription line uses for the same reason.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192

/** How long a catalogue sync may take before the cached list is used instead. */
export const CATALOG_TIMEOUT_MS = 15_000

/**
 * Cooldown one account takes when MoArk refuses it without stating a delay.
 *
 * A 429 here is a real rate limit or an exhausted resource pack, not a blip, so
 * the account is parked long enough that the next request goes to a different
 * one. A prepaid pack does not refill on a short timer, which is why this is
 * minutes rather than seconds.
 */
export const POOL_COOLDOWN_MS = 15 * 60_000

/** One model as MoArk's `/v1/models` reports it. */
export interface MoarkCatalogModel {
  id: string
  name?: string
  contextWindow?: number
  /** The surface this row was declared to speak; absent means the line default. */
  wire?: MoarkWire
  /** Unix milliseconds this entry was read from the service. */
  fetchedAt?: number
}

/**
 * NO fallback model names, for the same reason the Ollama line has none.
 *
 * Every name in a hard-coded table here would be a guess about what some
 * resource pack entitles its owner to, and a guess that reaches the picker is a
 * model a user can select and then fail on. MoArk's truth is `/v1/models`, and
 * there is nothing honest to stand in for it before the first sync.
 */
export const FALLBACK_MODELS: readonly MoarkCatalogModel[] = Object.freeze([])

/** The surface a request takes when neither the row nor the user names one. */
export const DEFAULT_WIRE: MoarkWire = 'openai'

/** Resolve the surface for a model, given the row and the user's line-level choice. */
export function wireForModel(model: string, declared: MoarkWire | undefined, preferred: MoarkWire | undefined): MoarkWire {
  return declared ?? preferred ?? DEFAULT_WIRE
}

/** Context window for a model, falling back to the conservative constant. */
export function contextWindowFor(model: MoarkCatalogModel | undefined): number {
  const stated = model?.contextWindow
  return typeof stated === 'number' && Number.isFinite(stated) && stated > 0
    ? Math.floor(stated)
    : DEFAULT_CONTEXT_WINDOW
}

/** Bearer headers the OpenAI and Responses surfaces both require. */
export function moarkBearerHeaders(apiKey: string, accept: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept,
  }
}

/**
 * Headers the Anthropic surface requires.
 *
 * The GLM line's own plan records that Anthropic-compatible gateways read
 * *both* `x-api-key` and `Authorization: Bearer`; MoArk's Claude Code page sets
 * only `ANTHROPIC_AUTH_TOKEN`, which Claude Code sends as a Bearer token. This
 * line sends both with the same value so either reading of the contract works —
 * the same belt-and-braces the GLM line uses, and neither header is a secret
 * beyond the token already in hand.
 */
export function moarkAnthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    authorization: `Bearer ${apiKey}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
    accept: 'text/event-stream',
  }
}

/**
 * Families whose models cannot answer a chat completion.
 *
 * Each entry is a substring test against the lowercased model id. This is a
 * DENY list, not an allow list, and that is the deliberate choice: a deny list
 * fails open, so a model the classifier has never heard of is offered and can be
 * tried, while a known non-chat family is kept out of a picker that would only
 * produce failures. An allow list would fail closed and hide new chat models the
 * day they ship.
 *
 * The families were read off the live catalogue's own 208 ids (see
 * `docs/moark-line-plan.md` §3.3), which is why the embeddings, rerankers,
 * image/video generators, speech models, OCR models and 3D generators each
 * appear by their real names.
 */
const NON_CHAT_FAMILY_MARKERS: readonly string[] = [
  // Embeddings and rerankers.
  'embedding', 'embed', 'reranker', 'rerank', 'bge-',
  // Image generation (as opposed to vision input, which is a chat capability).
  'image', 'flux', 'kolors', 'diffusion', 'sd3', 'sdxl',
  // Video generation.
  'video', 'wan2', 'wan3', 'vace', 'hunyuanvideo', 'cogvideo', 'i2v', 't2v',
  // Speech synthesis and recognition.
  'tts', 'asr', 'voxcpm', 'cosyvoice', 'whisper', 'teleasr', 'teletts', 'speech', 'voice',
  // Document extraction and OCR.
  'ocr', 'mineru', 'uvdoc', 'paddleocr',
  // 3D generation.
  '3d', 'hi3dgen', 'hunyuan3d', 'triposg',
]

/**
 * Whether a catalogue id can plausibly serve a chat completion.
 *
 * Conservative in the direction that matters: unknown families are kept. The
 * deny list above is what removes the model families whose very purpose is not
 * conversation, and each of those would otherwise sit in the picker waiting to
 * fail on first use.
 */
export function isMoarkChatModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return !NON_CHAT_FAMILY_MARKERS.some((marker) => id.includes(marker))
}

/**
 * Vision-capable families, as a conservative allow list.
 *
 * MoArk's catalogue states no modalities, so this cannot be a fact read from the
 * service; it is a claim about a family's published identity. It is deliberately
 * narrow and deliberately separate from the chat filter: **claiming too much is
 * worse than claiming too little here**, because a model advertising image input
 * that cannot accept one silently drops the user's screenshot and answers as if
 * it had never been sent, while a vision model that is not on the list merely
 * answers text-only.
 *
 * Only families whose multimodal variants are unambiguous by name appear. A
 * vision-capable checkpoint of a family not listed here is a gap to close with
 * evidence, not to guess at.
 */
const VISION_FAMILY_MARKERS: readonly string[] = [
  'qwen3-vl', 'qwen2.5-vl', 'qwen-vl', 'qwen3.5', 'glm-4v', 'glm-5v',
  'internvl', 'intern-vl', 'minicpm-v', 'llava', 'step-1v', 'pixtral',
]

/** Whether a model id names a family documented to accept image input. */
export function moarkModelSupportsImage(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return VISION_FAMILY_MARKERS.some((marker) => id.includes(marker))
}

/**
 * Whether a model is likely to honour a reasoning-effort setting.
 *
 * Used only to decide whether to send a thinking control at all, never to
 * *which* level: the surfaces that carry one disagree about the vocabulary, so
 * an unlisted model gets no control rather than an invented one. Sending
 * `reasoning_effort` to a model that does not know the field is at best ignored
 * and at worst a 400, and a 400 on an auxiliary option loses the whole turn.
 */
export function moarkModelSupportsReasoning(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return id.includes('deepseek-v4') || id.includes('r1') || id.includes('glm-5') || id.includes('qwen3')
}
