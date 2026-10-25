import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { parse } from 'smol-toml'
import { atomicWrite, Store } from './store'
import type { OriginalStatus, Provider } from '../shared/types'
import { sanitizeCapabilities } from '../shared/model-capabilities'
import { originalModelMetadata } from './original-catalog'

type Json = Record<string, any>
export const ORIGINAL_ID = 'codex-original'
export class OriginalConnection {
  private catalog: Json[] = []
  private identity = ''
  error?: string
  constructor(private home: string, private store: Store) { this.load() }
  private document(): Json {
    const backup = join(this.store.directory, 'codex-backup.json')
    const file = join(this.home, 'config.toml')
    const raw = existsSync(backup) ? JSON.parse(readFileSync(backup, 'utf8')).original : existsSync(file) ? readFileSync(file, 'utf8') : ''
    const doc: Json = raw ? parse(raw) : {}
    if (doc.model_provider === 'fleet_bridge') return {}
    return { ...doc, ...(doc.profile ? doc.profiles?.[doc.profile] : {}) }
  }
  private connection() {
    const doc = this.document()
    const id = doc.model_provider ?? 'openai'
    const config = doc.model_providers?.[id] ?? {}
    const authFile = join(this.home, 'auth.json')
    const auth: Json = existsSync(authFile) ? JSON.parse(readFileSync(authFile, 'utf8')) : {}
    const key = config.experimental_bearer_token || (config.env_key ? process.env[config.env_key] : undefined) || auth.OPENAI_API_KEY || (id === 'openai' ? process.env.OPENAI_API_KEY : undefined)
    const chatgpt = !key && (id === 'openai' || config.requires_openai_auth) && auth.tokens?.access_token
    const baseUrl = (config.base_url || doc.openai_base_url || (id === 'openai' ? process.env.OPENAI_BASE_URL : undefined) || (chatgpt ? 'https://chatgpt.com/backend-api/codex' : 'https://api.openai.com/v1')).replace(/\/$/, '')
    const identity = createHash('sha256').update(JSON.stringify([id, baseUrl, config.env_key, doc.model_catalog_json, doc.model])).digest('hex')
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(key || chatgpt ? { Authorization: `Bearer ${key || chatgpt}` } : {}), ...config.http_headers }
    for (const [name, variable] of Object.entries(config.env_http_headers ?? {})) if (typeof variable === 'string' && process.env[variable]) headers[name] = process.env[variable]!
    if (chatgpt) {
      headers['OpenAI-Beta'] = 'responses=experimental'
      if (auth.tokens.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id
    }
    return { doc, config, id, baseUrl, key: String(key || chatgpt || ''), headers, identity }
  }
  private load() {
    try {
      const connection = this.connection()
      this.identity = connection.identity
      const cache = join(this.store.directory, 'original-models.json')
      if (existsSync(cache)) {
        const saved = JSON.parse(readFileSync(cache, 'utf8'))
        if (saved.identity === this.identity && Array.isArray(saved.models)) this.catalog = saved.models
      }
      if (connection.doc.model_catalog_json) {
        const source = JSON.parse(readFileSync(resolve(this.home, connection.doc.model_catalog_json), 'utf8'))
        if (Array.isArray(source.models)) this.catalog = source.models
      } else if (!this.catalog.length) {
        const cache = join(this.home, 'models_cache.json')
        if (existsSync(cache)) this.catalog = JSON.parse(readFileSync(cache, 'utf8')).models ?? []
      }
    } catch { this.error = '原配置暂时无法读取，请检查 Codex 配置。' }
  }
  get provider(): Provider | undefined {
    try {
      const { doc, config, baseUrl, identity } = this.connection()
      if (identity !== this.identity) { this.catalog = []; this.error = undefined; this.load() }
      const models = [...new Set([doc.model, ...this.catalog.map(model => model.slug)].filter((id): id is string => typeof id === 'string' && !!id && !id.startsWith('fleet/')))]
      if (!models.length) return
      const capabilities = Object.fromEntries(this.catalog.map(model => [model.slug, sanitizeCapabilities({ contextWindow: model.context_window, vision: Array.isArray(model.input_modalities) ? model.input_modalities.includes('image') : undefined, reasoningEfforts: model.supported_reasoning_levels?.map((level: Json) => level.effort), defaultReasoningEffort: model.default_reasoning_level })]))
      return { id: ORIGINAL_ID, name: 'Codex 原配置', kind: 'custom', enabled: this.store.settings.includeOriginal !== false, baseUrl, protocol: config.wire_api === 'chat' ? 'chat' : 'responses', models, defaultModel: doc.model || models[0], contextWindow: doc.model_context_window || 400000, vision: true, thinking: 'auto', apiKeySet: !!this.connection().key, modelCapabilities: capabilities }
    } catch { return }
  }
  get models() { return this.catalog }
  get key() { return this.connection().key }
  headers() { return this.connection().headers }
  url(path: string) {
    const connection = this.connection()
    const url = new URL(`${connection.baseUrl}/${path}`)
    for (const [key, value] of Object.entries(connection.config.query_params ?? {})) url.searchParams.set(key, String(value))
    return url.toString()
  }
  status(): OriginalStatus {
    const provider = this.provider
    return { available: !!provider, enabled: this.store.settings.includeOriginal !== false, name: 'Codex 原配置', models: provider?.models ?? [], defaultModel: provider?.defaultModel, ...(this.error ? { error: this.error } : {}) }
  }
  async refresh() {
    try {
      const connection = this.connection()
      if (!connection.key && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection.baseUrl).hostname)) return
      if (connection.doc.model_catalog_json) { this.load(); return }
      const url = new URL(connection.config.model_catalog_url || this.url('models'))
      url.searchParams.set('client_version', '0.164.0')
      const response = await fetch(url, { headers: connection.headers, signal: AbortSignal.timeout(8000), redirect: 'error' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json() as Json
      const candidates = body.models ?? body.data
      if (!Array.isArray(candidates)) throw new Error('没有模型列表')
      const known = new Map(this.catalog.map(model => [model.slug, model]))
      this.catalog = candidates.slice(0, 500).flatMap(model => {
        const slug = model.slug ?? model.id
        if (typeof slug !== 'string' || !slug || slug.startsWith('fleet/')) return []
        return [{ ...known.get(slug), ...model, slug }]
      })
      if (!body.models && connection.doc.model) {
        const metadata = await originalModelMetadata(this.home, this.store.directory, connection.doc)
        const available = new Map(metadata.map(model => [model.model, model]))
        this.catalog = this.catalog.map(model => {
          const info = available.get(model.slug)
          return info ? { ...model, default_reasoning_level: info.defaultReasoningEffort,
            supported_reasoning_levels: info.supportedReasoningEfforts?.map((level: Json) => ({ effort: level.reasoningEffort, description: level.description })), input_modalities: info.inputModalities } : model
        })
      }
      this.identity = connection.identity
      atomicWrite(join(this.store.directory, 'original-models.json'), JSON.stringify({ identity: this.identity, models: this.catalog }))
      this.error = undefined
    } catch { this.error = '原接口模型列表暂时读取失败，已保留原有模型；可点击刷新重试。' }
  }
}
