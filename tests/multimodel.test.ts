import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRESETS } from '../src/shared/presets'
import { modelCapabilities } from '../src/shared/model-capabilities'
import type { ModelCapabilities, Provider } from '../src/shared/types'
import { applyReasoning } from '../src/main/reasoning'
import { buildCatalog, modelSlug } from '../src/main/catalog'
import { Store } from '../src/main/store'
import { Runtime } from '../src/main/runtime'
import { DesktopPreferences } from '../src/main/desktop-preferences'
import { discoverModelDetails, testConnection } from '../src/main/gateway'

const temp = () => mkdtempSync(join(tmpdir(), 'fleet-models-'))
const cipher = { label: 'test', encrypt: (value: string) => value, decrypt: (value: string) => value }
const relay = (model: string, metadata?: ModelCapabilities): Provider => ({
  ...PRESETS.custom, id: 'relay', name: 'Relay', baseUrl: 'http://127.0.0.1:1/v1', apiKeySet: false,
  models: [model], defaultModel: model, ...(metadata ? { modelCapabilities: { [model]: metadata } } : {})
})
function body(provider: Provider, effort?: string, native = false) {
  const request = { reasoning: { effort, summary: 'auto' } }
  const result: any = native ? structuredClone(request) : {}
  applyReasoning(request, result, provider, provider.defaultModel, native)
  return result
}

