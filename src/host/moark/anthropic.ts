/**
 * The Anthropic Messages surface: `POST https://moark.com/anthropic/v1/messages`.
 *
 * This is what MoArk's own *Claude Code* configuration page sets
 * `ANTHROPIC_BASE_URL` to, so it is the surface a Claude-shaped caller wants.
 *
 * Two Anthropic-specific rules shape the whole module:
 *
 *  - **`system` is a top-level field, not a message.** Anthropic rejects a
 *    `system` role inside `messages`, so the leading system prompt is lifted out
 *    and any later system turn is folded into the following user turn as text.
 *  - **Tool results are user-role content blocks.** There is no `tool` role;
 *    a result is a `tool_result` block inside a user message, and an assistant's
 *    calls are `tool_use` blocks. Getting this wrong produces a 400 that names
 *    the role, not the block, which is a confusing diagnostic.
 *
 * The auth header is the line's shared Anthropic one, which sends both
 * `x-api-key` and `Authorization: Bearer` with the same value because
 * Anthropic-compatible gateways disagree about which they read, and MoArk's own
 * page only pins the Bearer half.
 */

import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_MESSAGES_PATH,
  DEFAULT_MAX_OUTPUT_TOKENS,
  moarkAnthropicHeaders,
  moarkModelSupportsReasoning,
} from './types.ts'
import { readSseData, parseSseJson, sseNumber, sseRecord, sseString, sseErrorMessage } from './sse.ts'
import type { MoarkCallResult, MoarkMessage, MoarkRequest, MoarkStreamEvent, MoarkSurfaceCall, MoarkToolCall } from './wire.ts'

/** One accumulating `tool_use` block, keyed by its content-block index. */
interface PendingToolUse {
  id: string
  name: string
  /** Raw `partial_json` fragments, concatenated in arrival order. */
  arguments: string
}

/** What the caller asked for, in Anthropic's body shape. */
export interface AnthropicBodyResult {
  system?: string
  messages: Record<string, unknown>[]
}

/**
 * Split the IR's messages into Anthropic's `system` field and `messages` array.
 *
 * Exported because it is where the two Anthropic-specific rules above live, and
 * a test can assert the split without a stream.
 */
export function buildMessages(messages: readonly MoarkMessage[]): AnthropicBodyResult {
  const systemParts: string[] = []
  const out: Record<string, unknown>[] = []
  /** Text held back from a system turn so it can lead the next user turn. */
  let pendingSystem = ''

  for (const message of messages) {
    if (message.role === 'system') {
      // The FIRST system turn is the caller's prompt and belongs in `system`.
      // A later one is conversation content, and Anthropic has no role for it, so
      // it is carried into the next user turn rather than dropped.
      if (out.length === 0 && pendingSystem === '') {
        systemParts.push(message.content)
      } else {
        pendingSystem = pendingSystem === '' ? message.content : `${pendingSystem}\n\n${message.content}`
      }
      continue
    }

    if (message.role === 'tool') {
      const block: Record<string, unknown> = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      }
      // Consecutive tool results belong in ONE user turn; two user turns in a row
      // are rejected by Anthropic, and a turn that produced several calls is
      // answered by several results.
      const last = out[out.length - 1]
      if (last !== undefined && last.role === 'user' && Array.isArray(last.content)
        && (last.content as Record<string, unknown>[]).every((part) => part.type === 'tool_result')) {
        (last.content as Record<string, unknown>[]).push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }

    if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      const content: Record<string, unknown>[] = []
      if (message.content !== '') content.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          // Anthropic wants a parsed object here, not a JSON string. A model's
          // own earlier output is trusted JSON; when it is not parseable the
          // honest value is an empty object, because forwarding the raw string
          // produces a schema error that names nothing useful.
          input: parseToolInput(call.arguments),
        })
      }
      out.push({ role: 'assistant', content })
      continue
    }

    const content = buildContent(message)
    if (pendingSystem !== '') {
      // Attach the held-back system text ahead of this turn's own content.
      if (typeof content === 'string') {
        out.push({ role: message.role, content: `${pendingSystem}\n\n${content}` })
      } else {
        content.unshift({ type: 'text', text: pendingSystem })
        out.push({ role: message.role, content })
      }
      pendingSystem = ''
      continue
    }
    out.push({ role: message.role, content })
  }

  // A trailing system turn with no turn after it would otherwise vanish.
  if (pendingSystem !== '') {
    out.push({ role: 'user', content: pendingSystem })
  }

  return {
    ...(systemParts.length === 0 ? {} : { system: systemParts.join('\n\n') }),
    messages: out,
  }
}

/** One message's content, as a plain string or a multimodal block array. */
function buildContent(message: MoarkMessage): string | Record<string, unknown>[] {
  if (message.images === undefined || message.images.length === 0) return message.content
  const content: Record<string, unknown>[] = [{ type: 'text', text: message.content }]
  for (const image of message.images) {
    const parsed = splitDataUrl(image)
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: parsed.mediaType,
        data: parsed.data,
      },
    })
  }
  return content
}

