const { _electron: electron } = require('playwright')
const { createServer } = require('node:http')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { parse } = require('smol-toml')
const { listCodexModels } = require('./codex-model-list.cjs')

;(async () => {
  const root = path.resolve(__dirname, '..')
  const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const sandbox = fs.mkdtempSync(path.join(artifacts, 'desktop-'))
  const codexHome = path.join(sandbox, 'codex')
  fs.mkdirSync(codexHome)
  const original = '# Desktop smoke fixture\nmodel = "original-model"\napproval_policy = "on-request"\n'
  fs.writeFileSync(path.join(codexHome, 'config.toml'), original)
  const mock = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'glm-4.7' }, { id: 'kimi-k2.5' }] })); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    if (JSON.stringify(body.messages).includes('FLEET_FAIL')) { res.writeHead(429); res.end(JSON.stringify({ error: { message: 'Mock rate limit for UI validation' } })); return }
    const last = body.messages?.at(-1)
    const tool = body.tools?.[0]?.function
    let message = tool && last?.role !== 'tool' ? { tool_calls: [{ id: 'call-bridge', type: 'function', function: { name: tool.name, arguments: '{"ok":true}' } }] } : { content: `Connected to ${body.model}` }
    if (JSON.stringify(body.messages).includes('FLEET_CODEX_PROBE')) {
      const patchTool = body.tools?.find(t => t.function?.name.includes('apply_patch'))?.function
      if (body.messages.some(m => m.role === 'tool' && m.tool_call_id === 'call-code-proof')) message = { content: 'FLEET_CODEX_OK' }
      else if (patchTool) message = { tool_calls: [{ id: 'call-code-proof', type: 'function', function: { name: patchTool.name, arguments: JSON.stringify({ input: '*** Begin Patch\n*** Add File: bridge-proof.txt\n+FLEET_CODEX_OK\n*** End Patch\n' }) } }] }
      else message = { content: 'FLEET_CODEX_NO_PATCH_TOOL' }
    }
    const usage = { prompt_tokens: 248, completion_tokens: 37 }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: message.content ? message : { tool_calls: message.tool_calls.map(t => ({ ...t, index: 0 })) } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`)
      res.end(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`)
    } else res.end(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage }))
  })
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
  const baseUrl = `http://127.0.0.1:${mock.address().port}/v1`
  const env = { ...process.env, FLEET_DATA_DIR: path.join(sandbox, 'app'), FLEET_CODEX_HOME: codexHome }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENAI_API_KEY
  delete env.OPENAI_BASE_URL
  let application
  let codexVerified = false
  let codexPickerModels = []
  const errors = []
  try {
    application = await electron.launch({ args: [...(process.env.FLEET_EXECUTABLE ? [] : [root]), '--force-device-scale-factor=1'], ...(process.env.FLEET_EXECUTABLE ? { executablePath: process.env.FLEET_EXECUTABLE } : {}), env, timeout: 30000 })
    const page = await application.firstWindow()
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1672, 941) })
    page.on('pageerror', error => errors.push(error.message))
    async function screenshot(name, fullPage = true) {
      await page.evaluate(() => document.querySelector('.main-content').scrollTo(0, 0))
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.screenshot({ path: path.join(artifacts, name), fullPage })
    }
    await page.getByRole('heading', { name: /你自己的模型舰队/ }).waitFor()
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
    const gatewayPort = probe.address().port; await new Promise(resolve => probe.close(resolve))
    await page.evaluate(async port => { const snapshot = await window.fleet.snapshot(); await window.fleet.saveSettings({ ...snapshot.settings, port, theme: 'light' }); await window.fleet.setGateway(true) }, gatewayPort)
    await page.waitForFunction(() => document.querySelector('.gateway-pill').textContent.includes('在线'))
    await screenshot('01-empty.png')
    async function add(kind, name, model) {
      await page.getByRole('button', { name: '添加服务商', exact: true }).click()
      const editor = page.getByRole('dialog')
      await editor.getByRole('button', { name: `选择 ${kind}`, exact: true }).click()
      await editor.locator('input[name="name"]').fill(name)
      await editor.locator('input[name="baseUrl"]').fill(baseUrl)
      await editor.locator('input[name="apiKey"]').fill('sk-desktop-fixture-secret')
      await editor.locator('textarea[name="models"]').fill(model)
      if (kind === 'DeepSeek') {
        await screenshot('02-provider-editor.png', false)
        await editor.getByRole('button', { name: '从接口读取' }).click()
        await editor.getByRole('textbox', { name: '筛选可用模型' }).waitFor()
        await editor.getByRole('button', { name: 'deepseek-reasoner', exact: true }).click()
        await screenshot('02-model-discovery.png', false)
      }
      await editor.getByRole('button', { name: '保存并连接' }).click()
      await editor.waitFor({ state: 'hidden' })
    }
    await add('自定义', '自定义测试服务', 'global:deepseek-v4.1-flash\nglobal:deepseek-v4.1-flash-sg\nglobal:glm-5.3')
    for (const kind of ['DeepSeek', '智谱 GLM', 'Kimi']) {
      assert.equal(await page.getByRole('button', { name: `配置 ${kind}`, exact: true }).count(), 1, `${kind} preset must remain after adding a custom provider`)
    }
    assert.equal((await page.evaluate(() => window.fleet.snapshot())).codex.connected, true, 'Save and connect must write the Codex configuration')
    assert.equal(await page.getByRole('button', { name: '一键接入 Codex', exact: true }).count(), 0)
    await add('DeepSeek', 'DeepSeek', 'deepseek-chat')
    assert.equal(await page.getByRole('button', { name: '配置 DeepSeek', exact: true }).count(), 0, 'A configured preset must not be duplicated')
    assert.equal(await page.getByRole('heading', { name: 'DeepSeek', exact: true }).count(), 1)
    await page.locator('.provider-row').filter({ has: page.getByRole('heading', { name: 'DeepSeek', exact: true }) }).locator('.select-button').click()
    await add('智谱 GLM', '智谱 GLM', 'glm-4.7')
    await add('Kimi', 'Kimi', 'kimi-k2.5')
    const deepseek = page.locator('.provider-row').filter({ has: page.getByRole('heading', { name: 'DeepSeek', exact: true }) })
    await deepseek.getByRole('button', { name: 'DeepSeek 更多操作' }).click()
    await deepseek.getByRole('button', { name: '测试连接' }).click()
    await page.getByRole('status').filter({ hasText: '工具调用验证通过' }).waitFor()
    await page.getByRole('button', { name: '打开 Codex', exact: true }).waitFor()
    const config = parse(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'))
    assert.equal(config.model_provider, 'fleet_bridge')
    assert.equal(config.approval_policy, 'on-request')
    const endpoint = config.model_providers.fleet_bridge.base_url
    const token = config.model_providers.fleet_bridge.experimental_bearer_token
    const response = await fetch(`${endpoint}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'fleet/default', input: 'Hello' }) })
    assert.equal(response.status, 200)
    assert.match((await response.json()).output[0].content[0].text, /deepseek-chat/)
    const detected = process.platform === 'win32' ? spawnSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true }).stdout?.trim().split(/\r?\n/).find(candidate => fs.existsSync(candidate)) : undefined
    const cli = process.env.FLEET_CODEX_CLI || detected
    if (cli && fs.existsSync(cli)) {
      codexPickerModels = await listCodexModels(cli, codexHome)
      const catalog = JSON.parse(fs.readFileSync(config.model_catalog_json, 'utf8'))
      assert.deepEqual(codexPickerModels.filter(model => !model.hidden).map(model => model.id).sort(), catalog.models.filter(model => model.visibility === 'list').map(model => model.slug).sort(), 'Codex desktop model picker must list every configured route once')
      for (const model of ['global:deepseek-v4.1-flash', 'global:deepseek-v4.1-flash-sg', 'global:glm-5.3']) {
        assert.ok(codexPickerModels.some(entry => entry.id.endsWith(`/${model}`) && !entry.hidden), `${model} must be selectable in Codex`)
      }
      const workspace = path.join(sandbox, 'work')
      fs.mkdirSync(workspace)
      const child = spawn(cli, ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '-s', 'danger-full-access', '-c', 'approval_policy="never"', '-C', workspace, 'FLEET_CODEX_PROBE: create bridge-proof.txt containing FLEET_CODEX_OK using apply_patch.'], { env: { ...env, CODEX_HOME: codexHome }, windowsHide: true })
      child.stdin.end()
      let output = ''; let stderr = ''
      child.stdout.on('data', data => output += data)
      child.stderr.on('data', data => stderr += data)
      const timer = setTimeout(() => child.kill(), 45000)
      const [code] = await once(child, 'exit'); clearTimeout(timer)
      fs.writeFileSync(path.join(artifacts, 'codex-cli-report.json'), JSON.stringify({ code, output, stderr, workspace }, null, 2))
      assert.equal(code, 0, `Codex CLI failed: ${stderr}\n${output}`)
      assert.equal(fs.readFileSync(path.join(workspace, 'bridge-proof.txt'), 'utf8').trim(), 'FLEET_CODEX_OK')
      codexVerified = true
      console.log('Installed Codex CLI completed an actual apply_patch tool round trip.')
    }
    const kimi = page.locator('.provider-row').filter({ has: page.getByRole('heading', { name: 'Kimi', exact: true }) })
    await kimi.locator('.select-button').click()
    await page.getByRole('status').filter({ hasText: '已切换至 Kimi' }).waitFor()
    const second = await fetch(`${endpoint}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'fleet/default', input: 'Hello', stream: true }) })
    const stream = await second.text()
    assert.match(stream, /Connected to kimi-k2.5/)
    assert.match(stream, /response.completed/)
    for (let i = 0; i < 6; i++) {
      const response = await fetch(`${endpoint}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'fleet/default', input: i === 5 ? 'FLEET_FAIL' : 'UI validation' }) })
      assert.equal(response.status, i === 5 ? 502 : 200); await response.text()
    }
    await page.waitForFunction(async () => (await window.fleet.snapshot()).logs.some(log => log.provider === 'Kimi'))
    const toast = page.getByRole('status')
    if (await toast.count()) await toast.getByRole('button', { name: '关闭提示' }).click()
    await screenshot('03-dashboard.png')
    await page.getByRole('button', { name: /^连接记录/ }).click()
    await page.getByRole('heading', { name: '连接记录', exact: true }).waitFor()
    await page.getByRole('cell', { name: 'kimi-k2.5', exact: true }).first().waitFor()
    await page.getByLabel('请求状态', { exact: true }).selectOption('error')
    await page.getByRole('cell', { name: '上游失败', exact: true }).waitFor()
    assert.equal(await page.locator('.log-table tbody tr').count(), 1)
    await page.locator('.log-table tbody tr .icon-button').click()
    await page.getByRole('heading', { name: '请求详情' }).waitFor()
    assert.match(await page.getByRole('dialog').innerText(), /Mock rate limit/)
    await page.getByRole('button', { name: '关闭窗口' }).click()
    await page.getByRole('button', { name: '重置', exact: true }).click()
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    assert.ok(await page.locator('.log-table tbody tr').count() > 0)
    await page.getByRole('button', { name: '上一页', exact: true }).click()
    const csvPath = path.join(sandbox, 'export.csv')
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, csvPath)
    await page.getByRole('button', { name: '导出记录', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '已导出' }).waitFor()
    assert.match(fs.readFileSync(csvPath, 'utf8'), /kimi-k2.5/)
    assert.ok(!fs.readFileSync(csvPath, 'utf8').includes('sk-desktop-fixture-secret'))
    await page.getByRole('button', { name: '关闭提示', exact: true }).click()
    await screenshot('04-logs.png')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('heading', { name: '运行设置' }).waitFor()
    await page.getByLabel('超时设置', { exact: true }).selectOption('300')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor()
    assert.equal((await page.evaluate(() => window.fleet.snapshot())).settings.timeout, 300)
    await page.getByLabel('超时设置', { exact: true }).selectOption('120')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor()
    await page.getByRole('button', { name: '关闭提示', exact: true }).click()
    await screenshot('05-settings.png')
    const statePath = path.join(sandbox, 'app', 'data', 'state.json')
    assert.ok(!fs.readFileSync(statePath, 'utf8').includes('sk-desktop-fixture-secret'))
    await page.getByRole('button', { name: '工作台', exact: true }).click()
    await page.getByRole('button', { name: '恢复原来的连接', exact: true }).click()
    await page.getByRole('button', { name: '一键接入 Codex' }).waitFor()
    assert.equal(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), original)
    await page.getByRole('button', { name: 'Kimi 更多操作' }).click()
    await page.getByRole('button', { name: '删除 Kimi', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '删除服务商', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.provider-row:not(.unconfigured)').length === 3)
    assert.equal(await page.getByRole('button', { name: '配置 Kimi', exact: true }).count(), 1, 'Deleting a provider must restore its preset entry')
    assert.equal(errors.length, 0, errors.join('\n'))
    const report = { passed: true, packagedExecutable: process.env.FLEET_EXECUTABLE || null, codexVerified, codexPickerModels, checks: ['native Electron launch', 'redesigned UI rendering', 'custom provider preserves preset cards', 'save and connect writes Codex configuration', 'configured presets never duplicated', 'add four providers', 'discover models', 'OS-encrypted API keys', 'tool-aware connection test', 'isolated Codex integration', 'real HTTP forwarding', 'live default switching', 'SSE forwarding', 'request log status filters, pagination and error details', 'CSV log export', 'timeout settings persistence', 'settings page', 'exact config restore', 'deleted provider restores preset entry', 'no renderer errors', ...(codexVerified ? ['installed Codex app-server: every model visible in model/list', 'installed Codex CLI: actual apply_patch file creation'] : [])], sandbox, screenshots: ['01-empty.png', '02-provider-editor.png', '03-dashboard.png', '04-logs.png', '05-settings.png'] }
    fs.writeFileSync(path.join(artifacts, 'desktop-report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    if (application) {
      const windows = application.windows()
      if (windows[0]) await windows[0].screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
    }
    throw error
  } finally {
    if (application) await application.close()
    await new Promise(resolve => { mock.close(resolve); mock.closeAllConnections() })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
