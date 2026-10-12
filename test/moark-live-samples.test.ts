import { describe, expect, it, vi } from 'vitest'
import { startCall as startOpenAi } from '../src/host/moark/openai.ts'
import { startCall as startResponses } from '../src/host/moark/responses.ts'
import { startCall as startAnthropic } from '../src/host/moark/anthropic.ts'
import type { MoarkStreamEvent, MoarkSurfaceCall } from '../src/host/moark/wire.ts'

/**
 * Regression fixtures transcribed from LIVE MoArk responses captured on
 * 2026-10-12 with a real access token.
 *
 * These are not hand-written approximations of the protocol: every frame below
 * was observed on the wire, and two of them pin defects that unit tests built
 * from the presumed protocol had missed entirely —
 *
 *  - the Responses surface sends `response.output_text.delta` frames, THEN a
 *    `response.output_text.done` frame, THEN a terminal message item, and all
 *    three carry the same full text (so an unguarded reader repeats the answer);
 *  - the Anthropic surface reports `input_tokens` as 0 on `message_start` and
 *    puts the real count on `message_delta` (so a reader that treats the last
 *    usage event naively must still end up with the right input count).
 */

/** The `id`/`model` fields a live frame carried are trimmed; nothing else is changed. */
function frame(value: unknown): string {
  return JSON.stringify(value)
}

