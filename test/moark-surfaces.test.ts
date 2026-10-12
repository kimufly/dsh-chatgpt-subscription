import { describe, expect, it, vi } from 'vitest'
import { buildRequestBody as buildOpenAiBody, startCall as startOpenAi } from '../src/host/moark/openai.ts'
import { buildRequestBody as buildResponsesBody, startCall as startResponses } from '../src/host/moark/responses.ts'
import {
  buildMessages,
  buildRequestBody as buildAnthropicBody,
  startCall as startAnthropic,
} from '../src/host/moark/anthropic.ts'
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_MESSAGES_PATH,
  OPENAI_BASE_URL,
  OPENAI_CHAT_PATH,
  RESPONSES_BASE_URL,
  RESPONSES_PATH,
} from '../src/host/moark/types.ts'
import type { MoarkRequest, MoarkStreamEvent, MoarkSurfaceCall } from '../src/host/moark/wire.ts'

/** An SSE body built from raw frames, exactly as a gateway sends them. */
function sseResponse(frames: string[]): Response {
  return new Response(frames.map((frame) => `data: ${frame}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(events: AsyncIterable<MoarkStreamEvent>): Promise<MoarkStreamEvent[]> {
  const out: MoarkStreamEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

function call(fetchFn: typeof fetch, request: Partial<MoarkRequest> = {}): MoarkSurfaceCall {
  return {
    fetchFn,
    apiKey: 'test-token',
    request: { model: 'DeepSeek-V4-Pro', messages: [{ role: 'user', content: 'hi' }], ...request },
  }
}

describe('MoArk request bodies', () => {
  it('renders an OpenAI chat body with tools and a thinking control only where declared', () => {
    const body = buildOpenAiBody({
      model: 'DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
      reasoningEffort: 'high',
      maxOutputTokens: 128,
      temperature: 0.3,
    })
    expect(body).toMatchObject({ model: 'DeepSeek-V4-Pro', stream: true, max_tokens: 128, temperature: 0.3 })
    expect(body.reasoning_effort).toBe('high')
    expect(body.tool_choice).toBe('auto')
    expect(body.tools).toEqual([{
      type: 'function',
      function: { name: 'read', description: 'read a file', parameters: { type: 'object' } },
    }])
  })

  it('omits the thinking control for a model whose family is not declared to have one', () => {
    // Sending an unknown option to a model that never agreed to it is at best
    // ignored and at worst a 400 that loses the whole turn.
    const body = buildOpenAiBody({
      model: 'SomeUnknown-Model',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'high',
    })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('renders assistant tool calls and tool results in OpenAI shape', () => {
    const body = buildOpenAiBody({
      model: 'GLM-5.3',
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"p":"a"}' }] },
        { role: 'tool', content: 'file body', toolCallId: 'call_1' },
      ],
    })
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[0]).toMatchObject({ role: 'assistant', content: null })
    expect(messages[0]!.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } },
    ])
    expect(messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'file body' })
  })

  it('renders an image turn as a multimodal content array', () => {
    const body = buildOpenAiBody({
      model: 'qwen3-vl-8b',
      messages: [{ role: 'user', content: 'what is this', images: ['data:image/png;base64,AAA'] }],
    })
    const content = (body.messages as Record<string, unknown>[])[0]!.content as Record<string, unknown>[]
    expect(content[0]).toEqual({ type: 'text', text: 'what is this' })
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } })
  })

  it('lifts the leading system prompt out of the Anthropic messages array', () => {
    const { system, messages } = buildMessages([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ])
    expect(system).toBe('be terse')
    expect(messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('carries a later system turn into the following user turn instead of dropping it', () => {
    // Anthropic rejects a `system` role inside `messages`, and silently discarding
    // the instruction would change the answer without saying so.
    const { messages } = buildMessages([
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'now be verbose' },
      { role: 'user', content: 'go' },
    ])
    expect(messages[1]).toEqual({ role: 'user', content: 'now be verbose\n\ngo' })
  })

  it('groups consecutive tool results into ONE Anthropic user turn', () => {
    // Two user turns in a row are rejected by Anthropic, and one assistant turn
    // can produce several calls that are answered by several results.
    const { messages } = buildMessages([
      { role: 'assistant', content: '', toolCalls: [
        { id: 'a', name: 'read', arguments: '{}' },
        { id: 'b', name: 'read', arguments: '{}' },
      ] },
      { role: 'tool', content: 'first', toolCallId: 'a' },
      { role: 'tool', content: 'second', toolCallId: 'b' },
    ])
    expect(messages).toHaveLength(2)
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'first' },
        { type: 'tool_result', tool_use_id: 'b', content: 'second' },
      ],
    })
  })

  it('renders Anthropic tool_use inputs as objects, never as JSON strings', () => {
    const body = buildAnthropicBody({
      model: 'GLM-5.3',
      messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', arguments: '{"p":"a"}' }] }],
    })
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[0]!.content).toEqual([{ type: 'tool_use', id: 'a', name: 'read', input: { p: 'a' } }])
  })

  it('always sends max_tokens on the Anthropic surface, because it is required', () => {
    expect(buildAnthropicBody({ model: 'GLM-5.3', messages: [] }).max_tokens).toBeTypeOf('number')
  })

  it('renders a Responses body with function calls as their own items', () => {
    const body = buildResponsesBody({
      model: 'DeepSeek-V4-Pro',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: '{}' }] },
        { role: 'tool', content: 'body', toolCallId: 'call_1' },
      ],
      tools: [{ name: 'read', parameters: { type: 'object' } }],
    })
    const input = body.input as Record<string, unknown>[]
    expect(input[0]).toMatchObject({ type: 'message', role: 'user' })
    expect(input[1]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'read' })
    expect(input[2]).toMatchObject({ type: 'function_call_output', call_id: 'call_1', output: 'body' })
    expect(body.tools).toEqual([{ type: 'function', name: 'read', parameters: { type: 'object' } }])
  })
})

describe('MoArk OpenAI surface streaming', () => {
  it('streams text, reasoning and tool calls through the shared IR', async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'think ' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { content: 'hi ' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"p"' } }] }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] }, finish_reason: 'tool_calls' }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    ])) as unknown as typeof fetch

    const result = startOpenAi(call(fetchFn))
    expect(await result.status).toBe(200)
    const events = await collect(result.events)

    expect(events.filter((event) => event.type === 'thinking')).toEqual([{ type: 'thinking', text: 'think ' }])
    expect(events.filter((event) => event.type === 'text')).toEqual([{ type: 'text', text: 'hi ' }])
    expect(events.filter((event) => event.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'call_1', name: 'read', arguments: '{"p":"a"}' } },
    ])
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } })
    expect(events).toContainEqual({ type: 'done', finishReason: 'tool_calls' })
  })

  it('issues the request before anything pulls the stream, so awaiting status cannot deadlock', async () => {
    // The adapter awaits `status` before reading events; a generator that opened
    // the connection lazily would hang the failover path that exists to recover
    // from a bad token.
    let requested = false
    const fetchFn = vi.fn(async () => {
      requested = true
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
    }) as unknown as typeof fetch
    const result = startOpenAi(call(fetchFn))
    expect(requested).toBe(true)
    expect(await result.status).toBe(200)
  })

  it('reports a non-2xx as an error event carrying the status', async () => {
    const fetchFn = vi.fn(async () => new Response('{"error":{"message":"bad token"}}', { status: 401 })) as unknown as typeof fetch
    const result = startOpenAi(call(fetchFn))
    expect(await result.status).toBe(401)
    const events = await collect(result.events)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error' })
    expect((events[0] as { message: string }).message).toContain('401')
    expect((events[0] as { message: string }).message).toContain('bad token')
  })

  it('skips a malformed frame instead of ending the turn on it', async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      '{not json',
      JSON.stringify({ choices: [{ delta: { content: 'survived' }, finish_reason: 'stop' }] }),
    ])) as unknown as typeof fetch
    const events = await collect(startOpenAi(call(fetchFn)).events)
    expect(events).toContainEqual({ type: 'text', text: 'survived' })
  })

  it('reports an empty stream as an error rather than as a silent empty answer', async () => {
    // A proxy answering an HTML error page with a 200 arrives here as frames
    // that yield nothing; calling that an empty answer would lose the cause.
    const fetchFn = vi.fn(async () => new Response('<html></html>', { status: 200 })) as unknown as typeof fetch
    const events = await collect(startOpenAi(call(fetchFn)).events)
    expect(events.some((event) => event.type === 'error')).toBe(true)
  })

  it('targets the documented OpenAI endpoint', async () => {
    const fetchFn = vi.fn(async () => sseResponse([JSON.stringify({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] })])) as unknown as typeof fetch
    await collect(startOpenAi(call(fetchFn)).events)
    const [url] = (fetchFn as unknown as { mock: { calls: [string][] } }).mock.calls[0]!
    expect(url).toBe(`${OPENAI_BASE_URL}${OPENAI_CHAT_PATH}`)
  })
})

describe('MoArk Anthropic surface streaming', () => {
  it('maps the Messages event vocabulary, including input_json_delta accumulation', async () => {
    const frames = [
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool_1', name: 'read' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"p"' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ':"a"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ]
    const fetchFn = vi.fn(async () => sseResponse(frames.map((frame) => JSON.stringify(frame)))) as unknown as typeof fetch
    const result = startAnthropic(call(fetchFn))
    expect(await result.status).toBe(200)
    const events = await collect(result.events)

    expect(events).toContainEqual({ type: 'thinking', text: 'pondering' })
    expect(events).toContainEqual({ type: 'text', text: 'hello' })
    expect(events).toContainEqual({ type: 'tool_call', call: { id: 'tool_1', name: 'read', arguments: '{"p":"a"}' } })
    // Anthropic splits usage: `message_start` carries the 5 input tokens and
    // `message_delta` normally carries ONLY output tokens. The final usage must
    // therefore still report 5 input tokens — emitting an absent input count as 0
    // would make every turn look like it cost nothing to send.
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 5, outputTokens: 9 } })
    // `tool_use` is normalized to the vocabulary the other surfaces use.
    expect(events).toContainEqual({ type: 'done', finishReason: 'tool_calls' })
  })

  it('sends both x-api-key and a Bearer authorization header', async () => {
    // Anthropic-compatible gateways disagree about which they read, and MoArk's
    // own page only pins the Bearer half.
    const fetchFn = vi.fn(async () => sseResponse([JSON.stringify({ type: 'message_stop' })])) as unknown as typeof fetch
    await collect(startAnthropic(call(fetchFn)).events)
    const [url, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!
    expect(url).toBe(`${ANTHROPIC_BASE_URL}${ANTHROPIC_MESSAGES_PATH}`)
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('test-token')
    expect(headers.authorization).toBe('Bearer test-token')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('surfaces an in-stream error event as an error', async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }),
    ])) as unknown as typeof fetch
    const events = await collect(startAnthropic(call(fetchFn)).events)
    expect(events).toContainEqual({ type: 'error', message: 'overloaded' })
  })
})

describe('MoArk Responses surface streaming', () => {
  it('maps output text, reasoning and function-call arguments', async () => {
    const frames = [
      { type: 'response.output_text.delta', delta: 'he' },
      { type: 'response.output_text.delta', delta: 'llo' },
      { type: 'response.reasoning_summary_text.delta', delta: 'why' },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"p"' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: ':"a"}' },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"p":"a"}' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 4, output_tokens: 6 } } },
    ]
    const fetchFn = vi.fn(async () => sseResponse(frames.map((frame) => JSON.stringify(frame)))) as unknown as typeof fetch
    const result = startResponses(call(fetchFn))
    expect(await result.status).toBe(200)
    const events = await collect(result.events)

    expect(events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text)).toEqual(['he', 'llo'])
    expect(events).toContainEqual({ type: 'thinking', text: 'why' })
    expect(events.filter((event) => event.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'call_1', name: 'read', arguments: '{"p":"a"}' } },
    ])
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 4, outputTokens: 6 } })
    expect(events).toContainEqual({ type: 'done', finishReason: 'stop' })
  })

  it('targets the documented Responses endpoint', async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
    ])) as unknown as typeof fetch
    await collect(startResponses(call(fetchFn)).events)
    const [url] = (fetchFn as unknown as { mock: { calls: [string][] } }).mock.calls[0]!
    expect(url).toBe(`${RESPONSES_BASE_URL}${RESPONSES_PATH}`)
  })

  it('reports a failed response as an error event', async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { message: 'model not found' } } }),
    ])) as unknown as typeof fetch
    const events = await collect(startResponses(call(fetchFn)).events)
    expect(events).toContainEqual({ type: 'error', message: 'model not found' })
  })

  it('does NOT double the answer when the terminal message item repeats streamed text', async () => {
    // A standard Responses stream sends `response.output_item.done` for the
    // message item AFTER the deltas that built it, and that item carries the
    // COMPLETE text. Adopting it unconditionally would show every answer twice.
    const fetchFn = vi.fn(async () => sseResponse([
      JSON.stringify({ type: 'response.output_text.delta', delta: 'hello ' }),
      JSON.stringify({ type: 'response.output_text.delta', delta: 'world' }),
      JSON.stringify({ type: 'response.output_item.done', item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello world' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
    ])) as unknown as typeof fetch
    const events = await collect(startResponses(call(fetchFn)).events)
    const text = events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text)
    expect(text).toEqual(['hello ', 'world'])
    expect(text.join('')).toBe('hello world')
  })

  it('adopts the terminal item text when NO delta streamed, which a buffering gateway produces', async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      JSON.stringify({ type: 'response.output_item.done', item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'buffered answer' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
    ])) as unknown as typeof fetch
    const events = await collect(startResponses(call(fetchFn)).events)
    expect(events.filter((event) => event.type === 'text')).toEqual([{ type: 'text', text: 'buffered answer' }])
  })
})
