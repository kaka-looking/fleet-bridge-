const { spawn, spawnSync } = require('node:child_process')
const { createServer } = require('node:http')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const assert = require('node:assert/strict')

;(async () => {
  const root = path.resolve(__dirname, '..')
  const { version } = require('../package.json')
  const executable = path.join(root, 'release', 'ui-update', `Fleet-Bridge-${version}-Windows.exe`)
  const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const sandbox = fs.mkdtempSync(path.join(artifacts, 'portable-'))
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const env = { ...process.env, FLEET_DATA_DIR: path.join(sandbox, 'app'), FLEET_CODEX_HOME: path.join(sandbox, 'codex') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENAI_API_KEY
  delete env.OPENAI_BASE_URL
  const child = spawn(executable, [`--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: 'ignore' })
  let browser
  try {
    const start = Date.now()
    let ready = false
    while (Date.now() - start < 45000) {
      try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) { ready = true; break } } catch {}
      if (child.exitCode !== null) throw new Error(`Portable launcher exited before the app was ready: ${child.exitCode}`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(ready, 'Portable executable did not expose its running application')
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const page = browser.contexts()[0].pages()[0]
    await page.getByRole('heading', { name: /你自己的模型舰队/ }).waitFor()
    const gatewayProbe = createServer(); gatewayProbe.listen(0, '127.0.0.1'); await once(gatewayProbe, 'listening')
    const gatewayPort = gatewayProbe.address().port; await new Promise(resolve => gatewayProbe.close(resolve))
    await page.evaluate(async port => { const state = await window.fleet.snapshot(); await window.fleet.saveSettings({ ...state.settings, port, theme: 'light' }); await window.fleet.setGateway(true) }, gatewayPort)
    const snapshot = await page.evaluate(() => window.fleet.snapshot())
    assert.equal(snapshot.providers.length, 0)
    assert.equal(snapshot.version, version)
    assert.equal(snapshot.gateway.running, true)
    const updates = await page.evaluate(() => window.fleet.updateState())
    assert.ok(['unconfigured', 'portable'].includes(updates.mode))
    assert.equal(updates.phase, 'disabled')
    assert.equal(updates.currentVersion, version)
    assert.ok(snapshot.dataPath.startsWith(sandbox))
    assert.equal(fs.existsSync(path.join(sandbox, 'codex', 'config.toml')), false)
    await page.screenshot({ path: path.join(artifacts, '06-portable-first-run.png'), fullPage: true })
    await page.evaluate(() => window.fleet.setGateway(false))
    const report = { passed: true, executable, executableBytes: fs.statSync(executable).size, checks: ['portable self-extraction', 'standalone native startup', 'renderer and IPC work', 'portable update mode cannot execute automatic installer updates', 'gateway starts on an isolated port', 'first run has no fixture data', 'Codex config unchanged until user connects'], sandbox, updates }
    fs.writeFileSync(path.join(artifacts, 'portable-report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (child.exitCode === null) spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
