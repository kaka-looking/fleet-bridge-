// Opt-in smoke test: three tiny requests to an existing configured upstream.
// Credentials remain encrypted on disk; the isolated Electron gateway decrypts them.
const { _electron: electron } = require('playwright')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

;(async () => {
  const root = path.resolve(__dirname, '..')
  assert.ok(process.env.FLEET_LIVE_STATE, 'Set FLEET_LIVE_STATE explicitly to opt into paid upstream requests')
  const source = JSON.parse(fs.readFileSync(process.env.FLEET_LIVE_STATE, 'utf8'))
  const saved = source.providers.find(provider => provider.id === source.activeProviderId)
  const model = process.env.FLEET_LIVE_MODEL ?? saved?.defaultModel
  assert.ok(saved?.models.includes(model), 'Live model must already exist in the saved provider')
  const provider = { ...saved, defaultModel: model, thinking: 'auto' }
  assert.ok(provider?.secret, 'An active provider with a saved key is required')
  assert.match(provider.defaultModel, /(?:deepseek-(?:flash|v4)|glm-5\.3)/i)
  const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const sandbox = fs.mkdtempSync(path.join(artifacts, 'reasoning-live-'))
  const dataPath = path.join(sandbox, 'app', 'data')
  const statePath = path.join(dataPath, 'state.json')
  const localStatePath = path.join(sandbox, 'app', 'Local State')
  fs.mkdirSync(dataPath, { recursive: true })
  // Chromium stores the DPAPI-protected encryption key separately from state.json.
  const localState = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(process.env.FLEET_LIVE_STATE)), 'Local State'), 'utf8'))
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const token = randomBytes(32).toString('hex')
  const env = { ...process.env, FLEET_DATA_DIR: path.join(sandbox, 'app'), FLEET_CODEX_HOME: path.join(sandbox, 'codex') }
  delete env.ELECTRON_RUN_AS_NODE
  let application
  const turns = []
  try {
    fs.writeFileSync(localStatePath, JSON.stringify({ os_crypt: localState.os_crypt }), { mode: 0o600 })
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, providers: [provider], activeProviderId: provider.id, logs: [], gatewayToken: token,
      settings: { ...source.settings, port, autoStart: false, launchAtLogin: false, timeout: 30 } }), { mode: 0o600 })
    application = await electron.launch({ args: process.env.FLEET_EXECUTABLE ? [] : [root], ...(process.env.FLEET_EXECUTABLE ? { executablePath: process.env.FLEET_EXECUTABLE } : {}), env })
    const page = await application.firstWindow()
    await page.getByRole('heading', { name: /你自己的模型舰队/ }).waitFor()
    await page.evaluate(() => window.fleet.setGateway(true))
    for (const effort of ['low', 'high', 'max']) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'fleet/default', input: 'Reply with OK.', max_output_tokens: 48, reasoning: { effort }, stream: false }), signal: AbortSignal.timeout(35000) })
      const body = await response.json()
      const snapshot = await page.evaluate(() => window.fleet.snapshot())
      turns.push({ requested: effort, forwarded: snapshot.logs[0]?.reasoningEffort, httpStatus: response.status, status: body.status,
        inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens, reasoningTokens: body.usage?.output_tokens_details?.reasoning_tokens,
        ...(body.error ? { error: body.error.message } : {}) })
      console.log(JSON.stringify(turns.at(-1)))
    }
    const report = { passed: turns.every(turn => turn.httpStatus === 200 && turn.requested === turn.forwarded), model: provider.defaultModel, outputLimitPerRequest: 48, turns,
      scope: 'Actual configured upstream accepts each effort; provider internals and relative reasoning quality cannot be inferred from three short responses.' }
    const name = provider.defaultModel.toLowerCase().includes('glm') ? 'reasoning-live-glm-report.json' : 'reasoning-live-report.json'
    fs.writeFileSync(path.join(artifacts, name), JSON.stringify(report, null, 2))
    assert.ok(report.passed, 'See reasoning-live-report.json for upstream failures')
  } finally {
    try { if (application) await application.close() }
    finally { for (const file of [statePath, localStatePath]) if (fs.existsSync(file)) fs.unlinkSync(file) }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1 })