describe('per-model reasoning contracts on custom endpoints', () => {
  it.each(['glm-5.3', 'global:glm-5.3', 'vendor/glm-5.3-FLASH'])('advertises and forwards the three real GLM levels for %s', model => {
    const provider = relay(model)
    expect(modelCapabilities(provider, model).reasoningEfforts).toEqual(['low', 'high', 'max'])
    for (const effort of ['low', 'high', 'max']) expect(body(provider, effort)).toEqual({ reasoning_effort: effort, thinking: { type: 'enabled' } })
    expect(body(provider, 'medium').reasoning_effort).toBe('high')
    expect(body(provider, 'ultra').reasoning_effort).toBe('max')
    expect(() => body(provider, 'none')).toThrow('不支持关闭')
  })
  it('distinguishes GLM 4.7 toggles and GLM 5.2 canonical efforts', () => {
    expect(body(relay('glm-4.7'), 'high')).toEqual({ thinking: { type: 'enabled' } })
    expect(body(relay('glm-4.7'), 'none')).toEqual({ thinking: { type: 'disabled' } })
    expect(body(relay('glm-5.2'), 'xhigh').reasoning_effort).toBe('max')
    expect(body(relay('glm-5.2'), 'minimal')).toEqual({ thinking: { type: 'disabled' } })
  })
  it('handles Kimi toggle models, required thinking models and K3 effort separately', () => {
    const kimi = relay('global:kimi-k2.5')
    expect(modelCapabilities(kimi, kimi.defaultModel).reasoningEfforts).toEqual(['none', 'high'])
    expect(body(kimi, 'ultra')).toEqual({ thinking: { type: 'enabled' } })
    expect(body(kimi, 'none')).toEqual({ thinking: { type: 'disabled' } })
    expect(body(relay('kimi-k2.7-code'), 'high')).toEqual({})
    expect(() => body(relay('kimi-k2.7-code'), 'none')).toThrow('不支持关闭')
    for (const effort of ['low', 'high', 'max']) expect(body(relay('kimi-k3.1-pro'), effort)).toEqual({ reasoning_effort: effort })
  })
  it('recognizes Qwen on custom interfaces and keeps MiniMax thinking-only models free of fake effort parameters', () => {
    expect(body(relay('qwen-plus'), 'high')).toEqual({ enable_thinking: true })
    expect(body(relay('global:qwen3.8-max'), 'none')).toEqual({ enable_thinking: false })
    expect(body(relay('MiniMax-M2.5'), 'high')).toEqual({})
    expect(body(relay('MiniMax-M3.1-Flash'), 'xhigh')).toEqual({ reasoning_effort: 'xhigh' })
    expect(() => body(relay('MiniMax-M2.5'), 'none')).toThrow('不支持关闭')
  })
  it('honors relay metadata, including Ultra, instead of normalizing it away based on the brand name', () => {
    const provider = relay('global:deepseek-v4.1-flash', { reasoningEfforts: ['ultra', 'low', 'high'], defaultReasoningEffort: 'ultra' })
    expect(modelCapabilities(provider, provider.defaultModel).reasoningEfforts).toEqual(['low', 'high', 'ultra'])
    expect(body(provider, 'ultra').reasoning_effort).toBe('ultra')
    const unknown = relay('future-reasoner', { reasoningEfforts: ['high', 'max', 'ultra'] })
    expect(body(unknown, 'ultra')).toEqual({ reasoning_effort: 'ultra' })
  })
  it.each([
    ['global:deepseek-v4.1-flash', 'max'],
    ['global:glm-5.3', 'max'],
    ['kimi-k3', 'max'],
    ['MiniMax-M3.1-Flash', 'max']
  ])('maximum policy selects the highest supported effort for %s', (model, expected) => {
    const provider = { ...relay(model), thinking: 'max' as const }
    expect(body(provider, 'low').reasoning_effort).toBe(expected)
    expect(modelCapabilities(provider, model).reasoningEfforts).toEqual([expected])
  })
  it('maximum policy forwards Ultra when declared and handles toggle-only models without inventing an effort parameter', () => {
    const future = { ...relay('future', { reasoningEfforts: ['ultra', 'high', 'low'] }), thinking: 'max' as const }
    expect(body(future, 'none')).toEqual({ reasoning_effort: 'ultra' })
    expect(body(future, 'low', true)).toEqual({ reasoning: { effort: 'ultra', summary: 'auto' } })
    expect(body({ ...relay('kimi-k2.5'), thinking: 'max' }, 'low')).toEqual({ thinking: { type: 'enabled' } })
    expect(body({ ...relay('MiniMax-M2.5'), thinking: 'max' }, 'low')).toEqual({})
    expect(() => body({ ...relay('unknown'), thinking: 'max' }, 'low')).toThrow('未声明推理能力')
  })
  it('preserves Responses fields and applies per-model validation', () => {
    expect(body(relay('glm-5.3'), 'ultra', true)).toEqual({ reasoning: { effort: 'max', summary: 'auto' } })
    expect(body(relay('kimi-k2.5'), 'none', true)).toEqual({ reasoning: { effort: 'none', summary: 'auto' } })
    expect(body({ ...relay('deepseek-v4.1-flash'), thinking: 'off' }, 'max', true)).toEqual({ reasoning: { effort: 'none', summary: 'auto' } })
  })
  it('keeps manual capabilities across save, upstream refresh and reload', () => {
    const store = new Store(temp(), cipher)
    const model = 'future'
    const provider = relay(model, { reasoningOverride: true, reasoningEfforts: ['high', 'ultra'], defaultReasoningEffort: 'ultra', thinkingControl: 'none' })
    const id = store.save({ ...provider, id: undefined, thinking: 'max' })
    store.saveModelCapabilities(id, [{ id: model, contextWindow: 500000, reasoningEfforts: ['low', 'max'] }])
    const saved = new Store(store.directory, cipher).getProvider(id)
    expect(modelCapabilities(saved, model)).toMatchObject({ contextWindow: 500000, reasoningEfforts: ['ultra'] })
    expect(body(saved, 'low').reasoning_effort).toBe('ultra')
    expect(() => store.save({ ...relay('glm-5.3'), id: undefined, thinking: 'off' })).toThrow('不能选择关闭')
  })
})

