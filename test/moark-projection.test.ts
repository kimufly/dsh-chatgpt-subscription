import { describe, expect, it } from 'vitest'
import { normalizeGenerateOptions } from '../src/host/common/llm-compat.ts'
import { toMoarkRequest, MoarkAdapter } from '../src/host/moark/adapter.ts'
import { applyEvent, closeStream, createStreamState } from '../src/host/moark/mapper.ts'
import { moarkModelSupportsImage, wireForModel, DEFAULT_WIRE } from '../src/host/moark/types.ts'
import type { MoarkStreamEvent } from '../src/host/moark/wire.ts'

/**
 * A normalized DSH request, built the way the adapter receives it.
 *
 * Content is a block array, which is the vocabulary `normalizeGenerateOptions`
 * produces (a bare string normalizes to no blocks at all).
 */
function options(overrides: Record<string, unknown> = {}) {
  return normalizeGenerateOptions({
    provider: 'moark',
    model: 'DeepSeek-V4-Pro',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...overrides,
  } as never)
}

describe('MoArk request projection', () => {
  it('projects a system prompt and a user turn', async () => {
    const request = await toMoarkRequest(options({ system: 'be terse' }))
    expect(request.model).toBe('DeepSeek-V4-Pro')
    expect(request.messages[0]).toEqual({ role: 'system', content: 'be terse' })
    expect(request.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('does not duplicate a leading system message that repeats options.system', async () => {
    const request = await toMoarkRequest(options({
      system: 'be terse',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'be terse' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    }))
    expect(request.messages.filter((message) => message.role === 'system')).toHaveLength(1)
  })

  it('carries tool definitions through unchanged', async () => {
    const request = await toMoarkRequest(options({
      tools: [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }],
    }))
    expect(request.tools).toEqual([{
      name: 'read',
      description: 'read',
      parameters: { type: 'object', properties: {} },
    }])
  })

  it('passes the reasoning effort through unnormalized', async () => {
    // Each surface names its thinking control differently, so the surface module
    // is the only layer that can decide whether a value is expressible at all.
    const request = await toMoarkRequest(options({ reasoningEffort: 'high' }))
    expect(request.reasoningEffort).toBe('high')
  })

  it('substitutes an explanatory note for an image on a model with no declared vision', async () => {
    // Claiming image input for a model that cannot take one is worse than
    // claiming too little: the screenshot would vanish and the model would answer
    // as if it had never been sent.
    const request = await toMoarkRequest(options({
      model: 'DeepSeek-V4-Pro',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' } },
        ],
      }],
    }))
    const user = request.messages.find((message) => message.role === 'user')!
    expect(user.images).toBeUndefined()
    expect(user.content).toContain('image unsupported')
  })

  it('keeps an image on a family that declares vision', async () => {
    const request = await toMoarkRequest(options({
      model: 'qwen3-vl-8b-instruct',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' } },
        ],
      }],
    }))
    const user = request.messages.find((message) => message.role === 'user')!
    expect(user.images).toEqual(['data:image/png;base64,AAAA'])
  })

  it('resolves an attachment reference through the attachment store', async () => {
    const reference = { attachmentId: 'att-1', mediaType: 'image/png' }
    const request = await toMoarkRequest(
      options({
        model: 'qwen3-vl-8b-instruct',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: reference }] }],
      }),
      { readImage: async () => ({ ref: reference, data: new Uint8Array([1, 2, 3]) }) } as never,
    )
    const user = request.messages.find((message) => message.role === 'user')!
    expect(user.images?.[0]).toMatch(/^data:image\/png;base64,/)
  })
})

describe('MoArk stream mapper', () => {
  function fold(events: MoarkStreamEvent[]) {
    const state = createStreamState()
    const chunks = events.flatMap((event) => applyEvent(state, event))
    return [...chunks, ...closeStream(state)]
  }

  it('frames text and reasoning into separate blocks', () => {
    const chunks = fold([
      { type: 'thinking', text: 'why' },
      { type: 'text', text: 'hello' },
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'why' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'why' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'hello' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'hello' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('ends a turn that asked for a tool on tool-calls, never on stop', () => {
    // Reporting 'stop' would tell the agent loop the model is finished and cut
    // the turn short before the tool ever ran.
    const chunks = fold([{ type: 'tool_call', call: { id: 'call_1', name: 'read', arguments: '{}' } }])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('closes a text block that was still open when the stream ended', () => {
    // The model can be cut off mid-sentence; the text that did arrive is what the
    // user should see, so the block closes with it rather than being dropped.
    const chunks = fold([{ type: 'text', text: 'half a sen' }])
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'half a sen' } })
  })

  it('carries a call with no arguments as an empty JSON object', () => {
    const chunks = fold([{ type: 'tool_call', call: { id: 'call_1', name: 'read', arguments: '' } }])
    const end = chunks.find((chunk) => chunk.type === 'block-end') as { block: { arguments: string } }
    expect(end.block.arguments).toBe('{}')
  })
})

describe('MoArk wire and capability facts', () => {
  it('prefers an explicit surface declaration, then the user default, then the platform default', () => {
    expect(wireForModel('m', 'anthropic', 'openai')).toBe('anthropic')
    expect(wireForModel('m', undefined, 'responses')).toBe('responses')
    expect(wireForModel('m', undefined, undefined)).toBe(DEFAULT_WIRE)
    expect(DEFAULT_WIRE).toBe('openai')
  })

  it('declares vision only for families whose multimodal variants are unambiguous', () => {
    expect(moarkModelSupportsImage('qwen3-vl-8b')).toBe(true)
    expect(moarkModelSupportsImage('internvl3-8b')).toBe(true)
    // A text-only checkpoint of a well-known family must not claim image input.
    expect(moarkModelSupportsImage('DeepSeek-V4-Pro')).toBe(false)
    expect(moarkModelSupportsImage('GLM-5.3')).toBe(false)
  })

  it('exposes every surface on the adapter catalogue lookup without a stored token', async () => {
    const adapter = new MoarkAdapter(
      { read: async () => null, write: async () => undefined, clear: async () => undefined, path: () => '' } as never,
      {
        status: () => ({ enabled: true, enabledModelIds: null, catalogModels: [], defaultReasoningEffort: null, defaultWire: 'openai' }),
        read: async () => ({ enabled: true, enabledModelIds: null, catalogModels: [], defaultReasoningEffort: null, defaultWire: 'openai' }),
        update: async () => ({ enabled: true, enabledModelIds: null, catalogModels: [], defaultReasoningEffort: null, defaultWire: 'openai' }),
        storeCatalog: async () => ({ enabled: true, enabledModelIds: null, catalogModels: [], defaultReasoningEffort: null, defaultWire: 'openai' }),
      } as never,
    )
    // No fallback names exist: an empty catalogue is the honest answer before the
    // first sync, not a hard-coded list of guessed models.
    expect(await adapter.listModels()).toEqual([])
    expect(adapter.providerInfo('moark').name).toContain('MoArk')
  })

  it('hides every model when the line itself is switched off', async () => {
    const settings = { enabled: false, enabledModelIds: null, catalogModels: [], defaultReasoningEffort: null, defaultWire: 'openai' as const }
    const adapter = new MoarkAdapter(
      { read: async () => null, write: async () => undefined, clear: async () => undefined, path: () => '' } as never,
      { status: () => settings, read: async () => settings, update: async () => settings, storeCatalog: async () => settings } as never,
    )
    expect(await adapter.listModels()).toEqual([])
  })
})
