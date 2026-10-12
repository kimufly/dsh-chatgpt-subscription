/**
 * The Responses surface: `POST https://moark.com/v1/responses`.
 *
 * This is the surface MoArk's own *Codex* configuration page prescribes
 * (`wire_api = "responses"`, `base_url = "https://moark.com/v1"`), so it is the
 * one a Codex-shaped caller wants.
 *
 * The body is built here rather than by reusing the Codex line's
 * `buildResponsesPayload`: that builder carries the ChatGPT line's own contract -
 * its instructions handling, its stored-response switches, its image offloading
 * and its sandbox-control tool filtering - none of which MoArk documents. Sending
 * fields a provider never agreed to is how a request acquires a 400 that names
 * an option the user never chose. What IS shared is the *shape* of the request
 * and the event vocabulary, which are OpenAI's, not ChatGPT's.
 */

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  RESPONSES_BASE_URL,
  RESPONSES_PATH,
  moarkBearerHeaders,
  moarkModelSupportsImage,
  moarkModelSupportsReasoning,
} from './types.ts'
import { readSseData, parseSseJson, sseNumber, sseRecord, sseString, sseErrorMessage } from './sse.ts'
import type { MoarkCallResult, MoarkMessage, MoarkRequest, MoarkStreamEvent, MoarkSurfaceCall, MoarkToolCall } from './wire.ts'

/** One accumulating function call, keyed by the item id the stream pairs on. */
interface PendingFunctionCall {
  callId: string
  name: string
  arguments: string
}

/**
 * Render the IR into a Responses body.
 *
 * Exported for the same reason the OpenAI builder is: the request shape is the
 * part a test can assert without a live stream.
 */
export function buildRequestBody(request: MoarkRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    input: request.messages.map(toWireItem).flat(),
    stream: true,
    max_output_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  }
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.parameters,
    }))
    body.tool_choice = 'auto'
  }
  // `reasoning` is only sent to a family documented to honour it; an unknown
  // effort is dropped rather than lowered, so the answer never looks like the
  // model ignored an instruction the user gave.
  const effort = normalizeEffort(request.reasoningEffort)
  if (effort !== undefined && moarkModelSupportsReasoning(request.model)) {
    body.reasoning = { effort }
  }
  return body
}

/**
 * One IR message as Responses input item(s).
 *
 * An assistant turn that asked for tools becomes several items - the message
 * plus one `function_call` per call - because Responses models a call as a
 * top-level item rather than as a field of the message. A tool result likewise
 * becomes a `function_call_output` item, not a message with a `tool` role.
 */
function toWireItem(message: MoarkMessage): Record<string, unknown>[] {
  if (message.role === 'tool') {
    return [{
      type: 'function_call_output',
      call_id: message.toolCallId ?? '',
      output: message.content,
    }]
  }
  if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    const items: Record<string, unknown>[] = []
    if (message.content !== '') {
      items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] })
    }
    for (const call of message.toolCalls) {
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments === '' ? '{}' : call.arguments,
      })
    }
    return items
  }
  if (message.images !== undefined && message.images.length > 0) {
    // Image input is claimed only for a family that declares it; an
    // unrecognized one is not silently stripped here - the adapter already
    // refused it in the conversation text before this point.
    const content: Record<string, unknown>[] = [{ type: 'input_text', text: message.content }]
    for (const image of message.images) {
      content.push({ type: 'input_image', image_url: image })
    }
    return [{ type: 'message', role: message.role, content }]
  }
  // `system` is not a Responses role; the platform takes instructions on a
  // dedicated field, but only for the leading system prompt, which the adapter
  // has already put first. Here it is folded into the item stream as developer
  // input so an in-conversation system turn is not lost.
  if (message.role === 'system') {
    return [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: message.content }] }]
  }
  return [{
    type: 'message',
    role: message.role,
    content: [{ type: 'input_text', text: message.content }],
  }]
}

/** Reduce DSH's reasoning vocabulary to what this surface accepts. */
function normalizeEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const effort = value.toLowerCase()
  if (effort === 'none' || effort === 'off' || effort === 'false') return 'none'
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort
  if (effort === 'auto' || effort === 'true') return 'medium'
  return undefined
}

/**
 * Start one streaming Responses call.
 *
 * Eager fetch, for the same reason as the OpenAI surface: the adapter awaits
 * `status` before pulling events, so a lazy generator would deadlock failover.
 */
