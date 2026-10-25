import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { parse, stringify } from 'smol-toml'
import { Store, type Cipher } from '../src/main/store'
import { Runtime } from '../src/main/runtime'
import { ChatStream, parseSSE, toChat, ToolContext } from '../src/main/translate'
import { buildCatalog, modelSlug } from '../src/main/catalog'
import { PRESETS } from '../src/shared/presets'

const cipher: Cipher = { label: 'test only', encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() }
const temp = () => mkdtempSync(join(tmpdir(), 'fleet-test-'))
const createStore = () => new Store(temp(), cipher)
async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as any).port; await new Promise<void>(r => server.close(() => r())); return port }

describe('Responses translation', () => {
  const provider = { ...PRESETS.deepseek, id: 'deepseek-test', apiKeySet: true }
  it('preserves namespace identity, raw custom-tool input and additional_tools', () => {
    const request = { model: 'fleet/default', instructions: 'Code safely', tools: [{ type: 'custom', name: 'apply_patch', description: 'Raw patch' }], input: [
      { type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'shell', parameters: null }] }] },
      { role: 'user', content: [{ type: 'input_text', text: 'edit a file' }] },
      { type: 'function_call', namespace: 'functions', name: 'shell', call_id: 'a', arguments: '{"cmd":"pwd"}' },
      { role: 'developer', content: 'approval granted' },
      { type: 'function_call_output', call_id: 'a', output: 'C:/work' },
      { type: 'custom_tool_call', name: 'apply_patch', call_id: 'b', input: '*** Begin Patch\n*** End Patch' },
      { type: 'custom_tool_call_output', call_id: 'b', output: 'done' }
    ] }
    const { body, context } = toChat(request, provider, 'deepseek-chat')
    expect(body.tools.find((t: any) => t.function.name === 'functions__shell').function.parameters.type).toBe('object')
    expect(body.messages[0].content).toContain('approval granted')
    expect(body.messages.find((m: any) => m.tool_calls?.[0]?.id === 'b').tool_calls[0].function.arguments).toContain('*** Begin Patch\\n')
    expect(context.output({ id: 'fc', callId: 'c', name: 'functions__shell', arguments: '{}' })).toMatchObject({ type: 'function_call', name: 'shell', namespace: 'functions' })
    expect(context.output({ id: 'fc', callId: 'b', name: 'apply_patch', arguments: '{"input":"raw\\npatch"}' })).toMatchObject({ type: 'custom_tool_call', input: 'raw\npatch' })
  })
  it('emits valid lifecycles and keeps usage chunks after finish_reason', () => {
    const events: any[] = []
    const request = { model: 'fleet/default', tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }] }
    const converter = new ChatStream(request, new ToolContext(request), chunk => events.push(JSON.parse(chunk.split('data: ')[1])))
    converter.start()
    converter.chunk({ choices: [{ delta: { content: '你好' } }] })
    converter.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'shell', arguments: '{"cmd":' } }] } }] })
    converter.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] }, finish_reason: 'tool_calls' }] })
    converter.chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } })
    const result = converter.complete()
    expect(result.output[1]).toMatchObject({ type: 'function_call', arguments: '{"cmd":"pwd"}', call_id: 'call-a' })
    expect(result.usage).toMatchObject({ input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } })
    expect(events[0].type).toBe('response.created')
    expect(events.at(-1).type).toBe('response.completed')
    expect(events.map(e => e.sequence_number)).toEqual(events.map((_, i) => i))
  })
  it('rejects truncated streams instead of falsely completing', () => {
    const converter = new ChatStream({ model: 'x' }, new ToolContext({}), () => {})
    converter.start(); converter.chunk({ choices: [{ delta: { content: 'partial' } }] })
    expect(() => converter.complete()).toThrow('提前关闭')
  })
  it('parses SSE split inside UTF-8 and CRLF', async () => {
    const bytes = new TextEncoder().encode(': ping\r\nevent: test\r\ndata: {"text":"你好"}\r\n\r\ndata: [DONE]\n\n')
    const stream = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2)); controller.close() } })
    const events = []
    for await (const event of parseSSE(stream)) events.push(event)
    expect(events).toEqual([{ event: 'test', data: '{"text":"你好"}' }, { event: undefined, data: '[DONE]' }])
  })
})

