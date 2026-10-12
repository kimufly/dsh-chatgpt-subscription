// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MoarkSection } from '../src/client/moark/MoarkSection.tsx'
import { dictionaries, NS_MOARK, zh, en } from '../src/client/moark/locales.ts'
import type { MoarkWebStatus } from '../src/shared/moark-contracts.ts'

const STATUS: MoarkWebStatus = {
  pool: {
    accounts: [{
      id: 'acc_1',
      alias: 'work',
      isPrimary: true,
      usage: { inputTokens: 1_500, outputTokens: 250, requestCount: 3 },
    }],
    activeAccountId: 'acc_1',
    rotationStrategy: 'sequential',
  },
  models: [
    { id: 'DeepSeek-V4-Pro', contextWindow: 128_000 },
    { id: 'GLM-5.3' },
    { id: 'qwen3.8-max', wire: 'responses' },
  ],
  enabledModelIds: null,
  defaultWire: 'openai',
  usable: true,
  catalogSynced: true,
  keyUrl: 'https://moark.com/dashboard/tokens',
  serving: true,
  conflict: null,
}

describe('MoArk settings section', () => {
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, value: STATUS }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    container?.remove()
    container = null
  })

  async function render(): Promise<ReturnType<typeof createRoot>> {
    const root = createRoot(container!)
    await act(async () => {
      root.render(<MoarkSection />)
    })
    return root
  }

  it('renders the line title, the account card and every synced model', async () => {
    const root = await render()
    expect(container!.textContent).toContain(zh.title)
    expect(container!.querySelector('.dsha-account-card')).not.toBeNull()
    expect(container!.textContent).toContain('DeepSeek-V4-Pro')
    expect(container!.textContent).toContain('GLM-5.3')
    expect(container!.textContent).toContain('qwen3.8-max')
    await act(async () => root.unmount())
  })

  it('offers one radio per protocol surface and marks the stored default', async () => {
    const root = await render()
    const radios = [...container!.querySelectorAll<HTMLInputElement>('input[name="moark-wire"]')]
    expect(radios).toHaveLength(3)
    expect(radios.map((radio) => radio.value)).toEqual(['openai', 'responses', 'anthropic'])
    expect(radios.filter((radio) => radio.checked)).toHaveLength(1)
    expect(radios.find((radio) => radio.checked)!.value).toBe('openai')
    await act(async () => root.unmount())
  })

  it('posts the chosen surface to the line settings route', async () => {
    const root = await render()
    const anthropic = container!.querySelector<HTMLInputElement>('input[value="anthropic"]')!
    await act(async () => {
      anthropic.click()
    })
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    const posted = calls.find(([url]) => String(url).endsWith('/moark/api/settings'))
    expect(posted).toBeDefined()
    expect(JSON.parse(String(posted![1].body))).toEqual({ defaultWire: 'anthropic' })
    await act(async () => root.unmount())
  })

  it('syncs the catalogue through the refresh route rather than reading it locally', async () => {
    const root = await render()
    const sync = [...container!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === zh.catalogSync)!
    await act(async () => {
      sync.click()
    })
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls
    expect(calls.some(([url]) => String(url).endsWith('/moark/api/catalog/refresh'))).toBe(true)
    await act(async () => root.unmount())
  })

  it('states the prepaid boundary instead of drawing a quota that upstream cannot report', async () => {
    const root = await render()
    // MoArk publishes no balance endpoint, so the card must say so rather than
    // render a "remaining" bar from a number nothing measured.
    expect(container!.textContent).toContain(zh.limitNoQuota)
    expect(container!.textContent).toContain(zh.limitPrepaid)
    expect(container!.textContent).toContain(zh.usageHint)
    await act(async () => root.unmount())
  })

  it('treats a partial status payload as empty blocks instead of crashing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, value: { pool: undefined, models: undefined } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    const root = await render()
    expect(container!.textContent).toContain(zh.title)
    await act(async () => root.unmount())
  })

  it('surfaces a route refusal in the card rather than as a bare crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Add an access token before syncing models.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })))
    const root = await render()
    expect(container!.textContent).toContain('Add an access token before syncing models.')
    await act(async () => root.unmount())
  })

  it('says so when another provider owns the model route', async () => {
    // The state that cost a user every model while the card looked healthy: the
    // settings surface works either way, so without this the line is
    // indistinguishable from one that simply has nothing to offer.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      value: { ...STATUS, serving: false, conflict: 'an adapter for provider "moark" is already registered' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const root = await render()
    expect(container!.textContent).toContain('模型路由已被其他 Provider 占用')
    expect(container!.textContent).toContain('already registered')
    await act(async () => root.unmount())
  })

  it('confirms ownership when this plugin serves the route', async () => {
    const root = await render()
    expect(container!.textContent).toContain(zh.routeOwned)
    await act(async () => root.unmount())
  })
})

describe('MoArk locale dictionary', () => {
  it('registers the four locale aliases the other lines do', () => {
    expect(NS_MOARK).toBe('dsh-moark')
    expect(dictionaries.zh).toBe(zh)
    expect(dictionaries['zh-CN']).toBe(zh)
    expect(dictionaries.en).toBe(en)
    expect(dictionaries['en-US']).toBe(en)
  })

  it('covers every Chinese key in English, with no empty string', () => {
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(en[key], key).toBeTypeOf('string')
      expect(en[key], key).not.toBe('')
    }
  })

  it('keeps every placeholder the section substitutes', () => {
    // The section does the substitution by hand, so a missing placeholder on
    // either side leaves a literal '{detail}' in the UI.
    for (const template of [zh.error, en.error]) expect(template).toContain('{detail}')
    for (const template of [zh.modelCount, en.modelCount]) expect(template).toContain('{count}')
    for (const template of [zh.usageInput, en.usageInput]) expect(template).toContain('{tokens}')
  })
})
