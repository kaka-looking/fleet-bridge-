import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { PRESETS } from '../src/shared/presets'
import { modelCapabilities } from '../src/shared/model-capabilities'
import type { Provider, ReasoningEffort } from '../src/shared/types'
import { Store, type Cipher } from '../src/main/store'
import { Runtime } from '../src/main/runtime'
import { buildCatalog, modelSlug } from '../src/main/catalog'
import { toChat } from '../src/main/translate'
import { applyReasoning } from '../src/main/reasoning'
import { discoverModelDetails } from '../src/main/gateway'

const provider: Provider = { ...PRESETS.deepseek, kind: 'custom', id: 'deepseek-relay', apiKeySet: false, models: ['global:deepseek-v4.1-flash'], defaultModel: 'global:deepseek-v4.1-flash' }
const cipher: Cipher = { label: 'test', encrypt: value => value, decrypt: value => value }
const temporary = () => mkdtempSync(join(tmpdir(), 'fleet-capabilities-'))

describe('model capabilities and reasoning controls', () => {
  it('advertises distinct DeepSeek effort levels for explicit and default routes', () => {
    const catalog = buildCatalog([provider], provider.id)
    for (const model of catalog.models) {
      expect(model.default_reasoning_level).toBe('high')
      expect(model.supported_reasoning_levels.map(level => level.effort)).toEqual(['low', 'high', 'max'])
      expect(model.context_window).toBe(1048576)
      expect(model.input_modalities).toEqual(['text', 'image'])
    }
    expect(modelCapabilities(provider, 'deepseek-v4-pro').vision).toBe(false)
  })
  it('prefers upstream metadata to model-name defaults and preserves unknown model settings', () => {
    const declared = { ...provider, modelCapabilities: { [provider.defaultModel]: { contextWindow: 262144, vision: false, reasoningEfforts: ['low', 'medium', 'high', 'max'] as ReasoningEffort[], defaultReasoningEffort: 'medium' as const } } }
    expect(modelCapabilities(declared, provider.defaultModel)).toEqual({ contextWindow: 262144, vision: false, reasoningEfforts: ['low', 'medium', 'high', 'max'], defaultReasoningEffort: 'medium' })
    expect(modelCapabilities({ ...provider, contextWindow: 65536, vision: true }, 'unlisted')).toMatchObject({ contextWindow: 65536, vision: true, reasoningEfforts: [], defaultReasoningEffort: 'none' })
    expect(modelCapabilities(provider, 'deepseek-chat').vision).toBe(false)
  })
  it.each(['low', 'high', 'max'] as const)('forwards the selected %s effort and enables DeepSeek thinking', effort => {
    const { body } = toChat({ input: 'test', reasoning: { effort } }, provider, provider.defaultModel)
    expect(body.reasoning_effort).toBe(effort)
    expect(body.thinking).toEqual({ type: 'enabled' })
  })
  it('normalizes documented aliases and respects forced thinking modes', () => {
    for (const [requested, expected] of [['minimal', 'low'], ['medium', 'high'], ['xhigh', 'high'], ['ultra', 'max']]) {
      expect(toChat({ input: 'test', reasoning: { effort: requested } }, provider, provider.defaultModel).body.reasoning_effort).toBe(expected)
    }
    const disabled = { ...provider, thinking: 'off' as const }
    const body = toChat({ input: 'test', reasoning: { effort: 'max' } }, disabled, provider.defaultModel).body
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(modelCapabilities(disabled, provider.defaultModel).reasoningEfforts).toEqual([])
    expect(toChat({ input: 'test', reasoning: { effort: 'none' } }, { ...provider, thinking: 'on' }, provider.defaultModel).body.reasoning_effort).toBe('high')
  })
  it('preserves native Responses reasoning fields while applying model-compatible effort', () => {
    const body = { reasoning: { effort: 'medium', summary: 'auto' } }
    applyReasoning(body, body, provider, provider.defaultModel, true)
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' })
  })
  it('uses the selected model image capability rather than a provider-wide switch', () => {
    const request = { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,test' }] }] }
    expect(() => toChat(request, { ...provider, vision: false }, provider.defaultModel)).not.toThrow()
    expect(() => toChat(request, { ...provider, vision: true }, 'deepseek-v4-pro')).toThrow('图片')
  })
  it('repairs an incompatible saved effort and restores the original value from an older backup', () => {
    const store = new Store(temporary(), cipher); store.save({ ...provider, id: undefined })
    const runtime = new Runtime(store, temporary())
    const original = 'model = "original"\nmodel_reasoning_effort = "medium"\n'
    writeFileSync(runtime.codex.path, original)
    runtime.codex.connect()
    expect((parse(readFileSync(runtime.codex.path, 'utf8')) as any).model_reasoning_effort).toBe('high')
    const backup = JSON.parse(readFileSync(runtime.codex.backupPath, 'utf8'))
    delete backup.previous.model_reasoning_effort
    writeFileSync(runtime.codex.backupPath, JSON.stringify(backup))
    runtime.codex.connect()
    const changed = parse(readFileSync(runtime.codex.path, 'utf8')) as any
    changed.personality = 'friendly'
    writeFileSync(runtime.codex.path, stringify(changed))
    runtime.codex.restore()
    expect(parse(readFileSync(runtime.codex.path, 'utf8'))).toMatchObject({ model: 'original', model_reasoning_effort: 'medium', personality: 'friendly' })
  })
})

describe('upstream capability discovery and HTTP forwarding', () => {
  it('reads model metadata and sends three distinct effort levels over real HTTP', async () => {
    const received: any[] = []
    const upstream = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json')
      if (request.method === 'GET') {
        response.end(JSON.stringify({ data: [{ id: provider.defaultModel, context_window: 524288, input_modalities: ['text', 'image'], effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }] }))
        return
      }
      let raw = ''; for await (const chunk of request) raw += chunk
      received.push(JSON.parse(raw))
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    })
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
    const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening')
    const port = (portProbe.address() as any).port
    await new Promise<void>(resolve => portProbe.close(() => resolve()))
    const store = new Store(temporary(), cipher)
    store.setSettings({ ...store.settings, port })
    const runtime = new Runtime(store, temporary())
    try {
      const baseUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1`
      expect(await discoverModelDetails(baseUrl, '')).toEqual([{ id: provider.defaultModel, contextWindow: 524288, vision: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' }])
      const { id: _, apiKeySet: __, ...input } = provider
      const saved = await runtime.saveAndConnectProvider({ ...input, baseUrl })
      expect(saved.codexError).toBeUndefined()
      expect(modelCapabilities(store.getProvider(saved.providerId), provider.defaultModel).contextWindow).toBe(524288)
      for (const effort of ['low', 'high', 'max']) {
        const response = await fetch(`${runtime.gateway.url}/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${store.token}` }, body: JSON.stringify({ model: modelSlug(store.getProvider(saved.providerId), provider.defaultModel), input: 'reasoning test', reasoning: { effort } }) })
        expect(response.status).toBe(200); await response.text()
        expect(received.at(-1).reasoning_effort).toBe(effort)
        expect(store.logs[0].reasoningEffort).toBe(effort)
      }
      expect(received.map(request => request.reasoning_effort)).toEqual(['low', 'high', 'max'])
    } finally {
      await runtime.gateway.stop()
      await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections() })
    }
  })
})
