/**
 * The SSE frame reader all three MoArk surfaces share.
 *
 * OpenAI, Responses and Anthropic all stream `text/event-stream`, and the
 * framing rules that matter are identical across them: a frame is a line, a
 * `data:` payload carries JSON, blank lines separate nothing this line needs,
 * and `:`-prefixed lines are comments (the heartbeats a gateway sends to hold a
 * connection open). Only the *payload vocabulary* differs, so that is all each
 * surface module owns.
 *
 * Two details are load-bearing and easy to get wrong:
 *
 *  - **Activity is pulsed on bytes, not on parsed events.** A heartbeat frame
 *    yields nothing, so a watchdog that only rearmed on events would time out a
 *    connection that is demonstrably alive.
 *  - **`[DONE]` is a control frame, not a payload.** It arrives on the OpenAI and
 *    Anthropic surfaces and carries no JSON; handing it to `JSON.parse` produces
 *    a caught syntax error that would look like a malformed frame.
 */

import type { StreamActivity } from '../common/idle-watchdog.ts'

/**
 * Read one SSE body, yielding the raw `data:` payload of every frame.
 *
 * Deliberately yields strings rather than parsed objects: a surface that needs
 * to see a frame it cannot parse (to report it, or to count it) can do so, and a
 * surface that only wants JSON parses at its own call site.
 *
 * Never throws on a malformed frame. A body that is not SSE at all - an HTML
 * error page behind a proxy, a JSON error envelope sent with a 200 - arrives here
 * as lines that yield nothing, so the surface sees an empty stream; the surface
 * modules each handle "the stream ended with nothing" as the error it is rather
 * than letting a parser exception escape as something that names no cause.
 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  activity?: StreamActivity | undefined,
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // Transport received bytes, whether or not a parser turns them into an
      // event: a heartbeat frame is proof the connection is alive.
      if (value !== undefined && value.byteLength > 0) activity?.pulse()
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        // One complete frame arrived. A ': ping' comment yields no payload and
        // must still re-time the watchdog.
        if (line !== '') activity?.pulse()
        if (line === '' || !line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        yield payload
      }
    }
    // A final frame with no trailing newline is still a frame.
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim()
      if (payload !== '' && payload !== '[DONE]') yield payload
    }
  } finally {
    reader.releaseLock?.()
  }
}

/**
 * Parse one payload into a record, or null when it is not a JSON object.
 *
 * Null rather than an exception, because a stream carrying one unreadable frame
 * is not a failed turn: the surfaces skip it and keep reading, which is what the
 * existing lines do and what a user with a lossy proxy needs.
 */
export function parseSseJson(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Read a string field, treating the empty string as absent. */
export function sseString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read a finite number field. */
export function sseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Read an object field. */
export function sseRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** The upstream detail text of an error envelope, whichever surface sent it. */
export function sseErrorMessage(body: unknown): string | undefined {
  const record = sseRecord(body)
  if (record === null) return typeof body === 'string' && body !== '' ? body : undefined
  const error = record.error
  if (typeof error === 'string' && error !== '') return error
  const nested = sseRecord(error)
  if (nested !== null) {
    const message = sseString(nested.message) ?? sseString(nested.code) ?? sseString(nested.type)
    if (message !== undefined) return message
  }
  return sseString(record.message) ?? sseString(record.detail)
}
