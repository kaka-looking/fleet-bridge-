const { _electron: electron } = require('playwright')
const { createServer } = require('node:http')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const assert = require('node:assert/strict')

;(async () => {
  const root = path.resolve(__dirname, '..')
  const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const sandbox = fs.mkdtempSync(path.join(artifacts, 'visual-'))
  const data = path.join(sandbox, 'app', 'data')
  fs.mkdirSync(data, { recursive: true })
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const providers = [
    ['deepseek', 'DeepSeek', 'deepseek-v4.1-flash'],
    ['glm', '智谱 GLM', 'glm-5.3'],
    ['custom', '自定义接口', 'custom-model'],
    ['kimi', 'Kimi', 'kimi-k2.5']
  ].map(([kind, name, model]) => ({
    id: `visual-${kind}`, kind, name, baseUrl: 'http://127.0.0.1:1/v1', protocol: 'chat',
    models: [model], defaultModel: model, contextWindow: 128000, vision: false, thinking: 'auto', apiKeySet: false
  }))
  const fixture = {
    version: 1, providers, activeProviderId: providers[0].id, gatewayToken: randomBytes(32).toString('hex'),
    settings: { port, theme: 'light', autoStart: true, launchAtLogin: false, timeout: 120 }, logs: []
  }
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify(fixture))
  const env = { ...process.env, FLEET_DATA_DIR: path.join(sandbox, 'app'), FLEET_CODEX_HOME: path.join(sandbox, 'codex') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENAI_API_KEY
  delete env.OPENAI_BASE_URL
  let application
  try {
    application = await electron.launch({ args: [...(process.env.FLEET_EXECUTABLE ? [] : [root]), '--force-device-scale-factor=1'], ...(process.env.FLEET_EXECUTABLE ? { executablePath: process.env.FLEET_EXECUTABLE } : {}), env })
    const page = await application.firstWindow()
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1672, 941))
    await page.getByRole('heading', { name: /你自己的模型舰队/ }).waitFor()
    const layouts = {}
    const shellLayouts = []
    const capture = async (name, selectors) => {
      await page.mouse.move(1655, 933)
      await page.evaluate(() => { document.activeElement?.blur(); document.querySelector('.main-content').scrollTo(0, 0) })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))))
      layouts[name] = await page.evaluate(selectors => Object.fromEntries(selectors.map(selector => {
        const element = document.querySelector(selector)
        const rect = element.getBoundingClientRect()
        return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }]
      })), selectors)
      if (['dashboard', 'providers', 'logs', 'settings'].includes(name)) {
        const shell = await page.evaluate(() => Object.fromEntries(['.sidebar', '.brand-icon', '.main-nav', '.main-nav button', '.sidebar-landscape', '.page-header'].map(selector => {
          const rect = document.querySelector(selector).getBoundingClientRect()
          return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }]
        })))
        assert.deepEqual(shell, shellLayouts[0]?.shell ?? shell, `${name} shared shell must remain stable`)
        shellLayouts.push({ name, shell })
      }
      await page.screenshot({ path: path.join(artifacts, `ui-${name}.png`) })
    }
    await capture('dashboard', ['.main-content', '.dashboard-hero', '.summary-cards', '.fleet-panel', '.quick-panel'])
    await page.getByRole('button', { name: '添加服务商', exact: true }).click()
    await page.getByRole('dialog').locator('input[name="apiKey"]').fill('sk-visual-preview')
    await capture('editor', ['.provider-editor', '.editor-body', '.advanced-fields', '.editor-footer'])
    await page.getByRole('button', { name: '关闭编辑', exact: true }).click()
    await page.getByRole('button', { name: '服务商', exact: true }).click()
    await capture('providers', ['.main-content', '.fleet-panel', '.quick-panel'])
    await page.locator('.quick-panel').screenshot({ path: path.join(artifacts, 'ui-quick-start.png') })
    await page.getByRole('button', { name: '连接记录', exact: true }).click()
    await capture('logs', ['.main-content', '.log-stats', '.trend-panel', '.log-filters', '.logs-table-panel'])
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await capture('settings', ['.main-content', '.settings-hero', '.settings-grid', '.runtime-settings', '.security-settings', '.preferences-settings'])
    await page.getByLabel('外观', { exact: true }).selectOption('dark')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
    await page.getByRole('button', { name: '关闭提示', exact: true }).click()
    await capture('dark', ['.main-content'])
    const timeout = page.getByLabel('超时设置', { exact: true })
    await timeout.scrollIntoViewIfNeeded()
    await timeout.click()
    assert.equal(await timeout.evaluate(element => getComputedStyle(element, '::picker(select)').backgroundColor), 'rgb(36, 63, 51)')
    await page.screenshot({ path: path.join(artifacts, 'ui-dark-picker.png') })
    await page.keyboard.press('Escape')
    await page.getByLabel('外观', { exact: true }).selectOption('light')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await page.getByRole('button', { name: '关闭提示', exact: true }).click()
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 740))
    await capture('compact-settings', ['.main-content'])
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    await page.getByRole('button', { name: '工作台', exact: true }).click()
    await page.getByRole('button', { name: '添加服务商', exact: true }).click()
    await capture('compact-editor', ['.provider-editor'])
    const report = { fixture: true, viewport: { width: 1672, height: 941 }, checks: ['four page views with identical shared shell geometry', 'provider editor', 'plain highlighted quick-start digits', 'live theme switching with styled dark picker', '1100x740 compact layout', 'no renderer page overflow'], sandbox, layouts, shellLayouts }
    fs.writeFileSync(path.join(artifacts, 'visual-review.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally { if (application) await application.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
