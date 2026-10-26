const { _electron: electron } = require('playwright')
const { createServer } = require('node:http')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')

;(async () => {
  const root = path.resolve(__dirname, '..')
  const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const sandbox = fs.mkdtempSync(path.join(artifacts, 'usage-desktop-'))
  const data = path.join(sandbox, 'app', 'data')
  fs.mkdirSync(data, { recursive: true })
  const localDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const today = new Date()
  const todayKey = localDay(today)
  const fixtures = []
  for (let index = 1; index < 365; index += 3) {
    const date = new Date(today); date.setDate(date.getDate() - index); date.setHours(12, 0, 0, 0)
    fixtures.push({ id: `day-${index}`, at: date.toISOString(), provider: '用量验证', model: 'fixture', status: 'ok', latency: 100, inputTokens: (index % 7 + 1) * 5_000_000, outputTokens: 1_000_000, usageKnown: true })
  }
  const previousYear = new Date(today.getFullYear() - 1, 0, 5, 12)
  fixtures.push({ id: 'previous-year', at: previousYear.toISOString(), provider: '用量验证', model: 'fixture', status: 'ok', latency: 100, inputTokens: 20, outputTokens: 10, usageKnown: true })
  const historicTokens = fixtures.reduce((sum, log) => sum + log.inputTokens + log.outputTokens, 0)
  fixtures.push({ id: 'today-known', at: today.toISOString(), provider: '用量验证', model: 'fixture', status: 'ok', latency: 100, inputTokens: 10_000_000_000 - historicTokens - 100, outputTokens: 100, usageKnown: true })
  fixtures.push({ id: 'today-unknown', at: today.toISOString(), provider: '用量验证', model: 'fixture', status: 'interrupted', latency: 100, inputTokens: 0, outputTokens: 0, usageKnown: false, upstreamOutcome: 'unknown' })
  const unknownDay = new Date(today); unknownDay.setDate(unknownDay.getDate() - 2)
  fixtures.push({ id: 'unknown-only', at: unknownDay.toISOString(), provider: '用量验证', model: 'fixture', status: 'timeout', latency: 100, inputTokens: 0, outputTokens: 0, usageKnown: false, upstreamOutcome: 'unknown' })
  const gatewayToken = randomBytes(32).toString('hex')
  const statePath = path.join(data, 'state.json')
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1, providers: [], activeProviderId: null, gatewayToken,
    settings: { port: 24680, autoStart: false, launchAtLogin: false, theme: 'light', timeout: 120 }, logs: fixtures
  }))
  const upstream = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '真实流式用量测试' }, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`)
    } else {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: '真实请求用量测试' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5 } }))
    }
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`
  const env = { ...process.env, FLEET_DATA_DIR: path.join(sandbox, 'app'), FLEET_CODEX_HOME: path.join(sandbox, 'codex') }
  delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.OPENAI_BASE_URL
  let application
  const errors = []
  const totals = snapshot => snapshot.usage.daily.reduce((sum, day) => sum + day.inputTokens + day.outputTokens, 0)
  async function launch() {
    application = await electron.launch({ args: [root, '--force-device-scale-factor=1'], env })
    const page = await application.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 1000))
    await page.getByRole('heading', { name: /你自己的模型舰队/ }).waitFor()
    return page
  }
  try {
    let page = await launch()
    const dashboardTokens = page.locator('.summary-card').filter({ hasText: '累计 Tokens' }).locator('strong')
    assert.equal(await dashboardTokens.innerText(), '10B')
    assert.equal(await dashboardTokens.getAttribute('title'), '10,000,000,000 Tokens')
    await page.getByRole('button', { name: '连接记录', exact: true }).click()
    const panel = page.getByRole('region', { name: '每日 Token 使用记录', exact: true })
    await panel.waitFor()
    assert.equal(await panel.locator('button.usage-cell').count(), 365)
    assert.equal(await page.locator('.log-stat.purple strong').innerText(), '10B')
    const unknownCell = panel.locator(`button[data-date="${localDay(unknownDay)}"]`)
    assert.match(await unknownCell.getAttribute('class'), /usage-unknown/)
    await unknownCell.click()
    assert.match(await panel.locator('.usage-day-detail').innerText(), /用量未知/)
    assert.doesNotMatch(await panel.locator('.usage-day-detail').innerText(), /0 Tokens/)
    assert.doesNotMatch(await unknownCell.getAttribute('aria-label'), /未收到有效用量/)
    assert.doesNotMatch(await unknownCell.getAttribute('title'), /未收到有效用量/)
    const todayCell = panel.locator(`button[data-date="${todayKey}"]`)
    await todayCell.click()
    assert.match(await panel.locator('.usage-day-detail').innerText(), /2 次请求/)
    assert.doesNotMatch(await panel.locator('.usage-day-detail').innerText(), /未收到有效用量/)
    assert.doesNotMatch(await todayCell.getAttribute('aria-label'), /未收到有效用量/)
    assert.doesNotMatch(await todayCell.getAttribute('title'), /未收到有效用量/)
    await panel.locator('.usage-explanation summary').click()
    assert.doesNotMatch(await panel.innerText(), /未收到有效用量/)
    assert.equal((await page.evaluate(() => window.fleet.snapshot())).usage.daily.find(day => day.date === todayKey).unknownUsageRequests, 1, 'Hiding the notice must not change recorded usage')
    await panel.locator('.usage-explanation summary').click()
    await todayCell.press('ArrowUp')
    assert.notEqual(await panel.locator('button:focus').getAttribute('data-date'), todayKey)
    await page.getByLabel('使用记录年份', { exact: true }).selectOption(String(today.getFullYear() - 1))
    assert.match(await panel.locator('.usage-day-detail').innerText(), new RegExp(`${today.getFullYear() - 1}-12-31`))
    await page.getByLabel('使用记录年份', { exact: true }).selectOption('recent')
    await panel.screenshot({ path: path.join(artifacts, 'usage-light.png') })
    await page.screenshot({ path: path.join(artifacts, 'usage-page-light.png') })
    await page.evaluate(async () => { const state = await window.fleet.snapshot(); await window.fleet.saveSettings({ ...state.settings, theme: 'dark' }) })
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
    await panel.screenshot({ path: path.join(artifacts, 'usage-dark.png') })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 740))
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('.main-content')
      const panel = document.querySelector('.usage-panel')
      const grid = document.querySelector('.usage-scroll')
      return { main: main.scrollWidth - main.clientWidth, panelRight: panel.getBoundingClientRect().right, mainRight: main.getBoundingClientRect().right, calendarScrolls: grid.scrollWidth > grid.clientWidth }
    })
    assert.ok(overflow.main <= 1, 'The main page must not overflow horizontally')
    assert.ok(overflow.panelRight <= overflow.mainRight, 'The heatmap must fit the page')
    assert.equal(overflow.calendarScrolls, true, 'Only the calendar scrolls in a compact window')
    await panel.screenshot({ path: path.join(artifacts, 'usage-dark-compact.png') })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 1000))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const about = page.getByRole('region', { name: '关于 Fleet Bridge', exact: true })
    assert.match(await about.innerText(), /Fleet Bridge为轻量高定制度面板/)
    const typography = await about.locator(':scope > p').evaluate(paragraph => {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      const styles = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue
        const style = getComputedStyle(node.parentElement)
        styles.push({ size: style.fontSize, weight: style.fontWeight, family: style.fontFamily })
      }
      return styles
    })
    assert.ok(typography.length >= 3)
    for (const style of typography) assert.deepEqual(style, typography[0], 'All about text, including Issues, must use identical typography')
    assert.equal(typography[0].weight, '700')
    assert.equal(await about.getByRole('link', { name: 'Issues', exact: true }).getAttribute('href'), 'https://github.com/kaka-looking/fleet-bridge-/issues')
    await application.evaluate(({ shell }) => {
      global.__usageLinks = []
      shell.openExternal = async url => { global.__usageLinks.push(url) }
    })
    await about.getByRole('link', { name: 'Issues', exact: true }).click()
    assert.deepEqual(await application.evaluate(() => global.__usageLinks), ['https://github.com/kaka-looking/fleet-bridge-/issues'])
    await about.screenshot({ path: path.join(artifacts, 'usage-settings-about.png') })
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
    const before = await page.evaluate(async ({ baseUrl, port }) => {
      let snapshot = await window.fleet.snapshot()
      await window.fleet.saveSettings({ ...snapshot.settings, port })
      await window.fleet.saveProvider({ name: '真实用量测试', kind: 'custom', baseUrl, protocol: 'chat', models: ['usage-fixture'], defaultModel: 'usage-fixture', contextWindow: 128000, vision: false, thinking: 'auto' })
      return window.fleet.setGateway(true)
    }, { baseUrl: upstreamUrl, port })
    for (let index = 0; index < 301; index++) {
      const response = await fetch(`${before.gateway.url}/responses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayToken}` },
        body: JSON.stringify({ model: 'fleet/default', input: '验证每日用量', stream: index === 0 })
      })
      assert.equal(response.status, 200)
      const body = await response.text()
      if (index === 0) assert.match(body, /response.completed/)
    }
    const after = await page.evaluate(() => window.fleet.snapshot())
    assert.equal(after.logs.length, 300)
    assert.ok(after.logs.every(log => log.id !== 'previous-year'))
    assert.equal(totals(after), 10_000_004_810)
    assert.equal(after.usage.daily.find(day => day.date === todayKey).requests, 303)
    assert.equal(after.usage.daily.find(day => day.date === localDay(previousYear)).inputTokens, 20)
    await page.getByRole('button', { name: '连接记录', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.log-stat.purple strong')?.title === '10,000,004,810 Tokens')
    await page.getByRole('button', { name: '清空记录', exact: true }).click()
    await page.getByRole('button', { name: '确认清空', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal((await page.evaluate(() => window.fleet.snapshot())).logs.length, 0)
    assert.equal(totals(await page.evaluate(() => window.fleet.snapshot())), 10_000_004_810)
    await application.close(); application = undefined
    page = await launch()
    const persisted = await page.evaluate(() => window.fleet.snapshot())
    assert.equal(totals(persisted), 10_000_004_810)
    assert.equal(persisted.logs.length, 0)
    await page.getByRole('button', { name: '连接记录', exact: true }).click()
    await page.getByLabel('使用记录年份', { exact: true }).selectOption(String(today.getFullYear() - 1))
    await page.getByRole('button', { name: '清空记录', exact: true }).click()
    await page.getByLabel('同时清空每日用量统计与累计 Tokens', { exact: true }).check()
    await page.getByRole('button', { name: '确认清空', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal(totals(await page.evaluate(() => window.fleet.snapshot())), 0)
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).usage.daily, [])
    assert.equal(await page.getByLabel('使用记录年份', { exact: true }).inputValue(), 'recent')
    assert.equal(await page.locator('.usage-panel button.usage-cell').count(), 365)
    assert.equal(await page.locator('.usage-panel button.usage-cell[data-level="4"]').count(), 0)
    await page.locator('.usage-panel').screenshot({ path: path.join(artifacts, 'usage-empty.png') })
    assert.deepEqual(errors, [])
    console.log('每日用量桌面验证通过：中文热力图、B 单位、301 次真实网关请求（含流式）、明细淘汰后保留、重启、清空选项、Issues、深浅色及窄窗口。')
  } finally {
    if (application) await application.close()
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections() })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
