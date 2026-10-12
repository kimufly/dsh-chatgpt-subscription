/**
 * The wire-independent request/event IR the MoArk line routes on.
 *
 * MoArk publishes three protocol surfaces that carry the same conversation in
 * different shapes (see `type MoarkWire`). Rather than three copies of the
 * adapter, each surface gets a small module that translates between this IR and
 * its own body/SSE vocabulary:
 *
 *   - `openai.ts`    — `POST https://api.moark.com/v1/chat/completions`
 *   - `responses.ts` — `POST https://moark.com/v1/responses`
 *   - `anthropic.ts` — `POST https://moark.com/anthropic/v1/messages`
 *
 * Everything downstream of a surface module — the DSH block framing in
 * `mapper.ts`, account rotation, retry classification, usage accounting — reads
 * these two types only, so a surface can be added or corrected without touching
 * the adapter.
 */

import type { StreamActivity } from '../common/idle-watchdog.ts'

/** One tool call the model asked for, with its arguments already as raw JSON text. */
export interface MoarkToolCall {
  id: string
  name: string
  /** Raw JSON the model produced for the arguments; `''` when it produced none. */
  arguments: string
}

/** One message on the wire, in the IR's own neutral shape. */
export interface MoarkMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /**
   * Image parts this turn carries, as bare base64 or data URLs.
   *
   * Each surface renders these its own way (OpenAI `image_url`, Anthropic a
   * base64 `source` block); resolving the attachment into bytes is the
   * adapter's job, done once, before the surface is chosen.
   */
  images?: string[]
  /** Tool call id a `tool` result answers. */
  toolCallId?: string
  /** Assistant tool calls that produced this turn. */
  toolCalls?: MoarkToolCall[]
}

/** One tool definition offered to the model. */
export interface MoarkTool {
  name: string
  description?: string
  parameters: unknown
}

/** A single request, independent of which surface will carry it. */
export interface MoarkRequest {
  model: string
  messages: MoarkMessage[]
  tools?: MoarkTool[]
  maxOutputTokens?: number
  temperature?: number
  /**
   * Reasoning effort the caller asked for, in DSH's vocabulary.
   *
   * Left unnormalized on purpose: each surface names its thinking control
   * differently (or has none at all), and a value this line does not know how to
   * express for a given surface must be dropped rather than invented.
   */
  reasoningEffort?: unknown
  signal?: AbortSignal
}

/**
 * Token accounting one completed turn reports.
 *
 * These are the counts MoArk's own responses carry (`usage.prompt_tokens` /
 * `usage.completion_tokens` on the OpenAI surface, `message_start.message.usage`
 * and `message_delta.usage` on Anthropic, `response.completed.response.usage` on
 * Responses), so they measure what this token has actually spent rather than
 * anything inferred from the text.
 *
 * They are NOT a quota. MoArk documents no balance, quota or reset endpoint,
 * and the plausible paths 404 (see `docs/moark-line-plan.md` §3.4). So nothing
 * here can say how much of a resource pack is left — only what has been used.
 */
export interface MoarkUsage {
  inputTokens: number
  outputTokens: number
}

/** One normalized step of a streamed turn. */
export type MoarkStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: MoarkToolCall }
  | { type: 'done'; finishReason?: string }
  | { type: 'usage'; usage: MoarkUsage }
  | { type: 'error'; message: string }

/** What one surface's chat call hands back to the adapter. */
export interface MoarkCallResult {
  events: AsyncGenerator<MoarkStreamEvent>
  /** Resolves the HTTP status once the response headers arrive. */
  status: Promise<number>
}

/** Everything a surface module needs to start a call. */
export interface MoarkSurfaceCall {
  fetchFn: typeof fetch
  /** The access token, already selected from the pool. Host-only; never logged. */
  apiKey: string
  request: MoarkRequest
  activity?: StreamActivity | undefined
}
