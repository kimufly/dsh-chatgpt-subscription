import { describe, expect, it, vi } from 'vitest'
import { loadCatalog } from '../src/host/moark/catalog.ts'
import { isMoarkChatModel, OPENAI_BASE_URL, MODELS_PATH } from '../src/host/moark/types.ts'

/** A catalogue document shaped like the live one. */
function modelsResponse(ids: string[], status = 200): Response {
  return Response.json({ object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 1 })) }, { status })
}

describe('MoArk catalogue read', () => {
  it('reads chat-capable models and sorts them case-insensitively', async () => {
    const fetchFn = vi.fn(async () => modelsResponse(['qwen3.8-max', 'DeepSeek-V4-Pro', 'kimi-k3'])) as unknown as typeof fetch
    const result = await loadCatalog(fetchFn, 'token')
    expect(result.failure).toBeUndefined()
    expect(result.models.map((model) => model.id)).toEqual(['DeepSeek-V4-Pro', 'kimi-k3', 'qwen3.8-max'])
    expect(result.models.every((model) => typeof model.fetchedAt === 'number')).toBe(true)
    const [url, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!
    expect(url).toBe(`${OPENAI_BASE_URL}${MODELS_PATH}`)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token')
  })

  it('drops the families that cannot answer a chat completion', async () => {
    // One real id from each non-conversational family on the live list, plus two
    // that must survive.
    const ids = [
      'WeMM-Embedding-9B',
      'bge-reranker-large',
      'FLUX.2-klein-4B',
      'wan3.0-video',
      'VoxCPM2-Pro',
      'MinerU2.5-Pro',
      'Hunyuan3D-2',
      'DeepSeek-V4-Pro',
      'GLM-5.3',
    ]
    const fetchFn = vi.fn(async () => modelsResponse(ids)) as unknown as typeof fetch
    const result = await loadCatalog(fetchFn, 'token')
    expect(result.models.map((model) => model.id)).toEqual(['DeepSeek-V4-Pro', 'GLM-5.3'])
  })

  it('keeps a family the classifier does not recognize', async () => {
    // Failing open is the point: an unknown id is far more likely to be a new
    // chat model than a new embedding model, and hiding it breaks the line for
    // the model the user came to use.
    const fetchFn = vi.fn(async () => modelsResponse(['SomeBrand-New-Chat-Model-X'])) as unknown as typeof fetch
    const result = await loadCatalog(fetchFn, 'token')
    expect(result.models.map((model) => model.id)).toEqual(['SomeBrand-New-Chat-Model-X'])
  })

  it('reads anonymously when no token is stored yet, without an authorization header', async () => {
    const fetchFn = vi.fn(async () => modelsResponse(['GLM-5.3'])) as unknown as typeof fetch
    const result = await loadCatalog(fetchFn, '')
    expect(result.models).toHaveLength(1)
    const init = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1]
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('names a rejected token apart from an unreachable host and a malformed body', async () => {
    const unauthorized = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    expect(await loadCatalog(unauthorized, 'bad')).toEqual({ models: [], failure: 'auth', status: 401 })

    const forbidden = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    expect((await loadCatalog(forbidden, 'bad')).failure).toBe('auth')

    const upstream = vi.fn(async () => new Response('boom', { status: 502 })) as unknown as typeof fetch
    expect(await loadCatalog(upstream, 'token')).toEqual({ models: [], failure: 'upstream', status: 502 })

    const unreachable = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect((await loadCatalog(unreachable, 'token')).failure).toBe('unreachable')

    const malformed = vi.fn(async () => Response.json({ nope: true })) as unknown as typeof fetch
    const malformedResult = await loadCatalog(malformed, 'token')
    expect(malformedResult.failure).toBe('malformed')
    expect(malformedResult.status).toBe(200)
  })

  it('treats a non-JSON body as malformed rather than letting the parse escape', async () => {
    const html = vi.fn(async () => new Response('<html>proxy</html>', { status: 200 })) as unknown as typeof fetch
    // A response whose body is not JSON must be reported, not thrown: the caller
    // renders a card either way and a rejected promise reaches it as a raw route
    // failure instead of the sentence naming the cause.
    expect(await loadCatalog(html, 'token')).toMatchObject({ models: [], failure: 'malformed' })
  })
})

describe('MoArk model family classification', () => {
  it('accepts the coding families the line exists for', () => {
    for (const id of ['DeepSeek-V4-Pro', 'deepseek-v4.1-flash', 'qwen3.8-max', 'Kimi-K2.7-Code', 'GLM-5.3', 'MiniMax-M3', 'Qwen3-Coder-Next']) {
      expect(isMoarkChatModel(id), id).toBe(true)
    }
  })

  it('rejects the families whose purpose is not conversation', () => {
    for (const id of ['WeMM-Embedding-4B', 'Qwen3-VL-Reranker-8B', 'qwen-image-2.0', 'Wan2.2-T2V-A14B', 'Qwen3-TTS', 'Unlimited-OCR', 'Hi3DGen']) {
      expect(isMoarkChatModel(id), id).toBe(false)
    }
  })
})