export function startCall(call: MoarkSurfaceCall): MoarkCallResult {
  let resolveStatus: (status: number) => void = () => undefined
  let rejectStatus: (error: unknown) => void = () => undefined
  const status = new Promise<number>((resolve, reject) => {
    resolveStatus = resolve
    rejectStatus = reject
  })

  const opened = call.fetchFn(`${RESPONSES_BASE_URL}${RESPONSES_PATH}`, {
    method: 'POST',
    headers: moarkBearerHeaders(call.apiKey, 'text/event-stream'),
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
      yield { type: 'error', message: `MoArk responses failed (${response.status}): ${detail}` }
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
  const pending = new Map<string, PendingFunctionCall>()
  /**
   * Whether any answer text already streamed as deltas.
   *
   * This is what keeps a terminal message item from doubling the answer. A
   * standard Responses stream sends `response.output_item.done` for the message
   * item AFTER the `response.output_text.delta` frames that built it, and that
   * terminal item carries the COMPLETE text - emitting it as well would show
   * every answer twice. The terminal text is therefore adopted only when no
   * delta ever arrived, which is the case a buffering gateway produces.
   */
  const state: ReadStreamState = { sawTextDelta: false }
  let sawContent = false

  for await (const payload of readSseData(body, call.activity)) {
    const event = parseSseJson(payload)
    if (event === null) continue
    for (const normalized of readEvent(event, pending, state)) {
      if (normalized.type !== 'usage' && normalized.type !== 'done') sawContent = true
      yield normalized
    }
  }

  for (const [key, tool] of pending) {
    yield { type: 'tool_call', call: finishTool(tool, key) }
  }
  if (!sawContent) {
    yield { type: 'error', message: 'MoArk returned an empty stream.' }
  }
}

/** Cross-frame state the block-level reader keeps for the whole stream. */
interface ReadStreamState {
  /** True once a text delta has been emitted, so terminal text is not doubled. */
  sawTextDelta: boolean
}

/** Fold one Responses event into normalized events. */
function readEvent(
  event: Record<string, unknown>,
  pending: Map<string, PendingFunctionCall>,
  state: ReadStreamState,
): MoarkStreamEvent[] {
  const type = sseString(event.type)
  if (type === undefined) return []

  if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
    const delta = sseString(event.delta)
    if (delta === undefined) return []
    state.sawTextDelta = true
    return [{ type: 'text', text: delta }]
  }
  if (type === 'response.output_text.done') {
    // A live MoArk stream sends this after the deltas AND carries the complete
    // text, so it must not be adopted when the deltas already delivered it — but
    // a gateway that buffered the response may send only this frame, and dropping
    // it would lose the answer entirely. Same guard, opposite fallback.
    if (state.sawTextDelta) return []
    const text = sseString(event.text)
    if (text === undefined) return []
    state.sawTextDelta = true
    return [{ type: 'text', text }]
  }
  if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    const delta = sseString(event.delta)
    return delta === undefined ? [] : [{ type: 'thinking', text: delta }]
  }

  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = sseRecord(event.item)
    if (item === null || sseString(item.type) !== 'function_call') {
      // A completed message item can carry the whole answer when a gateway
      // buffered the deltas - but a standard stream sends it AFTER the deltas, so
      // adopting it unconditionally would emit every answer twice. It is used
      // only when no delta ever streamed.
      if (type === 'response.output_item.done' && item !== null && !state.sawTextDelta) {
        const text = messageItemText(item)
        if (text !== undefined) {
          state.sawTextDelta = true
          return [{ type: 'text', text }]
        }
      }
      return []
    }
    const key = sseString(item.id) ?? sseString(event.item_id) ?? `index-${sseNumber(event.output_index) ?? pending.size}`
    const tool = pending.get(key) ?? { callId: '', name: '', arguments: '' }
    if (tool.callId === '') tool.callId = sseString(item.call_id) ?? key
    if (tool.name === '') tool.name = sseString(item.name) ?? ''
    // The terminal item carries the COMPLETE argument string, while the deltas
    // carried fragments of it. Appending here would double the arguments of every
    // call whose deltas already arrived, so the terminal value replaces them and
    // is only used when the deltas were never sent.
    const complete = sseString(item.arguments)
    if (complete !== undefined) tool.arguments = complete
    pending.set(key, tool)
    // The call is only emitted once its arguments are complete - on
    // `output_item.done`, or at end of stream. Emitting a call with half its
    // arguments is a tool failure the loop reports as a JSON parse error.
    if (type === 'response.output_item.done') {
      pending.delete(key)
      return [{ type: 'tool_call', call: finishTool(tool, key) }]
    }
    return []
  }

  if (type === 'response.function_call_arguments.delta') {
    const key = sseString(event.item_id) ?? `index-${sseNumber(event.output_index) ?? pending.size}`
    const tool = pending.get(key) ?? { callId: sseString(event.call_id) ?? key, name: '', arguments: '' }
    tool.arguments += sseString(event.delta) ?? ''
    pending.set(key, tool)
    return []
  }

  if (type === 'response.completed' || type === 'response.incomplete') {
    const events: MoarkStreamEvent[] = []
    // Flush every call before the turn is declared over.
    for (const [key, tool] of pending) {
      events.push({ type: 'tool_call', call: finishTool(tool, key) })
    }
    pending.clear()
    const completed = sseRecord(event.response) ?? event
    const usage = sseRecord(completed.usage)
    if (usage !== null) {
      events.push({
        type: 'usage',
        usage: {
          inputTokens: sseNumber(usage.input_tokens) ?? 0,
          outputTokens: sseNumber(usage.output_tokens) ?? 0,
        },
      })
    }
    const status = sseString(completed.status)
    events.push({ type: 'done', finishReason: status === 'incomplete' ? 'length' : 'stop' })
    return events
  }

  if (type === 'response.failed' || type === 'error') {
    const failed = sseRecord(event.response) ?? event
    const error = sseRecord(failed.error)
    const message = sseString(error?.message) ?? sseString(event.message) ?? sseErrorMessage(event) ?? type
    return [{ type: 'error', message }]
  }

  return []
}

/** The text of a completed message item, when it carries any. */
function messageItemText(item: Record<string, unknown>): string | undefined {
  const content = item.content
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const part of content) {
    const record = sseRecord(part)
    if (record === null) continue
    const partType = sseString(record.type)
    if (partType !== 'output_text' && partType !== 'refusal' && partType !== 'text') continue
    text += sseString(record.text) ?? ''
  }
  return text === '' ? undefined : text
}

function finishTool(tool: PendingFunctionCall, key: string): MoarkToolCall {
  return {
    id: tool.callId === '' ? `call_${key}` : tool.callId,
    name: tool.name,
    arguments: tool.arguments,
  }
}

/** Re-exported for the image-capability predicate the adapter consults. */
export { moarkModelSupportsImage }
