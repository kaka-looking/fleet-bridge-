const { readFileSync, writeFileSync, existsSync } = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { parse } = require('yaml')
const { validateTag } = require('./release-config.cjs')
const { version } = require('../package.json')
const tag = process.env.GITHUB_REF_NAME || process.argv[2]
validateTag(tag, version)
if (process.argv.includes('--assets')) {
  const folder = path.resolve(__dirname, '../release/ui-update')
  const installer = `Fleet-Bridge-${version}-Setup.exe`
  const assets = [installer, installer + '.blockmap', `Fleet-Bridge-${version}-Windows.exe`, 'latest.yml']
  for (const name of assets) if (!existsSync(path.join(folder, name))) throw new Error(`发布文件缺失：${name}`)
  const manifest = parse(readFileSync(path.join(folder, 'latest.yml'), 'utf8'))
  const file = manifest.files?.find(file => file.url === installer)
  const bytes = readFileSync(path.join(folder, installer))
  if (manifest.version !== version || !file || file.size !== bytes.length || file.sha512 !== crypto.createHash('sha512').update(bytes).digest('base64')) throw new Error('latest.yml 的安装包、版本或 SHA512 不一致，停止发布。')
  const checksum = assets.map(name => `${crypto.createHash('sha256').update(readFileSync(path.join(folder, name))).digest('hex')}  ${name}`).join('\n') + '\n'
  writeFileSync(path.join(folder, 'SHA256SUMS.txt'), checksum)
  console.log(`已验证 ${tag} 的安装包、便携版、更新清单和校验值。`)
} else console.log(`版本标签验证通过：${tag}`)
