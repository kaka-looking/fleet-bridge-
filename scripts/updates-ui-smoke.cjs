const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

;(async () => {
  const root = path.resolve(__dirname, '..')
  const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const sandbox = fs.mkdtempSync(path.join(artifacts, 'updates-ui-'))
  const env = { ...process.env, FLEET_DATA_DIR: path.join(sandbox, 'app'), FLEET_CODEX_HOME: path.join(sandbox, 'codex') }
  delete env.ELECTRON_RUN_AS_NODE
  let application
  try {
    application = await electron.launch({ args: [root, '--force-device-scale-factor=1'], env })
    const page = await application.firstWindow()
    await page.getByRole('heading', { name: /你自己的模型舰队/ }).waitFor()
    await page.evaluate(async () => { const state = await window.fleet.snapshot(); await window.fleet.setGateway(false); await window.fleet.saveSettings({ ...state.settings, autoStart: false, theme: 'light' }) })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const updates = page.getByLabel('应用更新', { exact: true })
    await updates.getByText('开发模式不执行自动安装更新。', { exact: true }).waitFor()
    assert.equal(await updates.getByRole('button', { name: '检查更新', exact: true }).isDisabled(), true)
    await page.getByRole('switch', { name: '自动检查更新', exact: true }).uncheck()
    await page.getByRole('switch', { name: '自动下载更新', exact: true }).uncheck()
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor()
    const settings = await page.evaluate(async () => (await window.fleet.snapshot()).settings)
    assert.equal(settings.autoCheckUpdates, false); assert.equal(settings.autoDownloadUpdates, false)
    await application.evaluate(({ ipcMain, BrowserWindow }) => {
      const state = { mode: 'installer', phase: 'idle', currentVersion: '0.1.6', releasesUrl: 'https://github.com/example/fleet-bridge/releases/latest', message: '测试更新源' }
      globalThis.__fleetUpdateUiTest = { state, installClicks: 0 }
      const send = () => BrowserWindow.getAllWindows()[0].webContents.send('fleet:update-state', state)
      for (const method of ['checkForUpdates', 'downloadUpdate', 'installUpdate']) ipcMain.removeHandler(`fleet:${method}`)
      ipcMain.handle('fleet:checkForUpdates', () => { Object.assign(state, { phase: 'available', version: '0.1.7', message: '发现新版本 v0.1.7。' }); send(); return state })
      ipcMain.handle('fleet:downloadUpdate', () => { Object.assign(state, { phase: 'downloading', percent: 42, message: '正在后台下载更新' }); send(); return state })
      ipcMain.handle('fleet:installUpdate', () => { globalThis.__fleetUpdateUiTest.installClicks++; Object.assign(state, { phase: 'installing', message: '正在退出舰桥并安装更新…' }); send() })
      send()
    })
    await updates.getByRole('button', { name: '检查更新', exact: true }).click()
    await updates.getByRole('button', { name: '下载 v0.1.7', exact: true }).click()
    assert.equal(await updates.getByRole('progressbar', { name: '更新下载进度' }).getAttribute('value'), '42')
    await updates.screenshot({ path: path.join(artifacts, 'updates-downloading.png') })
    await application.evaluate(({ BrowserWindow }) => {
      const state = globalThis.__fleetUpdateUiTest.state
      Object.assign(state, { phase: 'downloaded', percent: 100, message: '更新已下载并校验，结束模型请求后可重启安装。' })
      BrowserWindow.getAllWindows()[0].webContents.send('fleet:update-state', state)
    })
    await updates.getByRole('button', { name: '重启并安装 v0.1.7', exact: true }).waitFor()
    await updates.screenshot({ path: path.join(artifacts, 'updates-ready-light.png') })
    await page.getByRole('button', { name: '工作台', exact: true }).click()
    await page.locator('.update-banner').getByText(/新版 v0.1.7 已下载/).waitFor()
    await page.getByRole('button', { name: '查看更新', exact: true }).click()
    await page.getByLabel('外观', { exact: true }).selectOption('dark')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
    await updates.screenshot({ path: path.join(artifacts, 'updates-ready-dark.png') })
    await updates.getByRole('button', { name: '重启并安装 v0.1.7', exact: true }).click()
    assert.equal(await application.evaluate(() => globalThis.__fleetUpdateUiTest.installClicks), 1)
    assert.equal(fs.existsSync(path.join(sandbox, 'codex', 'config.toml')), false)
    const report = { passed: true, sandbox, checks: ['development mode cannot run installer updates', 'automatic check/download preferences persist', 'check/download/progress/restart UI via real IPC and preload', 'downloaded update banner on workbench', 'light and dark update controls', 'no real installer execution or Codex config changes'] }
    fs.writeFileSync(path.join(artifacts, 'updates-ui-report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally { if (application) await application.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
