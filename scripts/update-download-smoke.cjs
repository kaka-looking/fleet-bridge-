const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { stringify } = require('yaml')
const ts = require('typescript')

;(async () => {
  const root = path.resolve(__dirname, '..')
  const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const sandbox = fs.mkdtempSync(path.join(artifacts, 'update-download-'))
  const { version } = require('../package.json')
  const nextVersion = version.replace(/\d+$/, patch => String(Number(patch) + 1))
  // Exercise the production state machine with the actual NSIS updater, without
  // adding test-only update feeds or installer bypasses to the application.
  fs.writeFileSync(path.join(sandbox, 'updates.cjs'), ts.transpileModule(
    fs.readFileSync(path.join(root, 'src/main/updates.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText)
  const good = Buffer.from('MZ-FLEET-UPDATE-VALIDATION-ONLY-NEVER-EXECUTE')
  const expectedHash = createHash('sha512').update(good).digest('base64')
  let downloads = 0
  const server = createServer((req, res) => {
    if (req.url.startsWith('/latest.yml')) {
      res.setHeader('Content-Type', 'text/yaml')
      res.end(stringify({ version: nextVersion, files: [{ url: `Fleet-Bridge-${nextVersion}-Setup.exe`, sha512: expectedHash, size: good.length }], path: `Fleet-Bridge-${nextVersion}-Setup.exe`, sha512: expectedHash, releaseDate: new Date().toISOString() }))
    } else if (req.url === `/Fleet-Bridge-${nextVersion}-Setup.exe`) {
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
    const { version } = require(path.join(process.env.FLEET_UPDATE_TEST_ROOT, 'package.json'))
    const nextVersion = version.replace(/\d+$/, patch => String(Number(patch) + 1))
    app.getVersion = () => version
    await app.whenReady()
    const { NsisUpdater } = require(path.join(process.env.FLEET_UPDATE_TEST_ROOT, 'node_modules/electron-updater'))
    const { Updates } = require(path.join(process.env.FLEET_UPDATE_TEST_DIR, 'updates.cjs'))
    const installers = []
    const launches = []
    const makeUpdater = () => {
      const updater = new NsisUpdater()
      updater.logger = null
      updater.forceDevUpdateConfig = true
      updater.updateConfigPath = path.join(process.env.FLEET_UPDATE_TEST_DIR, 'update.yml')
      updater.disableDifferentialDownload = true
      // Exercise the real NSIS argument builder, but never launch an installer.
      updater.app.quit = () => {}
      updater.spawnLog = async (command, args) => { launches.push({ command, args: [...args] }) }
      const doInstall = updater.doInstall.bind(updater)
      updater.doInstall = options => { installers.push(options); return doInstall(options) }
      return updater
    }
    const updater = makeUpdater()
    const settings = { port: 24680, autoStart: false, launchAtLogin: false }
    const options = { version, repository: 'https://github.com/kaka-looking/fleet-bridge-.git', packaged: true, portable: false, installed: true, platform: 'win32', feedExists: true }
    let inflight = 0
    let prepared = 0
    const installation = { inflight: () => inflight, prepare: async () => { prepared++ }, rollback: async () => {} }
    const updates = new Updates(updater, options, () => settings, () => {}, installation)
    const errors = []
    updater.on('error', error => errors.push(error.message))
    try {
      assert.equal((await updates.check()).phase, 'error')
      assert.ok(errors.some(message => /sha512 checksum mismatch/i.test(message)))
      await updates.installOnQuit()
      assert.equal(installers.length, 0)
      assert.equal((await updates.download()).phase, 'downloaded')
      assert.equal(updates.snapshot().version, nextVersion)
      assert.equal(prepared, 0, 'Downloading must not stop the gateway')
      const bytes = fs.readFileSync(updater.installerPath)
      const hash = crypto.createHash('sha512').update(bytes).digest('base64')
      assert.equal(hash, process.env.FLEET_UPDATE_EXPECTED_HASH)
      assert.ok(updater.installerPath.startsWith(process.env.FLEET_UPDATE_TEST_DIR), 'Download cache must stay isolated')
      const restoredBackend = makeUpdater()
      const restored = new Updates(restoredBackend, options, () => settings, () => {}, installation)
      assert.equal((await restored.check()).phase, 'downloaded', 'A new updater instance must recover and verify the downloaded cache')
      settings.autoInstallUpdates = false
      await restored.installOnQuit()
      assert.equal(installers.length, 0)
      settings.autoInstallUpdates = true
      inflight = 1
      await restored.installOnQuit()
      assert.equal(installers.length, 0)
      inflight = 0
      await restored.installOnQuit()
      assert.equal(prepared, 1)
      assert.equal(installers.length, 1)
      assert.equal(installers[0].isSilent, true)
      assert.equal(installers[0].isForceRunAfter, false)
      assert.equal(launches.length, 1)
      assert.equal(launches[0].command, restoredBackend.installerPath)
      assert.deepEqual(launches[0].args, ['--updated', '/S'])
      const manualBackend = makeUpdater()
      manualBackend.autoRunAppAfterInstall = false
      const manual = new Updates(manualBackend, options, () => settings, () => {}, installation)
      assert.equal((await manual.check()).phase, 'downloaded')
      settings.autoInstallUpdates = false
      await manual.install()
      assert.equal(prepared, 2)
      assert.equal(installers.length, 2)
      assert.equal(installers[1].isSilent, true)
      assert.equal(installers[1].isForceRunAfter, true)
      assert.equal(launches.length, 2)
      assert.equal(launches[1].command, manualBackend.installerPath)
      assert.deepEqual(launches[1].args, ['--updated', '/S', '--force-run'])
      await manual.installOnQuit()
      assert.equal(launches.length, 2, 'The quit handler must not start a second installer')
      fs.writeFileSync(path.join(process.env.FLEET_UPDATE_TEST_DIR, 'result.json'), JSON.stringify({ passed: true, version: nextVersion, rejectedCorruptedDownload: errors.some(message => /checksum mismatch/.test(message)), downloadedBytes: bytes.length, downloadedSha512: hash, silentInstall: true, forceRestart: false, manualSilentInstall: true, manualForceRestart: true, nsisArguments: launches.map(launch => launch.args) }))
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
    assert.equal(result.manualSilentInstall, true)
    assert.equal(result.manualForceRestart, true)
    assert.equal(downloads, 2)
    const report = { ...result, downloads, sandbox, checks: ['production update state machine with real NSIS updater and local manifest', 'rejects corrupted installer bytes by SHA512 and never installs them', 'retry downloads and verifies correct bytes', 'verified cache is reused by a new updater instance without redownloading', 'opt-out and active model requests prevent installation', 'exit update builds --updated /S without --force-run', 'manual restart builds --updated /S --force-run even when autoRunAppAfterInstall is off', 'download cache is isolated', 'no installer execution, public release, or user config changes'] }
    fs.writeFileSync(path.join(artifacts, 'update-download-report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null) child.kill()
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
