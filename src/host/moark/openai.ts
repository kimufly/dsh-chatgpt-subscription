/**
 * The OpenAI-compatible surface: `POST https://api.moark.com/v1/chat/completions`.
 *
 * This is the platform's primary documented path - MoArk's quick-start, its
 * OpenAI-client examples and its CC Switch profile all use it - which is why it
 * is the line's default surface.
 *
 * Everything here is about the *payload vocabulary*: turning the shared IR into
 * an OpenAI chat body, and turning OpenAI chat chunks back into normalized
 * events. The SSE framing itself lives in `sse.ts`, shared with the other two
 * surfaces.
 */

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  OPENAI_BASE_URL,
  OPENAI_CHAT_PATH,
  moarkBearerHeaders,
  moarkModelSupportsReasoning,
} from './types.ts'
import { readSseData, parseSseJson, sseNumber, sseRecord, sseString, sseErrorMessage } from './sse.ts'
import type { MoarkCallResult, MoarkMessage, MoarkRequest, MoarkStreamEvent, MoarkSurfaceCall, MoarkToolCall } from './wire.ts'

/** One accumulating tool call, keyed by the index the stream pairs fragments on. */
interface PendingToolCall {
  id: string
  name: string
  arguments: string
}

/**
 * Render the IR into an OpenAI chat body.
 *
 * Exported because it is the one piece of this surface worth testing without a
 * stream: the shape of `messages` / `tools` is where a mapping bug shows up as a
 * 400 from upstream rather than as anything a test can read out of a generator.
 */
export function buildRequestBody(request: MoarkRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(toWireMessage),
    stream: true,
  }
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens
  else body.max_tokens = DEFAULT_MAX_OUTPUT_TOKENS
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.parameters,
      },
    }))
    body.tool_choice = 'auto'
  }
  // A thinking control is sent only to a model whose family is documented to
  // understand one: an unrecognized option on a model that has never heard of it
  // is at best ignored and at worst a 400 that loses the whole turn.
  const effort = normalizeEffort(request.reasoningEffort)
  if (effort !== undefined && moarkModelSupportsReasoning(request.model)) {
    body.reasoning_effort = effort
  }
  return body
}

/** One IR message in OpenAI's shape. */
function toWireMessage(message: MoarkMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    }
  }
  if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content === '' ? null : message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments === '' ? '{}' : call.arguments },
      })),
    }
  }
  if (message.images !== undefined && message.images.length > 0) {
    // A multimodal user turn: text first, then one image part per attachment.
    // The text part is always present even when empty, because a body whose
    // content array carries only images is accepted by some gateways and
    // rejected by others, and an empty text part costs nothing.
    const parts: Record<string, unknown>[] = [{ type: 'text', text: message.content }]
    for (const image of message.images) {
      parts.push({ type: 'image_url', image_url: { url: image } })
    }
    return { role: message.role, content: parts }
  }
  return { role: message.role, content: message.content }
}

/** Reduce DSH's reasoning vocabulary to what this surface accepts. */
function normalizeEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const effort = value.toLowerCase()
  if (effort === 'none' || effort === 'off' || effort === 'false') return 'none'
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort
  if (effort === 'auto' || effort === 'true') return 'medium'
  // xhigh / max / anything unrecognized is dropped rather than lowered: silently
  // downgrading a request the user made is worse than sending none, because the
  // answer then looks like the model ignored the instruction.
  return undefined
}

/**
 * Start one streaming chat call.
 *
 * The request is issued EAGERLY, before anything pulls the generator. A
 * generator body does not run until its first `next()`, and the adapter awaits
 * `status` before reading events, so opening the connection inside the generator
 * would deadlock exactly the failover branches (401 / 429) that exist to recover
 * from a bad token.
 */
