import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type z from '@deepseek-ai/schemastery'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import * as platformStore from '../src/host/platform-token-store.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { PREFERENCES_NAMESPACE } from '../src/shared/preferences.ts'
import { ANTIGRAVITY_PREFERENCES_NAMESPACE } from '../src/host/antigravity/token-store.ts'
import { COMMAND_CODE_PREFERENCES_NAMESPACE } from '../src/host/command-code/token-store.ts'
import { MOARK_ROUTE_PREFIX } from '../src/shared/moark-contracts.ts'

type SettingsValue = Record<string, unknown>
type Route = { path: string; handler: (request: IncomingMessage, response: ServerResponse) => unknown }

const disposers: Array<() => void> = []

beforeEach(() => {
  // The catalogue read is the only upstream call this suite can trigger; every
  // other behaviour answers from local storage.
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ object: 'list', data: [] })) as unknown as typeof fetch)
})

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

interface MountResult {
  routes: Route[]
  adapters: Map<string, LlmAdapter>
  owners: Set<string>
  hubSources: Array<Record<string, unknown>>
}

/**
 * Mount the whole plugin against a hand-built cordis context.
 *
 * This is the only test that exercises the REGISTRATION path rather than a unit:
 * a line is not actually added until `apply()` claims its provider route, hangs
 * its settings prefix off the web server and appends its hub summary — and every
 * one of those is a place a new line is silently forgotten.
 */
function mountPlugin(preOwned: string[] = []): MountResult {
  const routes: Route[] = []
  const adapters = new Map<string, LlmAdapter>()
  const owners = new Set<string>(preOwned)
  const listeners = new Map<string, Set<() => void>>()
  const settings = new Map<string, { get: () => SettingsValue; update: (patch: SettingsValue) => Promise<void> }>()
  const services: Record<string, unknown> = {}
  const ctx = {
    effect: (setup: () => () => void) => { disposers.push(setup()) },
    inject: (_deps: string[], setup: (scope: Context) => void): void => setup(ctx as unknown as Context),
    get: (name: string) => services[name],
    on: (event: string, listener: () => void) => {
      const bucket = listeners.get(event) ?? new Set<() => void>()
      listeners.set(event, bucket)
      bucket.add(listener)
      return () => { bucket.delete(listener) }
    },
    emit: (event: string) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener()
    },
    settings: {
      register(namespace: string, schema: z<SettingsValue>) {
        let value = schema(namespace === PREFERENCES_NAMESPACE
          ? { proxyMode: 'direct' }
          : {})
        const scope = {
          get: () => value,
          update: async (patch: SettingsValue) => { value = schema({ ...value, ...patch }) },
          watch: () => () => undefined,
        }
        settings.set(namespace, scope)
        return scope
      },
    },
    llm: {
      registerAdapter(providers: string[], adapter: LlmAdapter) {
        for (const provider of providers) {
          if (owners.has(provider)) {
            const error = new Error(`an adapter for provider "${provider}" is already registered`)
            ;(error as { code?: string }).code = 'DUPLICATE_ADAPTER'
            throw error
          }
        }
        for (const provider of providers) { owners.add(provider); adapters.set(provider, adapter) }
        return () => { for (const provider of providers) { owners.delete(provider); adapters.delete(provider) } }
      },
    },
    webServer: {
      host: '127.0.0.1',
      port: 3000,
      register(route: Route) { routes.push(route); return () => undefined },
    },
    tools: { register: () => () => undefined },
    web: { registerSearchProvider: () => () => undefined, registerFetchProvider: () => () => undefined },
    attachments: {},
    loader: { entries: () => [] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  Object.assign(services, {
    llm: ctx.llm,
    webServer: ctx.webServer,
    tools: ctx.tools,
    attachments: ctx.attachments,
    loader: ctx.loader,
    settings: { installSection: () => undefined },
  })

  const codexStore = new MemoryTokenStore()
  void codexStore.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 })
  vi.spyOn(platformStore, 'createPlatformTokenStore').mockReturnValue(codexStore)

  apply(ctx as unknown as Context)

  // The hub summary sources are the array passed to registerHubOverviewRoutes;
  // they are not on the ctx double, so the overview route is asked instead.
  return { routes, adapters, owners, hubSources: [] }
}

