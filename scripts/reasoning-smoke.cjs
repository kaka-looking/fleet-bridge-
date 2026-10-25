const { _electron: electron } = require('playwright')
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { once } = require('node:events')
const readline = require('node:readline')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { parse, stringify } = require('smol-toml')

function codexClient(cli, home) {
  const child = spawn(cli, ['app-server', '--stdio'], { env: { ...process.env, CODEX_HOME: home }, windowsHide: true })
  let sequence = 0; let diagnostics = ''
  const pending = new Map(); const notifications = []; const listeners = new Set()
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-6000) })
  const fail = error => { for (const item of pending.values()) item.reject(error); pending.clear() }
  child.on('error', fail)
  child.on('exit', code => fail(new Error(`Codex app-server exited (${code}): ${diagnostics}`)))
  child.stdin.on('error', fail)
  const send = value => child.stdin.write(JSON.stringify(value) + '\n')
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', line => {
    let value; try { value = JSON.parse(line) } catch { return }
    if (value.id !== undefined && pending.has(value.id)) {
      const item = pending.get(value.id); pending.delete(value.id)
      if (value.error) item.reject(new Error(JSON.stringify(value.error)))
      else item.resolve(value.result)
    } else if (value.method) {
      notifications.push(value)
      for (const listener of listeners) listener()
    }
  })
  return {
    notify: method => send({ method }),
    request: (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${diagnostics}`)) }, 45000)
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      send({ id, method, params })
    }),
    completed: turnId => new Promise((resolve, reject) => {
      const check = () => {
        const event = notifications.find(value => value.method === 'turn/completed' && value.params.turn.id === turnId)
        if (event) { clearTimeout(timer); listeners.delete(check); resolve(event.params.turn) }
      }
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Turn ${turnId} timed out: ${diagnostics}`)) }, 45000)
      listeners.add(check); check()
    }),
    close: () => { lines.close(); child.stdin.end(); child.kill() }
  }
}

