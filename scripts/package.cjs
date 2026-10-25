const { spawn } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { releaseConfiguration } = require('./release-config.cjs')
const root = resolve(__dirname, '..')
const temporary = join(root, 'artifacts', 'package-temp')
const cache = join(root, 'artifacts', 'builder-cache')
mkdirSync(temporary, { recursive: true })
mkdirSync(cache, { recursive: true })
const configuration = releaseConfiguration(process.env, require('../package.json'))
if (process.argv.includes('--require-repository') && !configuration.publish) throw new Error('发布构建需要 GITHUB_REPOSITORY=用户名/仓库名，或 package.json 中的 repository.url。')
const configPath = join(root, 'artifacts', 'electron-builder.generated.json')
writeFileSync(configPath, JSON.stringify({ extends: join(root, 'electron-builder.yml'), ...configuration }, null, 2))
const targets = process.argv.includes('--portable-only') ? ['portable'] : ['nsis', 'portable']
const child = spawn(process.execPath, [require.resolve('electron-builder/cli.js'), '--win', ...targets, '--config', configPath, '--publish', 'never'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, TEMP: temporary, TMP: temporary, ELECTRON_BUILDER_CACHE: cache }
})
child.on('exit', code => { process.exitCode = code ?? 1 })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
