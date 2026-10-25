const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { stringify } = require('yaml')

;(async () => {
  const root = path.resolve(__dirname, '..')
  const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const sandbox = fs.mkdtempSync(path.join(artifacts, 'update-download-'))
  const good = Buffer.from('MZ-FLEET-UPDATE-VALIDATION-ONLY-NEVER-EXECUTE')
  const expectedHash = createHash('sha512').update(good).digest('base64')
  let downloads = 0
  const server = createServer((req, res) => {
    if (req.url.startsWith('/latest.yml')) {
      res.setHeader('Content-Type', 'text/yaml')
      res.end(stringify({ version: '0.1.7', files: [{ url: 'Fleet-Bridge-0.1.7-Setup.exe', sha512: expectedHash, size: good.length }], path: 'Fleet-Bridge-0.1.7-Setup.exe', sha512: expectedHash, releaseDate: new Date().toISOString() }))
    } else if (req.url === '/Fleet-Bridge-0.1.7-Setup.exe') {
      downloads++
      res.setHeader('Content-Type', 'application/octet-stream')
      res.end(downloads === 1 ? Buffer.alloc(good.length, 88) : good)
    } else { res.statusCode = 404; res.end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const feed = `http://127.0.0.1:${server.address().port}`
  fs.writeFileSync(path.join(sandbox, 'update.yml'), stringify({ provider: 'generic', url: feed, updaterCacheDirName: 'isolated-fleet-update' }))
  const fixture = async function () {
    const { app } = require('electron')
    const fs = require('node:fs')
    const path = require('node:path')
    const assert = require('node:assert/strict')
    const crypto = require('node:crypto')
    app.setPath('userData', path.join(process.env.FLEET_UPDATE_TEST_DIR, 'user'))
    app.setPath('cache', path.join(process.env.FLEET_UPDATE_TEST_DIR, 'cache'))
    app.getVersion = () => '0.1.6'
    await app.whenReady()
    const { NsisUpdater } = require(path.join(process.env.FLEET_UPDATE_TEST_ROOT, 'node_modules/electron-updater'))
    const updater = new NsisUpdater()
    updater.logger = null
    updater.forceDevUpdateConfig = true
    updater.updateConfigPath = path.join(process.env.FLEET_UPDATE_TEST_DIR, 'update.yml')
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.disableDifferentialDownload = true
    const errors = []
    updater.on('error', error => errors.push(error.message))
    try {
      const found = await updater.checkForUpdates()
      assert.equal(found.updateInfo.version, '0.1.7')
      await assert.rejects(() => updater.downloadUpdate(), /sha512 checksum mismatch/i)
      const downloaded = await updater.downloadUpdate()
      const bytes = fs.readFileSync(downloaded[0])
      const hash = crypto.createHash('sha512').update(bytes).digest('base64')
      assert.equal(hash, process.env.FLEET_UPDATE_EXPECTED_HASH)
      assert.ok(downloaded[0].startsWith(process.env.FLEET_UPDATE_TEST_DIR), 'Download cache must stay isolated')
      fs.writeFileSync(path.join(process.env.FLEET_UPDATE_TEST_DIR, 'result.json'), JSON.stringify({ passed: true, version: found.updateInfo.version, rejectedCorruptedDownload: errors.some(message => /checksum mismatch/.test(message)), downloadedBytes: bytes.length, downloadedSha512: hash }))
    } finally { app.quit() }
  }
  const entry = path.join(sandbox, 'fixture.cjs')
  fs.writeFileSync(entry, `(${fixture.toString()})().catch(error => { console.error(error); require('electron').app.exit(1) })`)
  const env = { ...process.env, LOCALAPPDATA: path.join(sandbox, 'cache'), FLEET_UPDATE_TEST_DIR: sandbox, FLEET_UPDATE_TEST_ROOT: root, FLEET_UPDATE_EXPECTED_HASH: expectedHash }
  delete env.ELECTRON_RUN_AS_NODE
  let child
  let timer
  try {
    child = spawn(require('electron'), [entry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostics = ''
    child.stdout.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-5000) })
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-5000) })
    timer = setTimeout(() => child.kill(), 45000)
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, diagnostics)
    const result = JSON.parse(fs.readFileSync(path.join(sandbox, 'result.json'), 'utf8'))
    assert.equal(result.rejectedCorruptedDownload, true)
    assert.equal(downloads, 2)
    const report = { ...result, downloads, sandbox, checks: ['real electron-updater checks a local release manifest', 'rejects corrupted installer bytes by SHA512', 'retry downloads and verifies correct bytes', 'download cache is isolated', 'no installer execution, public release, or user config changes'] }
    fs.writeFileSync(path.join(artifacts, 'update-download-report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null) child.kill()
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