;(async () => {
  const root = path.resolve(__dirname, '..')
  const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const sandbox = fs.mkdtempSync(path.join(artifacts, 'reasoning-'))
  const codexHome = path.join(sandbox, 'codex')
  const workspace = path.join(sandbox, 'work')
  fs.mkdirSync(codexHome); fs.mkdirSync(workspace)
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "original"\nmodel_reasoning_effort = "medium"\n')
  const model = 'global:deepseek-v4.1-flash'
  const received = []
  const clientRequests = []
  let tap
  const upstream = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET') {
      response.end(JSON.stringify({ data: [{ id: model, context_window: 1048576, input_modalities: ['text', 'image'], effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }] }))
      return
    }
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const probe = JSON.stringify(body.messages).includes('FLEET_REASONING_PROBE')
    if (probe) received.push({ model: body.model, effort: body.reasoning_effort, thinking: body.thinking, enableThinking: body.enable_thinking })
    const message = probe ? { content: `FLEET_REASONING_OK:${body.reasoning_effort}` } : { tool_calls: [{ id: 'call-ping', type: 'function', function: { name: 'fleet_ping', arguments: '{"ok":true}' } }] }
    const usage = { prompt_tokens: 8, completion_tokens: 4 }
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ choices: [{ delta: message }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`)
    } else response.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], usage }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const env = { ...process.env, FLEET_DATA_DIR: path.join(sandbox, 'app'), FLEET_CODEX_HOME: codexHome }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENAI_API_KEY
  delete env.OPENAI_BASE_URL
  let application; let client
  try {
    application = await electron.launch({ args: [...(process.env.FLEET_EXECUTABLE ? [] : [root]), '--force-device-scale-factor=1'], ...(process.env.FLEET_EXECUTABLE ? { executablePath: process.env.FLEET_EXECUTABLE } : {}), env })
    const page = await application.firstWindow()
    await page.getByRole('heading', { name: /你自己的模型舰队/ }).waitFor()
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900))
    await page.evaluate(async port => { const state = await window.fleet.snapshot(); await window.fleet.saveSettings({ ...state.settings, port, theme: 'light' }) }, port)
    await page.getByRole('button', { name: '添加服务商', exact: true }).click()
    const editor = page.getByRole('dialog')
    await editor.getByRole('button', { name: '选择 自定义', exact: true }).click()
    await editor.locator('input[name="name"]').fill('DeepSeek 推理验证')
    await editor.locator('input[name="baseUrl"]').fill(`http://127.0.0.1:${upstream.address().port}/v1`)
    await editor.locator('textarea[name="models"]').fill(model)
    assert.equal(await editor.locator('.advanced-fields select').count(), 2)
    assert.equal(await editor.locator('.advanced-fields input').count(), 0)
    await editor.getByRole('button', { name: '从接口读取', exact: true }).click()
    await editor.getByRole('textbox', { name: '筛选可用模型' }).waitFor()
    await editor.locator('.advanced-fields').scrollIntoViewIfNeeded()
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))))
    await page.screenshot({ path: path.join(artifacts, 'reasoning-landscape-editor.png') })
    await editor.getByRole('button', { name: '保存并连接', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    const config = parse(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'))
    assert.equal(config.model_reasoning_effort, 'high', 'Invalid saved medium must be replaced by a supported default')
    await page.evaluate(async baseUrl => {
      for (const model of ['global:glm-5.3', 'kimi-k2.5', 'kimi-k3.1-pro', 'qwen-plus', 'future-ultra']) {
        await window.fleet.saveProvider({
          kind: 'custom', name: model, baseUrl, protocol: 'chat', models: [model], defaultModel: model,
          contextWindow: 128000, vision: false, thinking: 'auto',
          ...(model === 'future-ultra' ? { modelCapabilities: { [model]: { reasoningEfforts: ['low', 'high', 'max', 'ultra'], defaultReasoningEffort: 'ultra' } } } : {})
        })
      }
      await window.fleet.connectCodex()
    }, `http://127.0.0.1:${upstream.address().port}/v1`)
    tap = createServer(async (request, response) => {
      try {
        let raw = ''; for await (const chunk of request) raw += chunk
        const body = JSON.parse(raw)
        clientRequests.push({ model: body.model, reasoning: body.reasoning, fields: Object.keys(body), clientMetadataKeys: Object.keys(body.client_metadata ?? {}) })
        const forwarded = await fetch(`http://127.0.0.1:${port}${request.url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: request.headers.authorization }, body: raw })
        response.writeHead(forwarded.status, { 'Content-Type': forwarded.headers.get('content-type') || 'application/json' })
        response.end(Buffer.from(await forwarded.arrayBuffer()))
      } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: { message: error.message } })) }
    })
    tap.listen(0, '127.0.0.1'); await once(tap, 'listening')
    const tappedConfig = parse(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'))
    tappedConfig.model_providers.fleet_bridge.base_url = `http://127.0.0.1:${tap.address().port}/v1`
    fs.writeFileSync(path.join(codexHome, 'config.toml'), stringify(tappedConfig))
    const cli = process.env.FLEET_CODEX_CLI
    assert.ok(cli && fs.existsSync(cli), 'Set FLEET_CODEX_CLI to the desktop app bundled codex.exe')
    client = codexClient(cli, codexHome)
    await client.request('initialize', { clientInfo: { name: 'fleet_reasoning_slider_test', version: require('../package.json').version }, capabilities: { experimentalApi: true } })
    client.notify('initialized')
    const list = await client.request('model/list', { includeHidden: false, limit: 100 })
    assert.equal(list.data.filter(entry => !entry.hidden && entry.id === 'fleet/default').length, 0, 'Compatibility alias must not duplicate the active model')
    const entry = list.data.find(entry => entry.id.endsWith(`/${model}`))
    assert.ok(entry)
    const efforts = entry.supportedReasoningEfforts.map(level => level.reasoningEffort)
    assert.deepEqual(efforts, ['low', 'high', 'max'])
    assert.equal(entry.defaultReasoningEffort, 'high')
    const thread = await client.request('thread/start', { model: entry.id, modelProvider: 'fleet_bridge', cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, baseInstructions: 'Return the answer directly without using tools.' })
    const turns = []
    for (const effort of efforts) {
      const started = await client.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: `FLEET_REASONING_PROBE ${effort}: reply directly.` }], effort })
      const completed = await client.completed(started.turn.id)
      assert.equal(completed.status, 'completed', JSON.stringify(completed.error))
      assert.equal(received.at(-1).effort, effort, 'Codex selection must reach the upstream API')
      assert.equal(received.at(-1).thinking.type, 'enabled')
      turns.push({ requested: effort, upstream: received.at(-1).effort, status: completed.status })
    }
    assert.deepEqual(received.map(request => request.effort), efforts)
    const contracts = [
      { name: 'global:glm-5.3', levels: ['low', 'high', 'max'], toggle: 'thinking' },
      { name: 'kimi-k2.5', levels: ['none', 'high'], toggle: 'only' },
      { name: 'kimi-k3.1-pro', levels: ['low', 'high', 'max'] },
      { name: 'qwen-plus', levels: ['none', 'high'], toggle: 'qwen' },
      { name: 'future-ultra', levels: ['low', 'high', 'max', 'ultra'] }
    ]
    const crossModel = []
    for (const contract of contracts) {
      const modelEntry = list.data.find(entry => entry.id.endsWith(`/${contract.name}`))
      assert.ok(modelEntry, `${contract.name} must be selectable`)
      assert.deepEqual(modelEntry.supportedReasoningEfforts.map(level => level.reasoningEffort), contract.levels)
      const thread = await client.request('thread/start', { model: modelEntry.id, modelProvider: 'fleet_bridge', cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, baseInstructions: 'Return directly without tools.' })
      for (const effort of contract.levels) {
        const started = await client.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: `FLEET_REASONING_PROBE ${effort}` }], effort })
        const completed = await client.completed(started.turn.id)
        assert.equal(completed.status, 'completed', JSON.stringify(completed.error))
        const last = received.at(-1)
        assert.equal(last.model, contract.name)
        if (contract.toggle === 'only') {
          assert.equal(last.effort, undefined)
          assert.equal(last.thinking.type, effort === 'none' ? 'disabled' : 'enabled')
        } else if (contract.toggle === 'qwen') {
          assert.equal(last.effort, undefined)
          assert.equal(last.enableThinking, effort !== 'none')
        } else {
          // This installed Codex implements Ultra internally and serializes Max.
          // Maximum policy below must explicitly restore the declared upstream Ultra.
          assert.equal(last.effort, effort === 'ultra' ? 'max' : effort)
          if (contract.toggle === 'thinking') assert.equal(last.thinking.type, 'enabled')
          else assert.equal(last.thinking, undefined)
        }
        crossModel.push({ model: contract.name, requested: effort, clientRequest: clientRequests.at(-1), upstream: last, status: completed.status })
      }
    }
    // Save a manual capability and maximum policy through the actual editor.
    await page.getByRole('button', { name: '添加服务商', exact: true }).click()
    await editor.getByRole('button', { name: '选择 自定义', exact: true }).click()
    await editor.locator('input[name="name"]').fill('最高强度验证')
    await editor.locator('input[name="baseUrl"]').fill(`http://127.0.0.1:${upstream.address().port}/v1`)
    await editor.locator('textarea[name="models"]').fill('manual-future')
    await editor.locator('.reasoning-capability-editor summary').click()
    await editor.getByRole('checkbox', { name: '手动配置 manual-future', exact: true }).check()
    await editor.getByRole('checkbox', { name: 'manual-future high', exact: true }).check()
    await editor.getByRole('checkbox', { name: 'manual-future ultra', exact: true }).check()
    await editor.getByLabel('思考模式', { exact: true }).selectOption('max')
    await page.screenshot({ path: path.join(artifacts, 'reasoning-maximum-editor.png') })
    await editor.getByRole('button', { name: '保存并连接', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    const manual = await page.evaluate(async () => (await window.fleet.snapshot()).providers.find(provider => provider.name === '最高强度验证'))
    assert.equal(manual.thinking, 'max')
    assert.equal(manual.modelCapabilities['manual-future'].reasoningOverride, true)
    const state = JSON.parse(fs.readFileSync(path.join(sandbox, 'app', 'data', 'state.json'), 'utf8'))
    const maximum = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${state.gatewayToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: `fleet/${manual.id}/manual-future`, input: 'FLEET_REASONING_PROBE maximum', reasoning: { effort: 'low' } }) })
    assert.equal(maximum.status, 200); await maximum.text()
    assert.equal(received.at(-1).effort, 'ultra')
    client.close()
    client = codexClient(cli, codexHome)
    await client.request('initialize', { clientInfo: { name: 'fleet_maximum_test', version: require('../package.json').version }, capabilities: { experimentalApi: true } })
    client.notify('initialized')
    const maximumList = await client.request('model/list', { includeHidden: false, limit: 100 })
    const maximumEntry = maximumList.data.find(entry => entry.id === `fleet/${manual.id}/manual-future`)
    assert.deepEqual(maximumEntry.supportedReasoningEfforts.map(level => level.reasoningEffort), ['ultra'])
    const maximumThread = await client.request('thread/start', { model: maximumEntry.id, modelProvider: 'fleet_bridge', cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, baseInstructions: 'Return directly without tools.' })
    const maximumTurn = await client.request('turn/start', { threadId: maximumThread.thread.id, input: [{ type: 'text', text: 'FLEET_REASONING_PROBE maximum via Codex' }], effort: 'ultra' })
    const maximumCompleted = await client.completed(maximumTurn.turn.id)
    assert.equal(maximumCompleted.status, 'completed', JSON.stringify(maximumCompleted.error))
    assert.equal(received.at(-1).effort, 'ultra', 'Highest policy must send real Ultra even when Codex serializes Max')
    await page.getByRole('button', { name: '连接记录', exact: true }).click()
    await page.getByRole('textbox', { name: '搜索连接记录', exact: true }).fill(model)
    await page.getByRole('cell', { name: model, exact: true }).first().waitFor()
    const detailRow = page.locator('.log-table tbody tr').filter({ has: page.getByRole('cell', { name: model, exact: true }) }).first()
    await detailRow.getByRole('button').click()
    await page.getByRole('dialog').getByText('上游推理强度', { exact: true }).waitFor()
    assert.match(await page.getByRole('dialog').innerText(), /max/)
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))))
    await page.screenshot({ path: path.join(artifacts, 'reasoning-request-detail.png') })
    const report = { passed: true, client: cli, sandbox, checks: ['landscape controls', 'automatic and manual per-model capabilities', 'hidden compatibility alias in actual model/list', 'saved effort repaired', 'actual Codex turn/start for DeepSeek/GLM/Kimi/Qwen/Ultra', 'manufacturer-specific upstream parameters', 'manual Ultra + maximum policy saved through editor', 'maximum policy sends Ultra even for a low request', 'actual Codex Ultra turn sends upstream Ultra under maximum policy', 'request details show actual forwarded effort'], turns, crossModel, maximumCodex: { selected: 'ultra', upstream: received.at(-1).effort, status: maximumCompleted.status } }
    fs.writeFileSync(path.join(artifacts, 'reasoning-report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ passed: report.passed, sandbox, checks: report.checks, completedCodexTurns: turns.length + crossModel.length + 1, maximumCodex: report.maximumCodex }, null, 2))
  } finally {
    if (client) client.close()
    if (application) await application.close()
    if (tap) await new Promise(resolve => { tap.close(resolve); tap.closeAllConnections() })
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections() })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
