const { _electron: electron } = require('playwright')
const { createServer } = require('node:http')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { listCodexModels } = require('./codex-model-list.cjs')

;(async () => {
  const root = path.resolve(__dirname, '..'); const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const sandbox = fs.mkdtempSync(path.join(artifacts, 'coexistence-'))
  const home = path.join(sandbox, 'codex'); fs.mkdirSync(home)
  const received = []
  const upstream = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET') { response.end(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }] })); return }
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); received.push({ endpoint: request.url, model: body.model, auth: request.headers.authorization, effort: body.reasoning?.effort ?? body.reasoning_effort })
    response.end(JSON.stringify(request.url.endsWith('/responses') ? { id: 'resp_gpt', object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const base = `http://127.0.0.1:${upstream.address().port}`
  const original = `# Original GPT connection\nmodel="gpt-6.1-sol"\nmodel_provider="original_api"\n[model_providers.original_api]\nname="Original fixture"\nbase_url="${base}/gpt"\nwire_api="responses"\nexperimental_bearer_token="original-fixture-key"\n`
  fs.writeFileSync(path.join(home, 'config.toml'), original)
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const env = { ...process.env, FLEET_DATA_DIR: path.join(sandbox, 'app'), FLEET_CODEX_HOME: home }
  delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.OPENAI_BASE_URL
  let app
  try {
    app = await electron.launch({ ...(process.env.FLEET_EXECUTABLE ? { executablePath: process.env.FLEET_EXECUTABLE } : {}), args: process.env.FLEET_EXECUTABLE ? [] : [root], env })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 940))
    await page.getByRole('heading', { name: /你自己的模型舰队/ }).waitFor()
    await page.evaluate(async ({ port, base }) => {
      const state = await window.fleet.snapshot(); await window.fleet.saveSettings({ ...state.settings, port, theme: 'light' })
      for (const [kind, model] of [['deepseek', 'deepseek-flash'], ['glm', 'glm-4.7'], ['kimi', 'kimi-k2.5']]) {
        await window.fleet.saveProvider({ kind, name: kind, baseUrl: `${base}/${kind}`, protocol: 'chat', apiKey: `${kind}-fixture-key`, models: [model], defaultModel: model, contextWindow: 128000, vision: false, thinking: 'auto' })
      }
      await window.fleet.connectCodex()
    }, { port, base })
    await page.getByRole('button', { name: '服务商', exact: true }).click()
    await page.getByRole('switch', { name: '启用 Codex 原配置', exact: true }).waitFor()
    const stateFile = path.join(sandbox, 'app', 'data', 'state.json')
    const token = JSON.parse(fs.readFileSync(stateFile, 'utf8')).gatewayToken
    const state = await page.evaluate(() => window.fleet.snapshot())
    const request = async model => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ model, input: 'hello', reasoning: { effort: 'max' } }) })
      await response.text(); return response.status
    }
    if (process.env.FLEET_CODEX_CLI) {
      const models = await listCodexModels(process.env.FLEET_CODEX_CLI, home)
      assert.ok(models.some(model => model.id === 'gpt-6.1-sol'))
      assert.ok(models.some(model => model.id === 'gpt-6-luna'))
      const gpt = models.find(model => model.id === 'gpt-6.1-sol')
      assert.ok(gpt.supportedReasoningEfforts.some(level => level.reasoningEffort === 'max'), 'Original GPT reasoning settings must be retained')
      for (const provider of state.providers) assert.ok(models.some(model => model.id === `fleet/${provider.id}/${provider.defaultModel}`))
    }
    assert.equal(await request('gpt-6.1-sol'), 200)
    assert.equal(received.at(-1).auth, 'Bearer original-fixture-key')
    for (const provider of state.providers) {
      assert.equal(await request(`fleet/${provider.id}/${provider.defaultModel}`), 200)
      assert.equal(received.at(-1).endpoint, `/${provider.kind}/chat/completions`)
      assert.equal(received.at(-1).auth, `Bearer ${provider.kind}-fixture-key`)
    }
    const deepseek = state.providers.find(provider => provider.kind === 'deepseek')
    await page.getByRole('switch', { name: '启用 deepseek', exact: true }).uncheck()
    await page.waitForFunction(id => window.fleet.snapshot().then(state => state.providers.find(provider => provider.id === id).enabled === false), deepseek.id)
    assert.equal(await request(`fleet/${deepseek.id}/${deepseek.defaultModel}`), 400)
    await page.getByRole('switch', { name: '启用 Codex 原配置', exact: true }).uncheck()
    await page.waitForFunction(() => window.fleet.snapshot().then(state => !state.originalCodex.enabled))
    assert.equal(await request('gpt-6.1-sol'), 400)
    await page.getByRole('switch', { name: '启用 Codex 原配置', exact: true }).check()
    await page.getByRole('switch', { name: '启用 deepseek', exact: true }).check()
    await page.waitForFunction(() => window.fleet.snapshot().then(state => state.originalCodex.enabled && state.providers.every(provider => provider.enabled !== false)))
    await page.getByRole('button', { name: '修复 Max 显示', exact: true }).click()
    assert.ok(JSON.parse(fs.readFileSync(path.join(home, '.codex-global-state.json'), 'utf8'))['electron-persisted-atom-state']['enabled-reasoning-efforts'].includes('max'))
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))))
    await page.screenshot({ path: path.join(artifacts, 'coexistence-providers.png') })
    await page.getByRole('button', { name: '恢复原来的连接', exact: true }).click()
    await page.waitForFunction(() => window.fleet.snapshot().then(state => !state.codex.hasBackup))
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), original)
    assert.equal((await page.evaluate(() => window.fleet.snapshot())).providers.length, 3)
    const report = { passed: true, sandbox, checks: ['original GPT models and DeepSeek/GLM/Kimi all visible in actual Codex model/list', 'original GPT reasoning levels retained', 'four independent upstream routes and credentials', 'provider and original switches affect real routing', 'Max repair action updates desktop preference', 'restore recovers exact original bytes and retains Fleet API configurations'], requests: received.map(({ auth, ...request }) => request) }
    fs.writeFileSync(path.join(artifacts, 'coexistence-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2))
  } finally { if (app) await app.close(); await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections() }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
