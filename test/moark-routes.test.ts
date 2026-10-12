import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { registerMoarkRoutes, getMoarkWebStatus, MOARK_KEYS_URL } from '../src/host/moark/routes.ts'
import { MoarkAccountPool } from '../src/host/moark/account-pool.ts'
import { FileCredentialStore, FileModelSettingsStore, type MoarkCredentials } from '../src/host/moark/token-store.ts'
import type { PoolData } from '../src/host/common/account-pool.ts'
import type { MoarkPoolAccount } from '../src/host/moark/account-pool.ts'
import { MOARK_ROUTE_PREFIX } from '../src/shared/moark-contracts.ts'

interface Captured {
  status: number
  raw: string | null
  body: { ok: boolean; value?: unknown; error?: unknown }
}

/** A response double that keeps the raw body, so 'wrote nothing at all' stays observable. */
function fakeExchange(): { response: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, raw: null, body: { ok: false } }
  const response = {
    writeHead(status: number) {
      captured.status = status
      return response
    },
    end(raw?: string) {
      captured.raw = raw ?? null
      if (raw === undefined) return
      captured.body = JSON.parse(raw) as Captured['body']
    },
  } as unknown as ServerResponse
  return { response, captured }
}

/** A request double replaying one JSON body to whatever attaches listeners. */
function fakeRequest(init: { url: string; method?: string; body?: unknown; origin?: string | null }): IncomingMessage {
  const payload = init.body === undefined ? '' : JSON.stringify(init.body)
  const chunks = payload === '' ? [] : [Buffer.from(payload, 'utf8')]
  const origin = init.origin === undefined ? 'http://127.0.0.1:3000' : init.origin
  return {
    url: init.url,
    method: init.method ?? 'GET',
    headers: origin === null ? {} : { origin, host: '127.0.0.1:3000' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

/** In-memory stand-in for a platform credential backend (no keyring in CI). */
class MemoryBackend<T> {
  private data: T | null = null
  async load(): Promise<T | null> {
    return this.data
  }
  async save(value: T): Promise<void> {
    this.data = JSON.parse(JSON.stringify(value)) as T
  }
  async clear(): Promise<void> {
    this.data = null
  }
}

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

/** The live `/v1/models` shape, with one non-chat family that must be filtered out. */
const MODELS = {
  object: 'list',
  data: [
    { id: 'WeMM-Embedding-9B', object: 'model' },
    { id: 'GLM-5.3', object: 'model' },
    { id: 'DeepSeek-V4-Pro', object: 'model' },
  ],
}

type Respond = (init: { url: string; method?: string; body?: unknown; origin?: string | null }) => Promise<Captured>

describe('MoArk settings routes', () => {
  let respond: Respond
  let emitted: unknown[]
  let modelFile: string
  let modelSettings: FileModelSettingsStore
  let accountPool: MoarkAccountPool
  let upstream: () => Promise<Response>
  /** Register the route set again with extra options, for tests about them. */
  let setupRoutes: (extra?: Partial<Parameters<typeof registerMoarkRoutes>[1]>) => Promise<Respond>

  beforeEach(async () => {
    // EVERY path is per-test. The pool's file name is fixed in production, and
    // the single-credential mirror the pool keeps reads and writes it, so a
    // shared temp home would leak one test's accounts into the next one's list.
    modelFile = tmpFile('moark-models')
    const credentialFile = tmpFile('moark-credential')
    const credentialBackend = new MemoryBackend<MoarkCredentials>()
    accountPool = new MoarkAccountPool({
      store: new FileCredentialStore(credentialFile, credentialBackend as never),
      backend: new MemoryBackend<PoolData<MoarkPoolAccount>>() as never,
    })
    modelSettings = new FileModelSettingsStore(modelFile)
    emitted = []
    upstream = async () => Response.json(MODELS)

    setupRoutes = async (extra = {}) => {
      const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
      const ctx = {
        webServer: {
          register(route: (typeof routes)[number]) {
            routes.push(route)
            return () => undefined
          },
        },
        emit: (event: unknown) => {
          emitted.push(event)
        },
      } as unknown as Context
      registerMoarkRoutes(ctx, {
        accountPool,
        modelSettings,
        fetchFn: (async () => upstream()) as unknown as typeof fetch,
        ...extra,
      })
      return async (init) => {
        const { response, captured } = fakeExchange()
        await routes[0]!.handler(fakeRequest(init), response)
        return captured
      }
    }
    respond = await setupRoutes()
  })

  afterEach(async () => {
    await fs.rm(modelFile, { force: true }).catch(() => undefined)
  })

  function path_(suffix = ''): string {
    return `${MOARK_ROUTE_PREFIX}${suffix}`
  }

  function expectEnvelope(captured: Captured, status: number): void {
    expect(captured.raw, 'the route wrote no body at all').not.toBeNull()
    expect(captured.status).toBe(status)
    expect(typeof captured.body.ok).toBe('boolean')
  }

  /** Store one token through the route, which is how a user does it. */
  async function addToken(apiKey = 'secret-token', alias = 'work'): Promise<Captured> {
    return respond({ url: path_('/accounts'), method: 'POST', body: { action: 'add', apiKey, alias } })
  }

  it('answers the initial status with no token and no catalogue', async () => {
    const captured = await respond({ url: path_('/status') })
    expectEnvelope(captured, 200)
    const value = captured.body.value as { models: unknown[]; usable: boolean; catalogSynced: boolean; defaultWire: string; keyUrl: string }
    expect(value.models).toEqual([])
    expect(value.usable).toBe(false)
    expect(value.catalogSynced).toBe(false)
    expect(value.defaultWire).toBe('openai')
    expect(value.keyUrl).toBe(MOARK_KEYS_URL)
  })

  it('stores an access token and never echoes it back', async () => {
    const added = await addToken()
    expectEnvelope(added, 200)
    const value = added.body.value as { pool: { accounts: Array<{ alias: string }> }; usable: boolean }
    expect(value.pool.accounts).toHaveLength(1)
    expect(value.pool.accounts[0]!.alias).toBe('work')
    expect(value.usable).toBe(true)
    // The credential must not appear anywhere in the payload the browser reads.
    expect(JSON.stringify(added.body)).not.toContain('secret-token')
  })

  it('refuses an add with no token', async () => {
    const captured = await respond({ url: path_('/accounts'), method: 'POST', body: { action: 'add', apiKey: '   ' } })
    expectEnvelope(captured, 400)
    expect(String(captured.body.error)).toBe('Access token is required.')
  })

  it('rejects a cross-origin mutation on every writing route', async () => {
    for (const [suffix, body] of [
      ['/settings', { enabled: false }],
      ['/accounts', { action: 'add', apiKey: 'x' }],
      ['/models', { enabledModelIds: null }],
      ['/catalog/refresh', {}],
    ] as const) {
      const captured = await respond({ url: path_(suffix), method: 'POST', body, origin: 'http://evil.example' })
      expectEnvelope(captured, 403)
    }
  })

  it('syncs the catalogue and keeps only chat-capable models', async () => {
    await addToken()
    emitted.length = 0
    const captured = await respond({ url: path_('/catalog/refresh'), method: 'POST', body: {} })
    expectEnvelope(captured, 200)
    const value = captured.body.value as { models: Array<{ id: string }> }
    expect(value.models.map((model) => model.id)).toEqual(['DeepSeek-V4-Pro', 'GLM-5.3'])
    // The picker learns the offer changed only through this event; without it a
    // freshly synced catalogue stays invisible until something unrelated emits.
    expect(emitted).toContain('llm/adapters-updated')
  })

  it('announces a new token, which is what first makes the line listable at all', async () => {
    emitted.length = 0
    await addToken()
    expect(emitted).toContain('llm/adapters-updated')
  })

  it('reports whether this plugin owns the provider route', async () => {
    // Default: owned. A refused claim (another adapter already serves `moark`)
    // is the state that leaves the card working while the model picker shows
    // none of this line's models — so it has to be visible.
    const owned = await respond({ url: path_('/status') })
    const ownedValue = owned.body.value as { serving: boolean; conflict: string | null }
    expect(ownedValue.serving).toBe(true)
    expect(ownedValue.conflict).toBeNull()

    const contested = await setupRoutes({
      serving: () => false,
      conflict: () => 'an adapter for provider "moark" is already registered',
    })
    const refused = await contested({ url: path_('/status') })
    const refusedValue = refused.body.value as { serving: boolean; conflict: string | null }
    expect(refusedValue.serving).toBe(false)
    expect(refusedValue.conflict).toContain('already registered')
  })

  it('asks for a token rather than syncing without one', async () => {
    const captured = await respond({ url: path_('/catalog/refresh'), method: 'POST', body: {} })
    expectEnvelope(captured, 400)
    expect(String(captured.body.error)).toContain('Add an access token before syncing models')
  })

  it('names a rejected token apart from an unreachable host', async () => {
    await addToken()
    upstream = async () => new Response('nope', { status: 401 })
    const unauthorized = await respond({ url: path_('/catalog/refresh'), method: 'POST', body: {} })
    expectEnvelope(unauthorized, 502)
    expect(String(unauthorized.body.error)).toContain('rejected the stored access token')

    upstream = async () => {
      throw new Error('ECONNREFUSED')
    }
    const unreachable = await respond({ url: path_('/catalog/refresh'), method: 'POST', body: {} })
    expectEnvelope(unreachable, 502)
    expect(String(unreachable.body.error)).toContain('Could not reach MoArk')
  })

  it('reports a sync whose list could not be saved locally', async () => {
    await addToken()
    // A directory where the settings file should be makes the write fail while
    // the read succeeded, which is a different remedy from a failed read.
    const blocked = tmpFile('moark-models-blocked')
    await fs.mkdir(blocked, { recursive: true })
    const settings = new FileModelSettingsStore(path.join(blocked, 'nested', 'file.json'))
    const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    const ctx = {
      webServer: { register(route: (typeof routes)[number]) { routes.push(route); return () => undefined } },
      emit: () => undefined,
    } as unknown as Context
    registerMoarkRoutes(ctx, { accountPool, modelSettings: settings, fetchFn: (async () => Response.json(MODELS)) as unknown as typeof fetch })
    const { response, captured } = fakeExchange()
    await routes[0]!.handler(fakeRequest({ url: path_('/catalog/refresh'), method: 'POST', body: {} }), response)
    expectEnvelope(captured, 200)
    await fs.rm(blocked, { recursive: true, force: true }).catch(() => undefined)
  })

  it('stores the tri-state model selection, including the explicit none', async () => {
    await addToken()
    await respond({ url: path_('/catalog/refresh'), method: 'POST', body: {} })

    const none = await respond({ url: path_('/models'), method: 'POST', body: { enabledModelIds: [] } })
    expectEnvelope(none, 200)
    // An empty array is a real value here — every model off — and must not be
    // read back as 'no filter'.
    expect((none.body.value as { enabledModelIds: string[] | null }).enabledModelIds).toEqual([])

    const all = await respond({ url: path_('/models'), method: 'POST', body: { enabledModelIds: null } })
    expect((all.body.value as { enabledModelIds: string[] | null }).enabledModelIds).toBeNull()
  })

  it('switches the protocol surface and refuses an unknown one', async () => {
    const ok = await respond({ url: path_('/settings'), method: 'POST', body: { defaultWire: 'anthropic' } })
    expectEnvelope(ok, 200)
    expect((ok.body.value as { defaultWire: string }).defaultWire).toBe('anthropic')
    expect(emitted).toContain('llm/adapters-updated')

    const bad = await respond({ url: path_('/settings'), method: 'POST', body: { defaultWire: 'gemini' } })
    expectEnvelope(bad, 400)
    expect(String(bad.body.error)).toBe('Unsupported protocol surface.')
    // The stored value is untouched by the refusal.
    expect((await getMoarkWebStatus({ accountPool, modelSettings })).defaultWire).toBe('anthropic')
  })

  it('toggles the line switch through /settings and announces it', async () => {
    const captured = await respond({ url: path_('/settings'), method: 'POST', body: { enabled: false } })
    expectEnvelope(captured, 200)
    expect(emitted).toContain('llm/adapters-updated')
    expect((await modelSettings.read()).enabled).toBe(false)
  })

  it('manages pooled accounts and keeps the credential out of every reply', async () => {
    const first = await addToken('token-one', 'one')
    const firstId = (first.body.value as { pool: { accounts: Array<{ id: string }> } }).pool.accounts[0]!.id
    await addToken('token-two', 'two')

    const renamed = await respond({ url: path_('/accounts'), method: 'POST', body: { action: 'set-alias', accountId: firstId, alias: 'renamed' } })
    const accounts = (renamed.body.value as { pool: { accounts: Array<{ id: string; alias: string }> } }).pool.accounts
    expect(accounts).toHaveLength(2)
    expect(accounts.find((account) => account.id === firstId)!.alias).toBe('renamed')

    const strategy = await respond({ url: path_('/accounts'), method: 'POST', body: { action: 'strategy', strategy: 'round-robin' } })
    expect((strategy.body.value as { pool: { rotationStrategy: string } }).pool.rotationStrategy).toBe('round-robin')

    const deleted = await respond({ url: path_('/accounts'), method: 'POST', body: { action: 'delete', accountId: firstId } })
    expect((deleted.body.value as { pool: { accounts: unknown[] } }).pool.accounts).toHaveLength(1)
    expect(JSON.stringify(deleted.body)).not.toContain('token-two')
  })

  it('clears a cooldown through the account route', async () => {
    const added = await addToken()
    const id = (added.body.value as { pool: { accounts: Array<{ id: string }> } }).pool.accounts[0]!.id
    await accountPool.markCooldown(id, 60_000, '429')
    expect((await getMoarkWebStatus({ accountPool, modelSettings })).usable).toBe(false)
    const cleared = await respond({ url: path_('/accounts'), method: 'POST', body: { action: 'clear-cooldown', accountId: id } })
    expectEnvelope(cleared, 200)
    expect((await getMoarkWebStatus({ accountPool, modelSettings })).usable).toBe(true)
  })

  it('refuses an unknown account action without taking the tab down', async () => {
    const added = await addToken()
    const id = (added.body.value as { pool: { accounts: Array<{ id: string }> } }).pool.accounts[0]!.id
    const captured = await respond({ url: path_('/accounts'), method: 'POST', body: { action: 'explode', accountId: id } })
    expectEnvelope(captured, 400)
    expect(String(captured.body.error)).toBe('Unsupported account action.')
  })

  it('requires an accountId for every action that acts on one', async () => {
    const captured = await respond({ url: path_('/accounts'), method: 'POST', body: { action: 'delete' } })
    expectEnvelope(captured, 400)
    expect(String(captured.body.error)).toBe('accountId is required.')
  })

  it('answers 404 for an unknown sub-path and 405 for a wrong method', async () => {
    expectEnvelope(await respond({ url: path_('/nope') }), 404)
    expectEnvelope(await respond({ url: path_('/settings'), method: 'GET' }), 405)
  })

  it('reports pool status through GET /accounts like every sibling line', async () => {
    const captured = await respond({ url: path_('/accounts'), method: 'GET' })
    expectEnvelope(captured, 200)
    expect(captured.body.value).toMatchObject({ models: [], usable: false })
  })
})

describe('MoArk status assembly', () => {
  function isolatedPool(): MoarkAccountPool {
    return new MoarkAccountPool({
      store: new FileCredentialStore(tmpFile('moark-credential-status'), new MemoryBackend<MoarkCredentials>() as never),
      backend: new MemoryBackend<PoolData<MoarkPoolAccount>>() as never,
    })
  }

  it('treats a cooling account as unusable and a healthy one as usable', async () => {
    const pool = isolatedPool()
    const settingsFile = tmpFile('moark-models-status')
    const settings = new FileModelSettingsStore(settingsFile)
    const credentials: MoarkCredentials = { apiKey: 'token', addedAt: Date.now() }
    await pool.addAccount(credentials, 'one')

    expect((await getMoarkWebStatus({ accountPool: pool, modelSettings: settings })).usable).toBe(true)

    const account = (await pool.listAccounts())[0]!
    await pool.markCooldown(account.id, 60_000, '429')
    expect((await getMoarkWebStatus({ accountPool: pool, modelSettings: settings })).usable).toBe(false)
    await fs.rm(settingsFile, { force: true }).catch(() => undefined)
  })

  it('survives a settings file that cannot be parsed', async () => {
    const pool = isolatedPool()
    const broken = tmpFile('moark-models-broken')
    await fs.writeFile(broken, '{not json', 'utf8')
    const status = await getMoarkWebStatus({ accountPool: pool, modelSettings: new FileModelSettingsStore(broken) })
    expect(status.catalogSynced).toBe(false)
    expect(status.defaultWire).toBe('openai')
    expect(status.models).toEqual([])
    await fs.rm(broken, { force: true }).catch(() => undefined)
  })
})
