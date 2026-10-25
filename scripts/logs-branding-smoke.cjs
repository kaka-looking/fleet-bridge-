const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const assert = require('node:assert/strict')

;(async () => {
  const root = path.resolve(__dirname, '..')
  const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const sandbox = fs.mkdtempSync(path.join(artifacts, 'logs-branding-'))
  const data = path.join(sandbox, 'app', 'data'); fs.mkdirSync(data, { recursive: true })
  const now = new Date().toISOString()
  const base = { at: now, provider: '日志验证', model: 'fixture-model', latency: 200, inputTokens: 0, outputTokens: 0 }
  const fixtures = [
    { id: 'legacy-network', status: 'error', error: 'fetch failed' },
    { id: 'upstream-failed', status: 'error', upstreamOutcome: 'failed', upstreamHttpStatus: 429, upstreamRequestId: 'upstream-fixture-id', failureStage: 'receive', error: 'rate limit' },
    { id: 'interrupted', status: 'interrupted', upstreamOutcome: 'unknown', upstreamHttpStatus: 200, failureStage: 'receive', errorCode: 'UND_ERR_SOCKET', error: '响应流连接中断', usageKnown: true, inputTokens: 12, outputTokens: 4 },
    { id: 'conversion', status: 'error', upstreamOutcome: 'completed', upstreamHttpStatus: 200, failureStage: 'convert', error: '工具调用缺少名称' },
    { id: 'timeout', status: 'timeout', upstreamOutcome: 'unknown', failureStage: 'connect', error: '等待上游超时' },
    { id: 'cancelled', status: 'cancelled', upstreamOutcome: 'unknown', error: 'Codex 已取消' },
    { id: 'incomplete', status: 'incomplete', upstreamOutcome: 'completed', upstreamHttpStatus: 200, note: '达到输出长度限制' },
    { id: 'ok', status: 'ok', upstreamOutcome: 'completed', upstreamHttpStatus: 200, usageKnown: true, inputTokens: 20, outputTokens: 6 }
  ].map(log => ({ ...base, ...log }))
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({
    version: 1, providers: [], activeProviderId: null, gatewayToken: randomBytes(32).toString('hex'),
    settings: { port: 24680, autoStart: false, launchAtLogin: false, theme: 'light', timeout: 120 }, logs: fixtures
  }))
  const env = { ...process.env, FLEET_DATA_DIR: path.join(sandbox, 'app'), FLEET_CODEX_HOME: path.join(sandbox, 'codex') }
  delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.OPENAI_BASE_URL
  let application
  try {
    application = await electron.launch({ args: process.env.FLEET_EXECUTABLE ? [] : [root], ...(process.env.FLEET_EXECUTABLE ? { executablePath: process.env.FLEET_EXECUTABLE } : {}), env })
    const page = await application.firstWindow()
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900))
    await page.getByRole('heading', { name: /你自己的模型舰队/ }).waitFor()
    assert.equal(await page.locator('.wordmark img').getAttribute('alt'), '舰桥 Fleet Bridge')
    assert.equal(await page.locator('.wordmark strong').innerText(), '舰桥')
    assert.equal(await page.locator('.wordmark span').innerText(), 'FLEET BRIDGE')
    assert.ok(await page.locator('.brand-icon').evaluate(img => img.complete && img.naturalWidth === 1024 && img.naturalHeight === 1024))
    const lightBrandText = await page.locator('.wordmark strong').evaluate(text => getComputedStyle(text).color)
    const checkBrandBounds = async () => {
      const bounds = await page.evaluate(() => {
        const image = document.querySelector('.brand-icon').getBoundingClientRect()
        const name = document.querySelector('.brand-name').getBoundingClientRect()
        const mark = document.querySelector('.wordmark').getBoundingClientRect()
        const sidebar = document.querySelector('.sidebar').getBoundingClientRect()
        return { imageLeft: image.left, imageRight: image.right, imageWidth: image.width, imageHeight: image.height, nameRight: name.right, markLeft: mark.left, markRight: mark.right, sidebarRight: sidebar.right }
      })
      assert.ok(bounds.imageLeft >= bounds.markLeft && bounds.imageRight <= bounds.markRight, 'The full logo must fit inside its wordmark')
      assert.equal(bounds.imageWidth, bounds.imageHeight, 'The square logo must preserve its aspect ratio')
      assert.ok(bounds.nameRight <= bounds.markRight, 'The app name must fit beside the square logo')
      assert.ok(bounds.markRight <= bounds.sidebarRight - 8, 'The wordmark must leave space before the sidebar border')
    }
    await checkBrandBounds()
    const native = await application.evaluate(({ app, nativeImage }) => {
      const image = nativeImage.createFromPath(app.getAppPath() + '/resources/icon.png')
      return { size: image.getSize(), transparentCorner: image.toBitmap()[3] === 0 }
    })
    assert.deepEqual(native, { size: { width: 512, height: 512 }, transparentCorner: true })
    await page.locator('.wordmark').screenshot({ path: path.join(artifacts, 'branding-wordmark.png') })
    await page.getByRole('button', { name: '连接记录', exact: true }).click()
    await page.getByText('响应完成率', { exact: true }).waitFor()
    assert.equal(await page.locator('.log-stat').filter({ hasText: '响应完成率' }).locator('strong').innerText(), '14.3%')
    await page.getByLabel('请求状态', { exact: true }).selectOption('interrupted')
    assert.equal(await page.locator('.log-table tbody tr').count(), 2)
    const oldRow = page.locator('.log-table tbody tr').first()
    assert.equal(await oldRow.locator('td').nth(5).innerText(), '—')
    await oldRow.getByRole('button').click()
    await page.getByRole('dialog').getByText('旧记录未保存上游状态，无法确认', { exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
    const newRow = page.locator('.log-table tbody tr').nth(1)
    await newRow.getByRole('button').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByText('UND_ERR_SOCKET', { exact: true }).waitFor()
    assert.match(await dialog.innerText(), /200/)
    assert.match(await dialog.innerText(), /不能据此判断上游生成失败/)
    await page.screenshot({ path: path.join(artifacts, 'logs-interrupted-detail.png') })
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
    await page.getByLabel('请求状态', { exact: true }).selectOption('error')
    assert.equal(await page.locator('.log-table tbody tr').count(), 2)
    await page.getByRole('cell', { name: '上游失败', exact: true }).waitFor()
    await page.getByRole('cell', { name: '处理异常', exact: true }).waitFor()
    const convertRow = page.locator('.log-table tbody tr').filter({ has: page.getByRole('cell', { name: '处理异常', exact: true }) })
    await convertRow.getByRole('button').click()
    await dialog.getByText('已收到上游完成响应', { exact: true }).waitFor()
    await dialog.getByText('转换响应格式', { exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
    for (const [value, label] of [['timeout', '超时'], ['cancelled', '已取消'], ['incomplete', '输出未完成']]) {
      await page.getByLabel('请求状态', { exact: true }).selectOption(value)
      assert.equal(await page.locator('.log-table tbody tr').count(), 1)
      await page.getByRole('cell', { name: label, exact: true }).waitFor()
    }
    await page.getByRole('button', { name: '重置', exact: true }).click()
    await page.screenshot({ path: path.join(artifacts, 'logs-statuses-light.png') })
    await page.evaluate(async () => { const state = await window.fleet.snapshot(); await window.fleet.saveSettings({ ...state.settings, theme: 'dark' }) })
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
    assert.notEqual(await page.locator('.wordmark strong').evaluate(text => getComputedStyle(text).color), lightBrandText, 'The app name must use the dark theme text color')
    await page.screenshot({ path: path.join(artifacts, 'logs-statuses-dark.png') })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 740))
    await checkBrandBounds()
    await page.locator('.wordmark').screenshot({ path: path.join(artifacts, 'branding-wordmark-dark-compact.png') })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900))
    const csv = path.join(sandbox, 'logs.csv')
    await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, csv)
    await page.getByRole('button', { name: '导出记录', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '已导出' }).waitFor()
    const exported = fs.readFileSync(csv, 'utf8')
    for (const text of ['连接中断', '旧记录未保存上游状态', '上游 HTTP 状态', '上游失败', '处理异常', 'upstream-fixture-id']) assert.ok(exported.includes(text))
    const report = { passed: true, packagedExecutable: process.env.FLEET_EXECUTABLE ?? null, sandbox, checks: ['provided square server logo retains its aspect ratio beside the app name', 'logo and app name fit normal and compact sidebars in light and dark themes', 'native taskbar/tray PNG is 512px with transparent corners', 'historical fetch failures shown as interrupted with unknown upstream outcome', 'unknown tokens shown as a dash', 'HTTP 200 interrupted response not labeled upstream failure', 'local conversion errors retain successful upstream outcome', 'independent cancelled/timeout/incomplete filters', 'cancellations excluded from local completion rate', 'CSV contains the same detailed outcomes'], native }
    fs.writeFileSync(path.join(artifacts, 'logs-branding-report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally { if (application) await application.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