describe('catalog presentation and desktop preferences', () => {
  it('lists each route once, hides the compatibility alias, and preserves distinct API routes', () => {
    const a = relay('global:deepseek-v4.1-flash')
    a.models.push(a.defaultModel)
    const b = { ...a, id: 'other', name: 'Other API' }
    const models = buildCatalog([a, b], a.id).models
    expect(models.filter(model => model.visibility === 'list').map(model => model.slug)).toEqual([modelSlug(a, a.defaultModel), modelSlug(b, b.defaultModel)])
    expect(models[0]).toMatchObject({ slug: 'fleet/default', visibility: 'hide' })
    expect(models[1].display_name).toBe('DeepSeek v4.1-flash · Relay')
    expect(models[1].description).toContain('global:deepseek-v4.1-flash')
  })
  it('enables only required efforts and Ultra display, then restores unrelated desktop edits', () => {
    const desktop = new DesktopPreferences(temp())
    const root = 'electron-persisted-atom-state'
    writeFileSync(desktop.path, JSON.stringify({ [root]: { 'enabled-reasoning-efforts': ['high'], 'show-ultra-in-model-picker-slider': false, theme: 'dark' } }))
    let backup = desktop.prepare(undefined, ['none', 'high', 'max', 'ultra'])
    desktop.enable(backup, ['none', 'high', 'max', 'ultra'])
    backup = desktop.prepare(backup, ['minimal']); desktop.enable(backup, ['minimal'])
    const changed = JSON.parse(readFileSync(desktop.path, 'utf8'))
    expect(changed[root]['show-ultra-in-model-picker-slider']).toBe(true)
    changed[root]['enabled-reasoning-efforts'].push('medium')
    writeFileSync(desktop.path, JSON.stringify(changed))
    desktop.restore(backup)
    expect(JSON.parse(readFileSync(desktop.path, 'utf8'))[root]).toEqual({ 'enabled-reasoning-efforts': ['high', 'medium'], 'show-ultra-in-model-picker-slider': false, theme: 'dark' })
  })
})

describe('model discovery and actual HTTP parameters', () => {
  it('discovers relay capabilities and verifies different manufacturers through HTTP without invalid disabled-thinking probes', async () => {
    const received: any[] = []
    const upstream = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json')
      if (request.method === 'GET') {
        response.end(JSON.stringify({ models: [{ slug: 'future', supported_reasoning_efforts: ['high', 'ultra'], default_reasoning_effort: 'ultra' }] }))
        return
      }
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw); received.push(body)
      // Emulate the documented strict GLM contract rather than accepting anything.
      if (body.model.includes('glm-5.3') && (body.thinking?.type === 'disabled' || (body.reasoning_effort && !['low', 'high', 'max'].includes(body.reasoning_effort)))) {
        response.statusCode = 400; response.end(JSON.stringify({ error: { message: 'invalid GLM thinking control' } })); return
      }
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    })
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
    const port = (probe.address() as any).port; await new Promise<void>(resolve => probe.close(() => resolve()))
    const store = new Store(temp(), cipher); store.setSettings({ ...store.settings, port })
    const runtime = new Runtime(store, temp())
    const baseUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1`
    try {
      expect(await discoverModelDetails(baseUrl, '')).toEqual([{ id: 'future', reasoningEfforts: ['high', 'ultra'], defaultReasoningEffort: 'ultra' }])
      await runtime.gateway.start()
      for (const model of ['global:glm-5.3', 'kimi-k2.5', 'kimi-k3', 'qwen-plus', 'future']) {
        const metadata = model === 'future' ? { reasoningEfforts: ['high', 'ultra'] as const } : undefined
        const provider = relay(model, metadata ? { reasoningEfforts: [...metadata.reasoningEfforts] } : undefined)
        const id = store.save({ ...provider, id: undefined, baseUrl, thinking: 'max' })
        const response = await fetch(`${runtime.gateway.url}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${store.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: modelSlug(store.getProvider(id), model), input: 'test', reasoning: { effort: 'low' } }) })
        expect(response.status).toBe(200); await response.text()
        expect(received.at(-1).model).toBe(model)
        if (model === 'future') expect(received.at(-1).reasoning_effort).toBe('ultra')
        else if (['kimi-k2.5', 'qwen-plus'].includes(model)) {
          expect(received.at(-1)).not.toHaveProperty('reasoning_effort')
          expect(store.logs[0].reasoningEffort).toContain(model === 'qwen-plus' ? 'true' : 'enabled')
        } else expect(received.at(-1).reasoning_effort).toBe('max')
        const tested = await testConnection({ ...store.getProvider(id), thinking: 'on' }, '')
        expect(tested.ok).toBe(true)
        if (model.includes('glm')) expect(received.at(-1).thinking).toEqual({ type: 'enabled' })
      }
    } finally {
      await runtime.gateway.stop()
      await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections() })
    }
  })
})
