import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { DiscoveredModel, Provider, ProviderInput, RequestLog, Settings } from '../shared/types'
import { mergeCapabilities, reasoningProfile, sanitizeCapabilities } from '../shared/model-capabilities'
import { normalizeRequestLog } from '../shared/request-log'

export interface Cipher { encrypt(value: string): string; decrypt(value: string): string; label: string }
type StoredProvider = Provider & { secret?: string }
interface State {
  version: 1
  providers: StoredProvider[]
  activeProviderId: string | null
  settings: Settings
  gatewayToken: string
  logs: RequestLog[]
}
export function atomicWrite(path: string, data: string) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, data, { mode: 0o600 })
  renameSync(temporary, path)
}
export function normalizeBaseUrl(raw: string) {
  const url = new URL(raw.trim())
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请填写不含密钥、查询参数的 HTTP(S) API 地址。')
  return url.toString().replace(/\/(?:chat\/completions|responses|models)\/?$/, '').replace(/\/$/, '')
}
export class Store {
  private state: State
  private file: string
  constructor(readonly directory: string, readonly cipher: Cipher) {
    mkdirSync(directory, { recursive: true })
    this.file = join(directory, 'state.json')
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {
      version: 1, providers: [], activeProviderId: null,
      settings: { port: 24680, autoStart: true, launchAtLogin: false, theme: 'system', timeout: 120 }, gatewayToken: randomBytes(32).toString('hex'), logs: []
    }
    if (this.state.version !== 1 || !Array.isArray(this.state.providers)) throw new Error('本地配置格式无法识别，请保留数据文件后检查。')
    const settings = this.state.settings
    const autoCheckUpdates = settings.autoCheckUpdates !== false
    const autoDownloadUpdates = settings.autoDownloadUpdates !== false
    this.state.settings = { theme: 'system', timeout: 120, ...settings, autoCheckUpdates, autoDownloadUpdates, autoInstallUpdates: autoCheckUpdates && autoDownloadUpdates && settings.autoInstallUpdates !== false }
    this.persist()
  }
  private persist() { atomicWrite(this.file, JSON.stringify(this.state, null, 2)) }
  get providers(): Provider[] { return this.state.providers.map(({ secret: _, ...provider }) => structuredClone(provider)) }
  get activeProviderId() { return this.state.activeProviderId }
  get settings() { return { ...this.state.settings } }
  get token() { return this.state.gatewayToken }
  get logs() { return structuredClone(this.state.logs).map(normalizeRequestLog) }
  getProvider(id: string) {
    const provider = this.providers.find(p => p.id === id)
    if (!provider) throw new Error('服务商不存在，请刷新后重试。')
    return provider
  }
  key(id: string) {
    const secret = this.state.providers.find(p => p.id === id)?.secret
    return secret ? this.cipher.decrypt(secret) : ''
  }
  save(input: ProviderInput) {
    if (!['deepseek', 'glm', 'kimi', 'qwen', 'minimax', 'custom'].includes(input.kind)) throw new Error('无效的服务商类型。')
    if (!['chat', 'responses'].includes(input.protocol)) throw new Error('无效的 API 协议。')
    if (!['auto', 'on', 'off', 'max'].includes(input.thinking)) throw new Error('无效的思考模式。')
    if (!input.name?.trim() || input.name.length > 80) throw new Error('服务商名称须为 1–80 个字符。')
    const models = [...new Set(input.models.map(m => m.trim()).filter(Boolean))]
    if (!models.length || models.some(m => m.length > 160 || /[\x00-\x1f]/.test(m))) throw new Error('请至少填写一个有效的模型 ID。')
    if (!models.includes(input.defaultModel)) throw new Error('默认模型必须在模型列表中。')
    if (!Number.isInteger(input.contextWindow) || input.contextWindow < 4096 || input.contextWindow > 10000000) throw new Error('上下文长度须为 4096–10000000 的整数。')
    const previous = input.id ? this.state.providers.find(p => p.id === input.id) : undefined
    if (input.id && !previous) throw new Error('服务商已被删除。')
    const secret = input.apiKey?.trim() ? this.cipher.encrypt(input.apiKey.trim()) : previous?.secret
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    const metadata = input.modelCapabilities ?? (previous?.baseUrl === baseUrl ? previous.modelCapabilities : undefined)
    const modelCapabilities = metadata && Object.fromEntries(models.filter(model => metadata[model] && typeof metadata[model] === 'object').map(model => [model, sanitizeCapabilities(metadata[model])]))
    for (const model of models) {
      const profile = reasoningProfile({ ...input, modelCapabilities }, model)
      if (input.thinking === 'off' && profile.thinkingMode === 'always') throw new Error(`${model} 始终开启思考，不能选择关闭思考。`)
      if (input.thinking === 'max' && ((!profile.reasoningEfforts.some(effort => effort !== 'none') && profile.thinkingMode !== 'always') || profile.thinkingMode === 'none')) throw new Error(`${model} 未声明可用的推理能力。请先读取接口能力或手动配置此模型的推理能力。`)
    }
    const provider: StoredProvider = {
      id: previous?.id ?? randomUUID(), name: input.name.trim(), kind: input.kind,
      baseUrl, protocol: input.protocol, models,
      defaultModel: input.defaultModel, contextWindow: input.contextWindow,
      vision: Boolean(input.vision), thinking: input.thinking, modelCapabilities, apiKeySet: Boolean(secret), secret, enabled: input.enabled ?? previous?.enabled ?? true
    }
    const index = this.state.providers.findIndex(p => p.id === provider.id)
    if (index < 0) this.state.providers.push(provider)
    else this.state.providers[index] = provider
    if (provider.enabled !== false) this.state.activeProviderId ??= provider.id
    this.persist()
    return provider.id
  }
  remove(id: string) {
    this.getProvider(id)
    this.state.providers = this.state.providers.filter(p => p.id !== id)
    if (this.state.activeProviderId === id) this.state.activeProviderId = this.state.providers.find(provider => provider.enabled !== false)?.id ?? null
    this.persist()
  }
  select(id: string) { if (this.getProvider(id).enabled === false) throw new Error('请先启用此服务商。'); this.state.activeProviderId = id; this.persist() }
  setProviderEnabled(id: string, enabled: boolean) {
    const provider = this.state.providers.find(provider => provider.id === id)
    if (!provider) throw new Error('服务商不存在。')
    provider.enabled = enabled
    if (!enabled && this.state.activeProviderId === id) this.state.activeProviderId = this.state.providers.find(provider => provider.enabled !== false)?.id ?? null
    if (enabled && !this.state.activeProviderId) this.state.activeProviderId = id
    this.persist()
  }
  saveModelCapabilities(id: string, models: DiscoveredModel[]) {
    const provider = this.state.providers.find(provider => provider.id === id)
    if (!provider) throw new Error('服务商不存在，请刷新后重试。')
    const metadata = new Map(Object.entries(provider.modelCapabilities ?? {}))
    for (const model of models) {
      if (!provider.models.includes(model.id)) continue
      const capabilities = sanitizeCapabilities(model)
      const previous = metadata.get(model.id)
      if (Object.keys(capabilities).length) metadata.set(model.id, mergeCapabilities(previous, capabilities))
    }
    provider.modelCapabilities = Object.fromEntries(metadata)
    this.persist()
  }
  setSettings(settings: Settings) {
    if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) throw new Error('端口须为 1024–65535 的整数。')
    const timeout = settings.timeout ?? 120
    if (!Number.isInteger(timeout) || timeout < 10 || timeout > 600) throw new Error('超时时间须为 10–600 秒。')
    const theme = settings.theme ?? 'system'
    if (!['system', 'light', 'dark'].includes(theme)) throw new Error('无效的外观设置。')
    const autoCheckUpdates = settings.autoCheckUpdates ?? this.state.settings.autoCheckUpdates ?? true
    const autoDownloadUpdates = settings.autoDownloadUpdates ?? this.state.settings.autoDownloadUpdates ?? true
    const autoInstallUpdates = autoCheckUpdates && autoDownloadUpdates && (settings.autoInstallUpdates ?? this.state.settings.autoInstallUpdates ?? true)
    this.state.settings = { port: settings.port, autoStart: Boolean(settings.autoStart), launchAtLogin: Boolean(settings.launchAtLogin), theme, timeout, includeOriginal: settings.includeOriginal ?? this.state.settings.includeOriginal ?? true, autoCheckUpdates, autoDownloadUpdates, autoInstallUpdates }; this.persist()
  }
  saveTest(id: string, result: { ok: boolean; message: string; latency: number }) {
    const provider = this.state.providers.find(p => p.id === id)
    if (provider) { provider.lastTest = { ...result, at: new Date().toISOString() }; this.persist() }
  }
  addLog(log: RequestLog) { this.state.logs.unshift(log); this.state.logs = this.state.logs.slice(0, 300); this.persist() }
  clearLogs() { this.state.logs = []; this.persist() }
}
