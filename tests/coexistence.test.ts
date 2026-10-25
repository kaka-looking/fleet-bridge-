import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { Runtime } from '../src/main/runtime'
import { Store } from '../src/main/store'
import { PRESETS } from '../src/shared/presets'
import { modelSlug } from '../src/main/catalog'
import { DesktopPreferences } from '../src/main/desktop-preferences'

const temp = () => mkdtempSync(join(tmpdir(), 'fleet-coexist-'))
const cipher = { label: 'test', encrypt: (value: string) => value, decrypt: (value: string) => value }

describe('Codex desktop Max preference', () => {
  it('enables Max without losing desktop state and restores a previously absent setting', () => {
    const preferences = new DesktopPreferences(temp())
    writeFileSync(preferences.path, JSON.stringify({ history: [1], 'electron-persisted-atom-state': { theme: 'light' } }))
    const backup = preferences.capture()
    expect(preferences.enabled()).toBe(false)
    preferences.enable(backup)
    expect(preferences.enabled()).toBe(true)
    const changed = JSON.parse(readFileSync(preferences.path, 'utf8')); changed.history.push(2)
    writeFileSync(preferences.path, JSON.stringify(changed))
    preferences.restore(backup)
    expect(JSON.parse(readFileSync(preferences.path, 'utf8'))).toEqual({ history: [1, 2], 'electron-persisted-atom-state': { theme: 'light' } })
  })
  it('preserves preexisting Max and unrelated user preference edits', () => {
    const preferences = new DesktopPreferences(temp())
    writeFileSync(preferences.path, JSON.stringify({ 'electron-persisted-atom-state': { 'enabled-reasoning-efforts': ['low', 'max'] } }))
    const backup = preferences.capture(); preferences.enable(backup)
    const changed = JSON.parse(readFileSync(preferences.path, 'utf8'))
    changed['electron-persisted-atom-state']['enabled-reasoning-efforts'].push('high')
    writeFileSync(preferences.path, JSON.stringify(changed)); preferences.restore(backup)
    expect(JSON.parse(readFileSync(preferences.path, 'utf8'))['electron-persisted-atom-state']['enabled-reasoning-efforts']).toEqual(['low', 'max', 'high'])
  })
  it('restores both the exact original Codex config and the Max preference after reconnecting', () => {
    const home = temp(); const store = new Store(temp(), cipher); store.save(PRESETS.deepseek)
    const original = '# original\nmodel="gpt-test"\n'
    writeFileSync(join(home, 'config.toml'), original)
    const runtime = new Runtime(store, home)
    runtime.codex.connect(); runtime.codex.connect()
    expect(runtime.codex.desktop.enabled()).toBe(true)
    runtime.codex.restore()
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(original)
    expect(runtime.codex.desktop.enabled()).toBe(false)
  })
})

describe('original GPT connection with independent provider switches', () => {
  it('routes original Responses and three Chat providers to separate endpoints, rejects disabled routes, and restores the original', async () => {
    const received: { path?: string; model: string; auth?: string }[] = []
    const upstream = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json')
      if (request.method === 'GET') { response.end(JSON.stringify({ data: [{ id: 'gpt-one' }, { id: 'gpt-two' }] })); return }
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw); received.push({ path: request.url, model: body.model, auth: request.headers.authorization })
      if (request.url?.endsWith('/responses')) response.end(JSON.stringify({ id: 'resp_original', object: 'response', status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 1 } }))
      else response.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    })
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
    const base = `http://127.0.0.1:${(upstream.address() as any).port}`
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
    const port = (probe.address() as any).port; await new Promise<void>(resolve => probe.close(() => resolve()))
    const home = temp(); const store = new Store(temp(), cipher); store.setSettings({ ...store.settings, port })
    const original = `# original GPT API\nmodel="gpt-one"\nmodel_provider="baseline"\napproval_policy="on-request"\n[model_providers.baseline]\nname="Original fixture"\nbase_url="${base}/gpt"\nwire_api="responses"\nexperimental_bearer_token="original-key"\n`
    writeFileSync(join(home, 'config.toml'), original)
    const runtime = new Runtime(store, home)
    try {
      for (const [kind, key] of [['deepseek', 'ds-key'], ['glm', 'glm-key'], ['kimi', 'kimi-key']] as const) {
        store.save({ ...PRESETS[kind], baseUrl: `${base}/${kind}`, apiKey: key })
      }
      await runtime.connectCodex()
      const catalog = JSON.parse(readFileSync(runtime.codex.catalogPath, 'utf8'))
      expect(catalog.models.map((model: any) => model.slug)).toEqual(expect.arrayContaining(['gpt-one', 'gpt-two', ...store.providers.flatMap(provider => provider.models.map(model => modelSlug(provider, model)))]))
      const call = async (model: string) => {
        const response = await fetch(`${runtime.gateway.url}/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${store.token}` }, body: JSON.stringify({ model, input: 'hi', reasoning: { effort: 'max' } }) })
        await response.text(); return response.status
      }
      expect(await call('gpt-two')).toBe(200)
      expect(received.at(-1)).toEqual({ path: '/gpt/responses', model: 'gpt-two', auth: 'Bearer original-key' })
      for (const provider of store.providers) {
        expect(await call(modelSlug(provider, provider.defaultModel))).toBe(200)
        expect(received.at(-1)?.path).toBe(`/${provider.kind}/chat/completions`)
        expect(received.at(-1)?.auth).toBe(`Bearer ${{ deepseek: 'ds-key', glm: 'glm-key', kimi: 'kimi-key' }[provider.kind as 'deepseek' | 'glm' | 'kimi']}`)
      }
      const disabled = store.providers[0]
      runtime.setProviderEnabled(disabled.id, false)
      expect(store.activeProviderId).not.toBe(disabled.id)
      expect(await call(modelSlug(disabled, disabled.defaultModel))).toBe(400)
      expect(readFileSync(runtime.codex.catalogPath, 'utf8')).not.toContain(modelSlug(disabled, disabled.defaultModel))
      runtime.setOriginalEnabled(false)
      expect(await call('gpt-one')).toBe(400)
      runtime.setOriginalEnabled(true); runtime.setProviderEnabled(disabled.id, true)
      expect(await call('gpt-one')).toBe(200)
      for (const provider of store.providers) runtime.setProviderEnabled(provider.id, false)
      expect(store.activeProviderId).toBeNull()
      runtime.codex.connect()
      expect(await call('fleet/default')).toBe(200)
      expect(received.at(-1)?.path).toBe('/gpt/responses')
      for (const provider of store.providers) runtime.setProviderEnabled(provider.id, true)
      const changed = parse(readFileSync(runtime.codex.path, 'utf8')) as any; changed.personality = 'friendly'
      writeFileSync(runtime.codex.path, stringify(changed)); runtime.codex.restore()
      const restored = parse(readFileSync(runtime.codex.path, 'utf8')) as any
      expect(restored).toMatchObject({ model_provider: 'baseline', model: 'gpt-one', personality: 'friendly', approval_policy: 'on-request' })
      expect(restored.model_providers.baseline.experimental_bearer_token).toBe('original-key')
      expect(restored.model_providers.fleet_bridge).toBeUndefined()
      expect(store.providers).toHaveLength(3)
      expect(existsSync(runtime.codex.backupPath)).toBe(false)
    } finally {
      await runtime.gateway.stop()
      await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections() })
    }
  })
})
