import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readdirSync, statSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { stringify } from 'smol-toml'

export async function originalModelMetadata(home: string, directory: string, document: Record<string, any>) {
  const bin = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin')
  const candidates = process.env.FLEET_CODEX_CLI ? [process.env.FLEET_CODEX_CLI] : existsSync(bin) ? readdirSync(bin).map(name => join(bin, name, 'codex.exe')).filter(existsSync).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs) : []
  const cli = candidates[0]
  if (!cli) return []
  // Query the original provider in isolation even when the user's main config
  // currently points at Fleet. No inference or file-editing turn is started.
  const temporary = mkdtempSync(join(directory, 'original-discovery-'))
  try {
    const doc = { ...document }
    if (doc.model_catalog_json) doc.model_catalog_json = resolve(home, doc.model_catalog_json).replace(/\\/g, '/')
    writeFileSync(join(temporary, 'config.toml'), stringify(doc), { mode: 0o600 })
    const cache = join(home, 'models_cache.json')
    if (existsSync(cache)) writeFileSync(join(temporary, 'models_cache.json'), readFileSync(cache), { mode: 0o600 })
    return await new Promise<Record<string, any>[]>(resolve => {
      const child = spawn(cli, ['app-server', '--stdio'], { env: { ...process.env, CODEX_HOME: temporary }, windowsHide: true, stdio: 'pipe' })
      const lines = createInterface({ input: child.stdout })
      let finished = false; let diagnostics = ''
      const finish = (models: Record<string, any>[] = []) => { if (finished) return; finished = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill(); resolve(diagnostics.includes('Invalid configuration') ? [] : models) }
      const timer = setTimeout(() => finish(), 8000)
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000) }); child.on('error', () => finish()); child.on('exit', () => finish()); child.stdin.on('error', () => finish())
      const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n')
      lines.on('line', line => {
        let message: Record<string, any>; try { message = JSON.parse(line) } catch { return }
        if (message.error) { finish(); return }
        if (message.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'model/list', params: { includeHidden: false, limit: 500 } }) }
        if (message.id === 2) finish(Array.isArray(message.result?.data) ? message.result.data : [])
      })
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'fleet_original_catalog', version: '0.1.2' } } })
    })
  } finally {
    const target = resolve(temporary)
    if (target.startsWith(resolve(directory) + sep) && target.split(sep).at(-1)?.startsWith('original-discovery-')) {
      // The CLI can briefly retain SQLite handles while shutting down on Windows.
      try { rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) }
      catch { for (const file of ['config.toml', 'auth.json']) { try { writeFileSync(join(target, file), '') } catch {} } }
    }
  }
}