/** Split a `data:` URL into its media type and bare base64, tolerant of a bare payload. */
function splitDataUrl(image: string): { mediaType: string; data: string } {
  const match = /^data:([^;]+);base64,(.*)$/.exec(image)
  if (match !== null) return { mediaType: match[1] ?? 'image/png', data: match[2] ?? '' }
  return { mediaType: 'image/png', data: image }
}

/** Parse a tool call's argument JSON, falling back to an empty object. */
function parseToolInput(argumentsText: string): Record<string, unknown> {
  if (argumentsText === '') return {}
  try {
    const parsed = JSON.parse(argumentsText) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * Render the IR into an Anthropic Messages body.
 *
 * Exported for the same reason as the other two surfaces: the request shape is
 * what a test can assert without a live stream.
 */
export function buildRequestBody(request: MoarkRequest): Record<string, unknown> {
  const { system, messages } = buildMessages(request.messages)
  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    // `max_tokens` is REQUIRED by Anthropic; omitting it is a 400, not a
    // provider default.
    max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    stream: true,
  }
  if (system !== undefined) body.system = system
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      input_schema: tool.parameters,
    }))
  }
  // Thinking control is sent only where a family is documented to accept it, and
  // an unknown value is dropped rather than mapped: Anthropic's extended-thinking
  // field has a strict vocabulary, and a wrong value there is a 400 that loses
  // the turn.
  const budget = thinkingBudget(request.reasoningEffort)
  if (budget !== undefined && moarkModelSupportsReasoning(request.model)) {
    body.thinking = { type: 'enabled', budget_tokens: budget }
    // Anthropic rejects `temperature` alongside extended thinking.
    delete body.temperature
  }
  return body
}

/** Map DSH's effort vocabulary onto Anthropic's thinking budget, or nothing. */
function thinkingBudget(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const effort = value.toLowerCase()
  if (effort === 'none' || effort === 'off' || effort === 'false') return undefined
  if (effort === 'low') return 2_048
  if (effort === 'medium' || effort === 'auto' || effort === 'true') return 8_192
  if (effort === 'high') return 16_384
  return undefined
}

/**
 * Start one streaming Messages call.
 *
 * Eager fetch, for the same reason as the other two surfaces.
 */
export function startCall(call: MoarkSurfaceCall): MoarkCallResult {
  let resolveStatus: (status: number) => void = () => undefined
  let rejectStatus: (error: unknown) => void = () => undefined
  const status = new Promise<number>((resolve, reject) => {
    resolveStatus = resolve
    rejectStatus = reject
  })

  const opened = call.fetchFn(`${ANTHROPIC_BASE_URL}${ANTHROPIC_MESSAGES_PATH}`, {
    method: 'POST',
    headers: moarkAnthropicHeaders(call.apiKey),
    body: JSON.stringify(buildRequestBody(call.request)),
    signal: call.request.signal,
  }).then(
    (response) => {
      resolveStatus(response.status)
      return response
    },
    (error) => {
      rejectStatus(error)
      throw error
    },
  )

  const events = (async function* run(): AsyncGenerator<MoarkStreamEvent> {
    let response: Response
    try {
      response = await opened
    } catch (error) {
      yield { type: 'error', message: error instanceof Error ? error.message : String(error) }
      return
    }
    if (!response.ok) {
      const detail = await safeErrorText(response)
      yield { type: 'error', message: `MoArk messages failed (${response.status}): ${detail}` }
      return
    }
    if (response.body === null) {
      yield { type: 'error', message: 'MoArk returned no response stream.' }
      return
    }
    yield* readStream(response.body, call)
  })()

  return { events, status }
}

async function safeErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (text === '') return ''
    try {
      const message = sseErrorMessage(JSON.parse(text) as unknown)
      if (message !== undefined) return message.slice(0, 500)
    } catch {
      // Not JSON: the raw text is the whole evidence.
    }
    return text.slice(0, 500)
  } catch {
    return ''
  }
}

async function* readStream(
  body: ReadableStream<Uint8Array>,
  call: MoarkSurfaceCall,
): AsyncGenerator<MoarkStreamEvent> {
  const pending = new Map<number, PendingToolUse>()
  /**
   * Usage state the block reader carries across frames.
   *
   * Anthropic reports input tokens once, on `message_start`, and output tokens
   * later on `message_delta`. Since the adapter keeps the last usage event it
   * sees, the input count has to be remembered here or a delta that omits it
   * would report the turn as having cost zero input.
   */
  const state: AnthropicStreamState = { inputTokens: undefined }
  let sawContent = false

  for await (const payload of readSseData(body, call.activity)) {
    const event = parseSseJson(payload)
    if (event === null) continue
    for (const normalized of readEvent(event, pending, state)) {
      if (normalized.type !== 'usage' && normalized.type !== 'done') sawContent = true
      yield normalized
    }
  }

  for (const [index, tool] of pending) {
    yield { type: 'tool_call', call: finishTool(tool, index) }
  }
  if (!sawContent) {
    yield { type: 'error', message: 'MoArk returned an empty stream.' }
  }
}