export function startCall(call: MoarkSurfaceCall): MoarkCallResult {
  let resolveStatus: (status: number) => void = () => undefined
  let rejectStatus: (error: unknown) => void = () => undefined
  const status = new Promise<number>((resolve, reject) => {
    resolveStatus = resolve
    rejectStatus = reject
  })

  const opened = call.fetchFn(`${OPENAI_BASE_URL}${OPENAI_CHAT_PATH}`, {
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
      yield { type: 'error', message: `MoArk chat completions failed (${response.status}): ${detail}` }
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
    // Prefer the envelope's own message; fall back to the raw body so a
    // non-JSON error page still says something.
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
  // Fragments accumulate across deltas, keyed by the index the stream pairs them
  // on: a call's id and name usually arrive only on the first fragment and its
  // arguments arrive in pieces.
  const pending = new Map<number, PendingToolCall>()
  let sawContent = false

  for await (const payload of readSseData(body, call.activity)) {
    const record = parseSseJson(payload)
    if (record === null) continue
    // An error envelope can arrive mid-stream on a 200. Reporting it as an error
    // event lets the adapter re-read the wording for a transient verdict; the
    // HTTP status alone would call it the caller's fault.
    const envelopeError = sseErrorMessage(record)
    if (record.error !== undefined && envelopeError !== undefined) {
      yield { type: 'error', message: envelopeError }
      return
    }
    for (const event of readChunk(record, pending)) {
      if (event.type !== 'usage' && event.type !== 'done') sawContent = true
      yield event
    }
  }

  // A call the stream never terminated still has to reach the caller, or the turn
  // would end with the model having asked for a tool and nothing acting on it.
  for (const [index, tool] of pending) {
    yield { type: 'tool_call', call: finishTool(tool, index) }
  }
  if (!sawContent) {
    yield { type: 'error', message: 'MoArk returned an empty stream.' }
  }
}

/** Fold one chunk into normalized events. */
function readChunk(
  record: Record<string, unknown>,
  pending: Map<number, PendingToolCall>,
): MoarkStreamEvent[] {
  const events: MoarkStreamEvent[] = []
  const choices = Array.isArray(record.choices) ? record.choices : []
  for (const choice of choices) {
    const entry = sseRecord(choice)
    if (entry === null) continue
    const delta = sseRecord(entry.delta)
    if (delta !== null) {
      const content = sseString(delta.content)
      if (content !== undefined) events.push({ type: 'text', text: content })
      // Both spellings are in the wild: DeepSeek-derived backends use
      // `reasoning_content`, others `reasoning`. Reading either is not a guess -
      // each is a real field name a real response carries.
      const reasoning = sseString(delta.reasoning_content) ?? sseString(delta.reasoning)
      if (reasoning !== undefined) events.push({ type: 'thinking', text: reasoning })
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      for (const raw of calls) {
        const callRecord = sseRecord(raw)
        if (callRecord === null) continue
        const index = sseNumber(callRecord.index) ?? pending.size
        const fn = sseRecord(callRecord.function)
        const existing = pending.get(index) ?? { id: '', name: '', arguments: '' }
        // First fragment wins for id and name: a later fragment carrying a
        // different id is not a correction, it is a different call.
        if (existing.id === '') existing.id = sseString(callRecord.id) ?? `call_${index}`
        if (existing.name === '') existing.name = sseString(fn?.name) ?? ''
        const argumentFragment = sseString(fn?.arguments)
        if (argumentFragment !== undefined) existing.arguments += argumentFragment
        pending.set(index, existing)
      }
    }
    const finish = sseString(entry.finish_reason)
    if (finish !== undefined) {
      // Flush every accumulated call before the turn is declared over: the
      // adapter closes blocks on these events, and a call still sitting in the
      // map would be dropped.
      for (const [index, tool] of pending) {
        events.push({ type: 'tool_call', call: finishTool(tool, index) })
      }
      pending.clear()
      events.push({ type: 'done', finishReason: finish })
    }
  }
  const usage = sseRecord(record.usage)
  if (usage !== null) {
    events.push({
      type: 'usage',
      usage: {
        inputTokens: sseNumber(usage.prompt_tokens) ?? 0,
        outputTokens: sseNumber(usage.completion_tokens) ?? 0,
      },
    })
  }
  return events
}

function finishTool(tool: PendingToolCall, index: number): MoarkToolCall {
  return {
    id: tool.id === '' ? `call_${index}` : tool.id,
    name: tool.name,
    arguments: tool.arguments,
  }
}