async function callRoute(
  plugin: MountResult,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; body: { ok: boolean; value?: Record<string, unknown>; error?: string } }> {
  let status = 0
  let payload = ''
  const route = plugin.routes.find((candidate) => candidate.path === MOARK_ROUTE_PREFIX)
  expect(route, `no route registered for ${MOARK_ROUTE_PREFIX}`).toBeDefined()
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  await route!.handler(
    {
      url: path,
      method,
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    } as unknown as IncomingMessage,
    {
      writeHead: (value: number) => { status = value },
      end: (value: string) => { payload = value },
    } as unknown as ServerResponse,
  )
  return { status, body: JSON.parse(payload) as { ok: boolean } }
}

describe('MoArk plugin registration', () => {
  it('claims the moark provider route and mounts the settings prefix', () => {
    const plugin = mountPlugin()
    expect(plugin.owners.has('moark')).toBe(true)
    expect(plugin.adapters.get('moark')).toBeDefined()
    // The adapter must present itself under the line's own display name.
    expect(plugin.adapters.get('moark')!.providerInfo('moark').name).toContain('MoArk')
    expect(plugin.routes.some((route) => route.path === MOARK_ROUTE_PREFIX)).toBe(true)
  })

  it('does NOT claim a route another adapter owns, and still mounts its settings surface', () => {
    // A contested id must not take the settings page down with it: the card is
    // how a user configures the line at all.
    const plugin = mountPlugin(['moark'])
    expect(plugin.routes.some((route) => route.path === MOARK_ROUTE_PREFIX)).toBe(true)
  })

  it('answers its own status route through the real registration', async () => {
    const plugin = mountPlugin()
    const response = await callRoute(plugin, '/moark/api/status')
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    const value = response.body.value as { defaultWire: string; models: unknown[]; keyUrl: string }
    expect(value.defaultWire).toBe('openai')
    expect(value.models).toEqual([])
    expect(value.keyUrl).toContain('moark.com')
  })

  it('accepts a token through the registered accounts route, without echoing it', async () => {
    const plugin = mountPlugin()
    const response = await callRoute(plugin, '/moark/api/accounts', 'POST', {
      action: 'add',
      apiKey: 'registered-token',
      alias: 'from-test',
    })
    expect(response.status).toBe(200)
    const value = response.body.value as { pool: { accounts: Array<{ alias: string }> } }
    expect(value.pool.accounts).toHaveLength(1)
    expect(JSON.stringify(response.body)).not.toContain('registered-token')
  })

  it('reaches the strategy action, which needs no account id', async () => {
    // Regression guard for the defect the Ollama line still has: with the
    // accountId check first, this action answers 'accountId is required.' and the
    // rotation picker can never commit.
    const plugin = mountPlugin()
    await callRoute(plugin, '/moark/api/accounts', 'POST', { action: 'add', apiKey: 'token', alias: 'one' })
    const response = await callRoute(plugin, '/moark/api/accounts', 'POST', { action: 'strategy', strategy: 'round-robin' })
    expect(response.status).toBe(200)
    expect((response.body.value as { pool: { rotationStrategy: string } }).pool.rotationStrategy).toBe('round-robin')
  })

  it('serves the hub overview with a moark entry alongside every other line', async () => {
    const plugin = mountPlugin()
    const route = plugin.routes.find((candidate) => candidate.path.endsWith('/hub/overview'))
    expect(route, 'the hub overview route is not mounted').toBeDefined()
    let payload = ''
    await route!.handler(
      { url: '/api/dsh-chatgpt-subscription/hub/overview', method: 'GET', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' } } as unknown as IncomingMessage,
      {
        writeHead: () => undefined,
        end: (value: string) => { payload = value },
      } as unknown as ServerResponse,
    )
    const body = JSON.parse(payload) as { ok: boolean; value: { providers: Array<{ id: string; canToggle: boolean }> } }
    expect(body.ok).toBe(true)
    const ids = body.value.providers.map((provider) => provider.id)
    expect(ids).toContain('moark')
    // MoArk has a line switch on the host, like every line but Ollama.
    expect(body.value.providers.find((provider) => provider.id === 'moark')!.canToggle).toBe(true)
    // And it did not displace a sibling: every pre-existing line is still there.
    for (const id of ['chatgpt', 'ollama', 'glm-coding-plan', 'claude']) expect(ids).toContain(id)
  })
})

// The preference namespaces are imported so the module graph under test is the
// same one production builds; they are otherwise unused here.
void ANTIGRAVITY_PREFERENCES_NAMESPACE
void COMMAND_CODE_PREFERENCES_NAMESPACE
