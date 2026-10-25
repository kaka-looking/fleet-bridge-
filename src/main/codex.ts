import { existsSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { createHash } from 'node:crypto'
import { atomicWrite, Store } from './store'
import { buildCatalog, modelSlug } from './catalog'
import type { CodexStatus } from '../shared/types'
import { modelCapabilities } from '../shared/model-capabilities'
import { OriginalConnection } from './original'
import { DesktopPreferences, type EffortBackup } from './desktop-preferences'

const ID = 'fleet_bridge'
const MANAGED_KEYS = ['model', 'model_provider', 'model_catalog_json', 'model_reasoning_effort']
type Doc = Record<string, any>
interface Backup { original: string | null; lastWritten: string; previous: Doc; provider: unknown; at: string; desktopEfforts?: EffortBackup }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export class CodexConfig {
  readonly path: string
  readonly catalogPath: string
  readonly backupPath: string
  readonly original: OriginalConnection
  readonly desktop: DesktopPreferences
  constructor(readonly home: string, private store: Store) {
    this.path = join(home, 'config.toml')
    this.catalogPath = join(store.directory, 'codex-models.json')
    this.backupPath = join(store.directory, 'codex-backup.json')
    this.original = new OriginalConnection(home, store)
    this.desktop = new DesktopPreferences(home)
  }
  private read() { return existsSync(this.path) ? readFileSync(this.path, 'utf8') : '' }
  private parse(raw: string): Doc { return raw.trim() ? parse(raw) : {} }
  private managed(doc: Doc) {
    const catalog = typeof doc.model_catalog_json === 'string' ? resolve(this.home, doc.model_catalog_json) : ''
    const samePath = process.platform === 'win32' ? catalog.toLowerCase() === this.catalogPath.toLowerCase() : catalog === this.catalogPath
    return doc.model_provider === ID && doc.model_providers?.[ID]?.base_url === `http://127.0.0.1:${this.store.settings.port}/v1`
      && samePath && existsSync(this.catalogPath)
  }
  status(): CodexStatus {
    try {
      const doc = this.parse(this.read())
      return { connected: this.managed(doc), configPath: this.path, hasBackup: existsSync(this.backupPath), maxEffortEnabled: this.desktop.enabled() }
    } catch { return { connected: false, configPath: this.path, hasBackup: existsSync(this.backupPath), conflict: 'Codex 配置文件存在 TOML 格式错误，请先修复。' } }
  }
  catalog() { return buildCatalog(this.store.providers, this.store.activeProviderId, this.original) }
  writeCatalog() { atomicWrite(this.catalogPath, JSON.stringify(this.catalog(), null, 2)) }
  enableMaxEffort() {
    if (!existsSync(this.backupPath)) throw new Error('请先接入 Codex，再启用最大推理档位。')
    const backup: Backup = JSON.parse(readFileSync(this.backupPath, 'utf8'))
    const required = [...new Set(['max', ...this.catalog().models.flatMap(model => model.supported_reasoning_levels.map((level: any) => level.effort as string))])]
    backup.desktopEfforts = this.desktop.prepare(backup.desktopEfforts, required)
    atomicWrite(this.backupPath, JSON.stringify(backup, null, 2))
    this.desktop.enable(backup.desktopEfforts, required)
  }
  connect() {
    const active = this.store.providers.find(provider => provider.id === this.store.activeProviderId && provider.enabled !== false) ?? this.original.provider
    if (!active || active.enabled === false) throw new Error('请先启用一个服务商。')
    const original = existsSync(this.path) ? this.read() : null
    const doc = this.parse(original ?? '')
    if (existsSync(this.backupPath) && doc.model_provider !== ID) throw new Error('发现尚未恢复的备份。请先恢复原配置，再重新接入。')
    let backup: Backup
    if (existsSync(this.backupPath)) backup = JSON.parse(readFileSync(this.backupPath, 'utf8'))
    else backup = { original, previous: Object.fromEntries(MANAGED_KEYS.filter(k => k in doc).map(k => [k, doc[k]])), provider: doc.model_providers?.[ID] ?? null, lastWritten: '', at: new Date().toISOString() }
    this.writeCatalog()
    // Older backups predate effort management; preserve the original value on upgrade.
    const previous = this.parse(backup.original ?? '')
    if (!('model_reasoning_effort' in backup.previous) && 'model_reasoning_effort' in previous) backup.previous.model_reasoning_effort = previous.model_reasoning_effort
    const capabilities = modelCapabilities(active, active.defaultModel)
    if (capabilities.reasoningEfforts.length) {
      if (!capabilities.reasoningEfforts.includes(doc.model_reasoning_effort)) doc.model_reasoning_effort = capabilities.defaultReasoningEffort
    } else delete doc.model_reasoning_effort
    doc.model = active.id === 'codex-original' ? active.defaultModel : modelSlug(active, active.defaultModel)
    doc.model_provider = ID
    doc.model_catalog_json = this.catalogPath.replace(/\\/g, '/')
    doc.model_providers ??= {}
    doc.model_providers[ID] = {
      name: '舰桥 Fleet Bridge', base_url: `http://127.0.0.1:${this.store.settings.port}/v1`,
      wire_api: 'responses', experimental_bearer_token: this.store.token,
      requires_openai_auth: false, supports_websockets: false
    }
    const next = stringify(doc)
    backup.lastWritten = hash(next)
    const required = [...new Set(this.catalog().models.flatMap(model => model.supported_reasoning_levels.map((level: any) => level.effort as string)))]
    if (required.length) backup.desktopEfforts = this.desktop.prepare(backup.desktopEfforts, required)
    // Persist the recovery record before touching the user's configuration.
    atomicWrite(this.backupPath, JSON.stringify(backup, null, 2))
    mkdirSync(this.home, { recursive: true })
    atomicWrite(this.path, next)
    if (required.length) this.desktop.enable(backup.desktopEfforts, required)
  }
  restore() {
    if (!existsSync(this.backupPath)) throw new Error('没有可恢复的 Codex 配置备份。')
    const backup: Backup = JSON.parse(readFileSync(this.backupPath, 'utf8'))
    const current = this.read()
    if (hash(current) === backup.lastWritten) {
      if (backup.original === null) { if (existsSync(this.path)) unlinkSync(this.path) }
      else atomicWrite(this.path, backup.original)
    } else {
      const doc = this.parse(current)
      if (doc.model_provider !== ID) throw new Error('Codex 的服务商配置已被其他程序修改。备份已保留，请在数据目录中核对后手动恢复。')
      // Preserve unrelated edits made after connecting, including permissions and MCP servers.
      for (const key of MANAGED_KEYS) {
        if (key in backup.previous) doc[key] = backup.previous[key]
        else delete doc[key]
      }
      if (backup.provider) doc.model_providers[ID] = backup.provider
      else if (doc.model_providers) {
        delete doc.model_providers[ID]
        if (!Object.keys(doc.model_providers).length) delete doc.model_providers
      }
      atomicWrite(this.path, stringify(doc))
    }
    this.desktop.restore(backup.desktopEfforts)
    unlinkSync(this.backupPath)
  }
}
