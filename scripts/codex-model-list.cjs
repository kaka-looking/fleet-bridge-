const { spawn } = require('node:child_process')
const readline = require('node:readline')

// Query the same app-server protocol used by the Codex desktop model picker.
function listCodexModels(cli, codexHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['app-server', '--stdio'], {
      env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true
    })
    let stderr = ''; let settled = false
    const lines = readline.createInterface({ input: child.stdout })
    const finish = (error, models) => {
      if (settled) return
      settled = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill()
      if (error) reject(error)
      else resolve(models)
    }
    const timer = setTimeout(() => finish(new Error(`Codex model/list timed out: ${stderr.slice(-3000)}`)), 20000)
    const send = request => child.stdin.write(JSON.stringify(request) + '\n')
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-6000) })
    child.on('error', error => finish(error))
    child.on('exit', code => { if (!settled) finish(new Error(`Codex app-server exited (${code}): ${stderr}`)) })
    child.stdin.on('error', error => finish(error))
    lines.on('line', line => {
      let response
      try { response = JSON.parse(line) } catch { return }
      if (response.error) { finish(new Error(JSON.stringify(response.error))); return }
      if (response.id === 1) {
        send({ method: 'initialized' })
        send({ id: 2, method: 'model/list', params: { includeHidden: false, limit: 100 } })
      }
      if (response.id === 2) {
        if (!Array.isArray(response.result?.data)) finish(new Error('Codex returned no model list'))
        else finish(null, response.result.data)
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'fleet_model_picker_test', version: '0.1.0' } } })
  })
}

module.exports = { listCodexModels }