describe('configuration and persistence', () => {
  it('migrates existing settings and persists validated appearance and timeout preferences', () => {
    const store = createStore()
    const statePath = join(store.directory, 'state.json')
    const original = JSON.parse(readFileSync(statePath, 'utf8'))
    original.settings = { port: 24680, autoStart: false, launchAtLogin: false }
    writeFileSync(statePath, JSON.stringify(original))
    const migrated = new Store(store.directory, cipher)
    expect(migrated.settings).toMatchObject({ port: 24680, theme: 'system', timeout: 120, autoCheckUpdates: true, autoDownloadUpdates: true, autoInstallUpdates: true })
    migrated.setSettings({ ...migrated.settings, theme: 'dark', timeout: 300 })
    expect(new Store(store.directory, cipher).settings).toMatchObject({ theme: 'dark', timeout: 300 })
    expect(() => migrated.setSettings({ ...migrated.settings, timeout: 0 })).toThrow('超时')
    expect(migrated.settings.timeout).toBe(300)
  })
  it('defaults to automatic updates and turns installation off when its prerequisites are disabled', () => {
    const store = createStore()
    expect(store.settings.autoInstallUpdates).toBe(true)
    store.setSettings({ ...store.settings, autoCheckUpdates: true, autoDownloadUpdates: true, autoInstallUpdates: true })
    expect(new Store(store.directory, cipher).settings.autoInstallUpdates).toBe(true)
    store.setSettings({ ...store.settings, theme: 'dark' })
    expect(store.settings.autoInstallUpdates).toBe(true)
    store.setSettings({ ...store.settings, autoDownloadUpdates: false })
    expect(new Store(store.directory, cipher).settings).toMatchObject({ autoInstallUpdates: false, autoDownloadUpdates: false })
    store.setSettings({ ...store.settings, autoCheckUpdates: false, autoDownloadUpdates: true, autoInstallUpdates: true })
    expect(store.settings.autoInstallUpdates).toBe(false)
  })
  it.each([
    { autoInstallUpdates: false },
    { autoCheckUpdates: false },
    { autoDownloadUpdates: false }
  ])('preserves saved update opt-outs during settings migration: %j', preferences => {
    const store = createStore()
    const file = join(store.directory, 'state.json')
    const state = JSON.parse(readFileSync(file, 'utf8'))
    state.settings = { port: 24680, autoStart: false, launchAtLogin: false, ...preferences }
    writeFileSync(file, JSON.stringify(state))
    const migrated = new Store(store.directory, cipher)
    expect(migrated.settings.autoInstallUpdates).toBe(false)
    expect(migrated.settings).toMatchObject(preferences)
    migrated.setSettings({ ...migrated.settings, theme: 'dark' })
    expect(new Store(store.directory, cipher).settings.autoInstallUpdates).toBe(false)
  })
  it('keeps secrets out of snapshots and retains keys on edit', () => {
    const store = createStore()
    const id = store.save({ ...PRESETS.deepseek, apiKey: 'sk-private-value' })
    expect(JSON.stringify(store.providers)).not.toContain('sk-private-value')
    const provider = store.getProvider(id)
    store.save({ ...provider, apiKey: '', name: 'Renamed' })
    expect(store.key(id)).toBe('sk-private-value')
    expect(new Store(store.directory, cipher).getProvider(id).name).toBe('Renamed')
  })
  it('backs up exact original bytes and restores when unchanged', () => {
    const store = createStore(); store.save({ ...PRESETS.deepseek })
    const home = temp(); const path = join(home, 'config.toml')
    const original = '# my comments\nmodel = "original"\napproval_policy = "on-request"\n\n[mcp_servers.foo]\ncommand = "test"\n'
    writeFileSync(path, original)
    const runtime = new Runtime(store, home)
    runtime.codex.connect()
    const connected = parse(readFileSync(path, 'utf8')) as any
    expect(connected.model_provider).toBe('fleet_bridge')
    expect(connected.approval_policy).toBe('on-request')
    expect(connected.mcp_servers.foo.command).toBe('test')
    runtime.codex.connect(); runtime.codex.restore()
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(existsSync(runtime.codex.backupPath)).toBe(false)
  })
  it('saves a custom provider and connects every model to Codex in one action', async () => {
    const store = createStore(); store.setSettings({ ...store.settings, port: await freePort() })
    const runtime = new Runtime(store, temp())
    const original = '# Keep existing configuration\nmodel = "previous"\nmodel_provider = "previous_provider"\n'
    writeFileSync(runtime.codex.path, original)
    try {
      const saved = await runtime.saveAndConnectProvider({ ...PRESETS.deepseek, kind: 'custom', name: 'Custom provider', models: ['global:deepseek-v4.1-flash', 'global:glm-5.3'], defaultModel: 'global:deepseek-v4.1-flash' })
      expect(saved.codexError).toBeUndefined()
      expect(saved.snapshot.codex.connected).toBe(true)
      expect(saved.snapshot.gateway.running).toBe(true)
      const config = parse(readFileSync(runtime.codex.path, 'utf8')) as any
      expect(config.model_catalog_json).toBe(runtime.codex.catalogPath.replace(/\\/g, '/'))
      const catalog = JSON.parse(readFileSync(runtime.codex.catalogPath, 'utf8'))
      expect(catalog.models.map((model: any) => model.slug)).toEqual(['fleet/default', modelSlug(store.getProvider(saved.providerId), 'global:deepseek-v4.1-flash'), modelSlug(store.getProvider(saved.providerId), 'global:glm-5.3'), 'previous'])
      const edited = await runtime.saveAndConnectProvider({ ...store.getProvider(saved.providerId), models: ['replacement-model'], defaultModel: 'replacement-model' })
      expect(edited.providerId).toBe(saved.providerId)
      expect(edited.snapshot.providers).toHaveLength(1)
      expect(readFileSync(runtime.codex.catalogPath, 'utf8')).toContain('replacement-model')
      expect(readFileSync(runtime.codex.catalogPath, 'utf8')).not.toContain('global:glm-5.3')
      runtime.codex.restore()
      expect(readFileSync(runtime.codex.path, 'utf8')).toBe(original)
    } finally { await runtime.gateway.stop() }
  })
  it('reports a failed Codex sync while retaining the saved provider and original config', async () => {
    const store = createStore(); store.setSettings({ ...store.settings, port: await freePort() })
    const runtime = new Runtime(store, temp())
    const original = 'model = [ broken'
    writeFileSync(runtime.codex.path, original)
    try {
      const result = await runtime.saveAndConnectProvider({ ...PRESETS.deepseek, kind: 'custom', name: 'Custom provider' })
      expect(result.codexError).toBeTruthy()
      expect(result.snapshot.codex.connected).toBe(false)
      expect(result.snapshot.providers.map(provider => provider.id)).toEqual([result.providerId])
      expect(readFileSync(runtime.codex.path, 'utf8')).toBe(original)
      expect(existsSync(runtime.codex.backupPath)).toBe(false)
    } finally { await runtime.gateway.stop() }
  })
  it('only reports connected when the managed model catalog is configured', () => {
    const store = createStore(); store.save({ ...PRESETS.deepseek })
    const runtime = new Runtime(store, temp())
    runtime.codex.connect()
    const config = parse(readFileSync(runtime.codex.path, 'utf8')) as any
    delete config.model_catalog_json
    writeFileSync(runtime.codex.path, stringify(config))
    expect(runtime.codex.status().connected).toBe(false)
    runtime.codex.connect()
    expect(runtime.codex.status().connected).toBe(true)
  })
  it('preserves unrelated edits made after connecting', () => {
    const store = createStore(); store.save({ ...PRESETS.glm })
    const home = temp(); const runtime = new Runtime(store, home)
    runtime.codex.connect()
    const connected = parse(readFileSync(runtime.codex.path, 'utf8')) as any
    connected.personality = 'friendly'; connected.approval_policy = 'never'
    writeFileSync(runtime.codex.path, stringify(connected))
    runtime.codex.restore()
    const restored = parse(readFileSync(runtime.codex.path, 'utf8')) as any
    expect(restored.personality).toBe('friendly'); expect(restored.approval_policy).toBe('never')
    expect(restored.model_provider).toBeUndefined()
  })
  it('refuses to overwrite malformed config or another app’s provider', () => {
    const store = createStore(); store.save({ ...PRESETS.kimi })
    const runtime = new Runtime(store, temp())
    writeFileSync(runtime.codex.path, 'model = [ broken')
    expect(() => runtime.codex.connect()).toThrow()
    expect(readFileSync(runtime.codex.path, 'utf8')).toBe('model = [ broken')
    writeFileSync(runtime.codex.path, 'model = "original"\n')
    runtime.codex.connect()
    writeFileSync(runtime.codex.path, 'model_provider = "other_app"\n')
    expect(() => runtime.codex.restore()).toThrow('其他程序')
    expect(existsSync(runtime.codex.backupPath)).toBe(true)
  })
  it('generates unique catalog routes for providers sharing the same model ID', () => {
    const store = createStore(); store.save({ ...PRESETS.deepseek }); store.save({ ...PRESETS.deepseek, name: 'Another' })
    const catalog = buildCatalog(store.providers, store.activeProviderId)
    expect(new Set(catalog.models.map(m => m.slug)).size).toBe(catalog.models.length)
    expect(catalog.models[0].slug).toBe('fleet/default')
    expect(catalog.models.every(m => m.apply_patch_tool_type === 'freeform' && Array.isArray(m.supported_reasoning_levels))).toBe(true)
  })
})