function sse(frames: string[]): Response {
  return new Response(frames.map((value) => `data: ${value}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function drain(events: AsyncIterable<MoarkStreamEvent>): Promise<MoarkStreamEvent[]> {
  const out: MoarkStreamEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

function call(fetchFn: typeof fetch, model: string): MoarkSurfaceCall {
  return { fetchFn, apiKey: 'test-token', request: { model, messages: [{ role: 'user', content: 'hi' }] } }
}

function textOf(events: MoarkStreamEvent[]): string {
  return events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text).join('')
}

describe('live OpenAI-surface sample', () => {
  // Observed shape: an empty role frame, reasoning_content deltas, content
  // deltas that are empty until the end, and a terminal usage frame.
  const frames = [
    frame({ choices: [{ delta: { content: '', reasoning_content: '', role: 'assistant' }, index: 0 }], usage: null }),
    frame({ choices: [{ delta: { content: '', reasoning_content: 'The user wants exactly', role: 'assistant' }, index: 0 }], usage: null }),
    frame({ choices: [{ delta: { content: '', reasoning_content: ' "MOARK-REPLY". I should comply.' }, index: 0 }], usage: null }),
    frame({ choices: [{ delta: { content: 'MOARK-', reasoning_content: '' }, index: 0 }], usage: null }),
    frame({ choices: [{ delta: { content: 'REPLY', reasoning_content: '' }, index: 0 }], usage: null }),
    frame({ choices: [{ delta: { content: '', reasoning_content: '' }, index: 0, finish_reason: 'stop' }], usage: { completion_tokens: 23, prompt_tokens: 38, total_tokens: 61 } }),
  ]

  it('yields the answer once, the trace separately, and the usage MoArk sends by default', async () => {
    const fetchFn = vi.fn(async () => sse(frames)) as unknown as typeof fetch
    const events = await drain(startOpenAi(call(fetchFn, 'deepseek-v4.1-flash')).events)

    expect(textOf(events)).toBe('MOARK-REPLY')
    expect(events.filter((event) => event.type === 'text')).toHaveLength(2)
    const thinking = events.filter((event) => event.type === 'thinking').map((event) => (event as { text: string }).text).join('')
    expect(thinking).toContain('The user wants exactly')
    // MoArk includes `usage` on streamed chunks WITHOUT `stream_options`, which
    // is why this line does not send that field.
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 38, outputTokens: 23 } })
    expect(events).toContainEqual({ type: 'done', finishReason: 'stop' })
  })
})

describe('live Responses-surface sample', () => {
  // Observed shape: reasoning-summary deltas, output_text deltas, an
  // output_text.done frame carrying the whole text, a terminal message item
  // carrying the whole text AGAIN, and an `incomplete` terminal event with usage.
  const frames = [
    frame({ type: 'response.in_progress', response: {} }),
    frame({ type: 'response.reasoning_summary_part.added' }),
    frame({ type: 'response.reasoning_summary_text.delta', delta: 'The user wants' }),
    frame({ type: 'response.reasoning_summary_text.delta', delta: ' exactly RESP-OK' }),
    frame({ type: 'response.output_item.added', item: { type: 'reasoning' } }),
    frame({ type: 'response.output_item.done', item: { type: 'reasoning' } }),
    frame({ type: 'response.content_part.added' }),
    frame({ type: 'response.output_text.delta', delta: 'RES' }),
    frame({ type: 'response.output_text.delta', delta: 'P-' }),
    frame({ type: 'response.output_text.delta', delta: 'OK' }),
    frame({ type: 'response.output_text.done', text: 'RESP-OK' }),
    frame({ type: 'response.output_item.added', item: { type: 'message', role: 'assistant', content: [] } }),
    frame({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'RESP-OK' }] } }),
    frame({ type: 'response.incomplete', response: { status: 'incomplete', usage: { input_tokens: 37, output_tokens: 24, total_tokens: 61 } } }),
  ]

  it('emits the answer EXACTLY once, though three frames each carry the whole text', async () => {
    const fetchFn = vi.fn(async () => sse(frames)) as unknown as typeof fetch
    const events = await drain(startResponses(call(fetchFn, 'deepseek-v4.1-flash')).events)

    // The deltas carry it; the `output_text.done` frame and the terminal message
    // item repeat it verbatim on a real stream, and adopting either would show
    // the user the same sentence two or three times.
    expect(textOf(events)).toBe('RESP-OK')
    expect(events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text))
      .toEqual(['RES', 'P-', 'OK'])
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 37, outputTokens: 24 } })
    // `incomplete` means the output cap ran out, not that the model finished.
    expect(events).toContainEqual({ type: 'done', finishReason: 'length' })
  })

  it('still recovers the text when a gateway buffered the response and sent no deltas', async () => {
    const buffered = [
      frame({ type: 'response.output_text.done', text: 'BUFFERED-ONLY' }),
      frame({ type: 'response.completed', response: { status: 'completed' } }),
    ]
    const fetchFn = vi.fn(async () => sse(buffered)) as unknown as typeof fetch
    const events = await drain(startResponses(call(fetchFn, 'deepseek-v4.1-flash')).events)
    expect(textOf(events)).toBe('BUFFERED-ONLY')
  })
})

describe('live Anthropic-surface sample', () => {
  // Observed shape: `message_start` reports input_tokens 0 and output_tokens 0,
  // then TWO `message_delta` frames carry the real counts (91 in / 23 out).
  const frames = [
    frame({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 0, output_tokens: 0 } } }),
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ANTH' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '-OK' } }),
    frame({ type: 'content_block_stop', index: 0 }),
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 91, output_tokens: 23, cache_read_input_tokens: 0 } }),
    frame({ type: 'message_delta', delta: {}, usage: { input_tokens: 91, output_tokens: 23 } }),
    frame({ type: 'message_stop' }),
  ]

  it('assembles the text and ends with the REAL input count, not the placeholder zero', async () => {
    const fetchFn = vi.fn(async () => sse(frames)) as unknown as typeof fetch
    const events = await drain(startAnthropic(call(fetchFn, 'deepseek-v4-flash-0731')).events)

    expect(textOf(events)).toBe('ANTH-OK')
    const usages = events.filter((event) => event.type === 'usage') as Array<{ usage: { inputTokens: number; outputTokens: number } }>
    expect(usages.length).toBeGreaterThan(0)
    // The adapter keeps the LAST usage event, so the final one must not report 0
    // input — that is exactly the accounting bug this fixture pins.
    expect(usages.at(-1)!.usage).toEqual({ inputTokens: 91, outputTokens: 23 })
    expect(events).toContainEqual({ type: 'done', finishReason: 'end_turn' })
  })

  it('carries the input count forward when a delta states only output tokens', async () => {
    // The split documented by Anthropic itself: input on message_start, output
    // on message_delta. The final usage must still name both.
    const split = [
      frame({ type: 'message_start', message: { usage: { input_tokens: 55, output_tokens: 1 } } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }),
      frame({ type: 'message_stop' }),
    ]
    const fetchFn = vi.fn(async () => sse(split)) as unknown as typeof fetch
    const events = await drain(startAnthropic(call(fetchFn, 'deepseek-v4-flash-0731')).events)
    const usages = events.filter((event) => event.type === 'usage') as Array<{ usage: { inputTokens: number; outputTokens: number } }>
    expect(usages.at(-1)!.usage).toEqual({ inputTokens: 55, outputTokens: 12 })
  })

  it('normalizes a tool_use stop reason to the vocabulary the other surfaces use', async () => {
    const tools = [
      frame({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } }),
      frame({ type: 'content_block_stop', index: 0 }),
      frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 10, output_tokens: 8 } }),
      frame({ type: 'message_stop' }),
    ]
    const fetchFn = vi.fn(async () => sse(tools)) as unknown as typeof fetch
    const events = await drain(startAnthropic(call(fetchFn, 'deepseek-v4-flash-0731')).events)
    expect(events).toContainEqual({ type: 'tool_call', call: { id: 'toolu_1', name: 'read', arguments: '{"path":"a.txt"}' } })
    expect(events).toContainEqual({ type: 'done', finishReason: 'tool_calls' })
  })
})