/** Cross-frame usage state for one Anthropic stream. */
interface AnthropicStreamState {
  /** The last `input_tokens` seen, carried forward onto later usage events. */
  inputTokens: number | undefined
}

/** Fold one Anthropic SSE event into normalized events. */
function readEvent(
  event: Record<string, unknown>,
  pending: Map<number, PendingToolUse>,
  state: AnthropicStreamState,
): MoarkStreamEvent[] {
  const type = sseString(event.type)
  if (type === undefined) return []

  if (type === 'error') {
    const error = sseRecord(event.error)
    const message = sseString(error?.message) ?? sseString(error?.type) ?? sseErrorMessage(event) ?? 'MoArk reported an error.'
    return [{ type: 'error', message }]
  }

  if (type === 'content_block_start') {
    const index = sseNumber(event.index) ?? 0
    const block = sseRecord(event.content_block)
    if (block === null) return []
    const blockType = sseString(block.type)
    if (blockType === 'tool_use') {
      pending.set(index, {
        id: sseString(block.id) ?? `tool_${index}`,
        name: sseString(block.name) ?? '',
        arguments: '',
      })
      return []
    }
    if (blockType === 'text') {
      const text = sseString(block.text)
      return text === undefined ? [] : [{ type: 'text', text }]
    }
    if (blockType === 'thinking') {
      const text = sseString(block.thinking)
      return text === undefined ? [] : [{ type: 'thinking', text }]
    }
    return []
  }

  if (type === 'content_block_delta') {
    const index = sseNumber(event.index) ?? 0
    const delta = sseRecord(event.delta)
    if (delta === null) return []
    const deltaType = sseString(delta.type)
    if (deltaType === 'text_delta') {
      const text = sseString(delta.text)
      return text === undefined ? [] : [{ type: 'text', text }]
    }
    if (deltaType === 'thinking_delta') {
      const text = sseString(delta.thinking)
      return text === undefined ? [] : [{ type: 'thinking', text }]
    }
    if (deltaType === 'input_json_delta') {
      const tool = pending.get(index)
      if (tool === undefined) return []
      // `partial_json` is a fragment, not a document; it is never parsed here.
      tool.arguments += sseString(delta.partial_json) ?? ''
      pending.set(index, tool)
      return []
    }
    return []
  }

  if (type === 'content_block_stop') {
    const index = sseNumber(event.index) ?? 0
    const tool = pending.get(index)
    if (tool === undefined) return []
    pending.delete(index)
    return [{ type: 'tool_call', call: finishTool(tool, index) }]
  }

  if (type === 'message_delta') {
    const events: MoarkStreamEvent[] = []
    const usage = sseRecord(event.usage)
    if (usage !== null) {
      // Anthropic SPLITS usage across two events: `message_start` carries
      // `input_tokens`, and `message_delta` usually carries only
      // `output_tokens`. The adapter keeps the LAST usage it sees, so emitting
      // an absent input count as 0 here would overwrite the real one and every
      // turn would be billed as zero input. The input count is therefore carried
      // forward from `message_start` unless this event states its own.
      const inputTokens = sseNumber(usage.input_tokens) ?? state.inputTokens
      if (inputTokens !== undefined) state.inputTokens = inputTokens
      events.push({
        type: 'usage',
        usage: {
          inputTokens: inputTokens ?? 0,
          outputTokens: sseNumber(usage.output_tokens) ?? 0,
        },
      })
    }
    const delta = sseRecord(event.delta)
    const stopReason = delta === null ? undefined : sseString(delta.stop_reason)
    if (stopReason !== undefined) {
      // `tool_use` is Anthropic's name for the same terminal state the rest of
      // DSH calls `tool_calls`; normalizing it here means a consumer that reads
      // the finish reason sees one vocabulary across all three surfaces.
      events.push({ type: 'done', finishReason: stopReason === 'tool_use' ? 'tool_calls' : stopReason })
    }
    return events
  }

  if (type === 'message_start') {
    const message = sseRecord(event.message)
    const usage = message === null ? null : sseRecord(message.usage)
    if (usage === null) return []
    const inputTokens = sseNumber(usage.input_tokens)
    if (inputTokens !== undefined) state.inputTokens = inputTokens
    return [{
      type: 'usage',
      usage: {
        inputTokens: inputTokens ?? 0,
        outputTokens: sseNumber(usage.output_tokens) ?? 0,
      },
    }]
  }

  if (type === 'message_stop') {
    // A turn that ended without a `message_delta` still has to close; the
    // adapter flushes accumulated calls on this event.
    const events: MoarkStreamEvent[] = []
    for (const [index, tool] of pending) {
      events.push({ type: 'tool_call', call: finishTool(tool, index) })
    }
    pending.clear()
    events.push({ type: 'done' })
    return events
  }

  return []
}

function finishTool(tool: PendingToolUse, index: number): MoarkToolCall {
  return {
    id: tool.id === '' ? `tool_${index}` : tool.id,
    name: tool.name,
    arguments: tool.arguments,
  }
}