describe('real HTTP gateway', () => {
  let upstream: Server
  let runtime: Runtime
  let baseUrl: string
  const received: any[] = []
  beforeAll(async () => {
    upstream = createServer(async (req, res) => {
      if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] })); return }
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw); received.push({ ...body, authorization: req.headers.authorization, path: req.url })
      if (body.model === 'fail-model') { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Rate limit reached sk-secret-test' } })); return }
      if (req.url === '/v1/responses') {
        const response = { id: 'native-response', object: 'response', model: body.model, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'native' }] }], usage: { input_tokens: 3, output_tokens: 2 } }
        if (body.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`) }
        else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response)) }
        return
      }
      const message = body.messages.at(-1)
      const model = body.model
      const result = message?.role === 'tool' ? { content: `done:${message.content}` } : body.tools?.length ? { tool_calls: [{ id: 'call-ping', type: 'function', function: { name: body.tools[0].function.name, arguments: '{"ok":true}' } }] } : { content: `hello:${model}` }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: result.content ? { content: result.content } : { tool_calls: result.tool_calls!.map((call: any) => ({ ...call, index: 0 })) } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: result.tool_calls ? 'tool_calls' : 'stop' }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 5 } })}\n\n`)
        res.end('data: [DONE]\n\n')
      } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: result, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 5 } })) }
    })
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
    baseUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1`
    const store = createStore()
    store.setSettings({ port: await freePort(), autoStart: false, launchAtLogin: false })
    store.save({ ...PRESETS.deepseek, baseUrl, models: ['model-a', 'fail-model'], defaultModel: 'model-a', apiKey: 'sk-secret-test' })
    runtime = new Runtime(store, temp()); await runtime.init(); await runtime.gateway.start()
  })
  afterAll(async () => { await runtime?.gateway.stop(); if (upstream) await new Promise<void>(r => { upstream.close(() => r()); upstream.closeAllConnections() }) })
  const request = (body: any, headers = {}) => fetch(`${runtime.gateway.url}/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtime.store.token}`, ...headers }, body: JSON.stringify(body) })
  it('authenticates locally and rejects web origins', async () => {
    expect((await request({ model: 'fleet/default', input: 'test' }, { Authorization: 'bad' })).status).toBe(401)
    expect((await request({ model: 'fleet/default', input: 'test' }, { Origin: 'https://evil.example' })).status).toBe(403)
    expect(received).toHaveLength(0)
  })
  it('proxies non-streaming responses and uses the actual upstream key', async () => {
    const response = await request({ model: 'fleet/default', input: 'hello' }); expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.output[0].content[0].text).toBe('hello:model-a')
    expect(received.at(-1).authorization).toBe('Bearer sk-secret-test')
    expect(body.model).toBe('fleet/default')
    expect(runtime.snapshot().logs[0].path).toBe('/v1/responses')
  })
  it('completes a streaming tool round trip with previous_response_id', async () => {
    const response = await request({ model: 'fleet/default', stream: true, input: 'ping', tools: [{ type: 'function', name: 'ping', parameters: { type: 'object' } }] })
    const events: any[] = []; for await (const event of parseSSE(response.body!)) events.push(JSON.parse(event.data))
    const completed = events.find(e => e.type === 'response.completed').response
    expect(completed.output[0]).toMatchObject({ type: 'function_call', name: 'ping', call_id: 'call-ping' })
    expect(completed.usage).toMatchObject({ input_tokens: 7, output_tokens: 5 })
    const second = await request({ model: 'fleet/default', previous_response_id: completed.id, input: [{ type: 'function_call_output', call_id: 'call-ping', output: 'pong' }] })
    const body = await second.json() as any
    expect(body.output[0].content[0].text).toBe('done:pong')
  })
  it('supports live default switching and strict explicit model routes', async () => {
    const id = runtime.store.save({ ...PRESETS.glm, baseUrl, models: ['model-b'], defaultModel: 'model-b' })
    runtime.selectProvider(id)
    const response = await request({ model: 'fleet/default', input: 'hello' })
    expect((await response.json() as any).output[0].content[0].text).toBe('hello:model-b')
    expect((await request({ model: 'fleet/missing/not-real', input: 'x' })).status).toBe(400)
    runtime.selectProvider(runtime.store.providers[0].id)
  })
  it('relays native Responses for both stream and JSON', async () => {
    const id = runtime.store.save({ ...PRESETS.custom, name: 'native', protocol: 'responses', baseUrl, models: ['native'], defaultModel: 'native' })
    const model = modelSlug(runtime.store.getProvider(id), 'native')
    const response = await request({ model, input: 'hi' })
    expect((await response.json() as any).output[0].content[0].text).toBe('native')
    const stream = await request({ model, input: 'hi', stream: true })
    const events: any[] = []; for await (const event of parseSSE(stream.body!)) events.push(JSON.parse(event.data))
    expect(events.at(-1).response.model).toBe(model)
  })
  it('provides model discovery, connection test and redacted request errors', async () => {
    expect(await runtime.discoverModels({ baseUrl })).toEqual(['model-a', 'model-b'])
    expect(await runtime.testProvider(runtime.store.providers[0].id)).toMatchObject({ ok: true })
    const model = modelSlug(runtime.store.providers[0], 'fail-model')
    const response = await request({ model, input: 'hello' })
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('sk-secret-test')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(runtime.snapshot().logs[0].status).toBe('error')
    expect(JSON.stringify(runtime.snapshot())).not.toContain('sk-secret-test')
  })
})
