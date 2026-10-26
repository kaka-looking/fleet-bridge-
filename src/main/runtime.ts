import { Store } from './store'
import { Gateway, discoverModelDetails, discoverModels, testConnection } from './gateway'
import { CodexConfig } from './codex'
import type { ProviderInput, ProviderSaveResult, Settings, Snapshot } from '../shared/types'
import { version } from '../../package.json'

export class Runtime {
  readonly gateway: Gateway
  readonly codex: CodexConfig
  constructor(readonly store: Store, codexHome: string) { this.codex = new CodexConfig(codexHome, store); this.gateway = new Gateway(store, this.codex.original) }
  async init() { this.codex.writeCatalog(); if (this.store.settings.autoStart) await this.gateway.start().catch(() => {}) }
  snapshot(): Snapshot {
    return { providers: this.store.providers, activeProviderId: this.store.activeProviderId, settings: this.store.settings,
      gateway: { running: this.gateway.running, url: this.gateway.url, error: this.gateway.error, inflight: this.gateway.inflight },
      codex: this.codex.status(), logs: this.store.logs, usage: this.store.usage, dataPath: this.store.directory, vault: this.store.cipher.label, version, originalCodex: this.codex.original.status() }
  }
  saveProvider(input: ProviderInput) { this.store.save(input); this.codex.writeCatalog(); return this.snapshot() }
  async saveAndConnectProvider(input: ProviderInput): Promise<ProviderSaveResult> {
    const providerId = this.store.save(input)
    const provider = this.store.getProvider(providerId)
    const key = this.store.key(providerId)
    // Metadata is optional on OpenAI-compatible endpoints; saving still works offline.
    if (key || ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(provider.baseUrl).hostname)) {
      try { this.store.saveModelCapabilities(providerId, await discoverModelDetails(provider.baseUrl, key, 5000)) }
      catch { /* Keep known model profiles and previously discovered capabilities. */ }
    }
    this.codex.writeCatalog()
    let codexError: string | undefined
    try { await this.connectCodex() }
    catch (error) { codexError = error instanceof Error ? error.message : String(error) }
    return { snapshot: this.snapshot(), providerId, codexError }
  }
  deleteProvider(id: string) {
    if (this.store.providers.length === 1 && this.codex.status().connected && !(this.codex.original.status().available && this.codex.original.status().enabled)) throw new Error('请先恢复 Codex 原配置，再删除最后一个服务商。')
    this.store.remove(id); this.codex.writeCatalog(); return this.snapshot()
  }
  selectProvider(id: string) { this.store.select(id); this.codex.writeCatalog(); return this.snapshot() }
  setProviderEnabled(id: string, enabled: boolean) { this.store.setProviderEnabled(id, enabled); this.codex.writeCatalog(); return this.snapshot() }
  setOriginalEnabled(enabled: boolean) { this.store.setSettings({ ...this.store.settings, includeOriginal: enabled }); this.codex.writeCatalog(); return this.snapshot() }
  async refreshOriginal() { await this.codex.original.refresh(); this.codex.writeCatalog(); return this.snapshot() }
  enableMaxEffort() { this.codex.enableMaxEffort(); return this.snapshot() }
  async testProvider(id: string) { const result = await testConnection(this.store.getProvider(id), this.store.key(id)); this.store.saveTest(id, result); return result }
  async discoverModels(input: { id?: string; baseUrl: string; apiKey?: string }) { return discoverModels(input.baseUrl, input.apiKey?.trim() || (input.id ? this.store.key(input.id) : '')) }
  async discoverModelDetails(input: { id?: string; baseUrl: string; apiKey?: string }) { return discoverModelDetails(input.baseUrl, input.apiKey?.trim() || (input.id ? this.store.key(input.id) : '')) }
  async setGateway(running: boolean) { if (running) await this.gateway.start(); else await this.gateway.stop(); return this.snapshot() }
  async connectCodex() { await this.gateway.start(); if (this.store.settings.includeOriginal !== false) await this.codex.original.refresh(); this.codex.connect(); return this.snapshot() }
  restoreCodex() { this.codex.restore(); return this.snapshot() }
  async saveSettings(settings: Settings) {
    if (settings.port !== this.store.settings.port && this.codex.status().connected) throw new Error('请先恢复 Codex 原配置，再修改端口并重新接入。')
    const previous = this.store.settings
    const running = this.gateway.running
    this.store.setSettings(settings)
    if (running && settings.port !== previous.port) {
      await this.gateway.stop()
      try { await this.gateway.start() }
      catch (error) { this.store.setSettings(previous); await this.gateway.start().catch(() => {}); throw error }
    }
    return this.snapshot()
  }
  clearLogs(clearUsage = false) { this.store.clearLogs(clearUsage); return this.snapshot() }
}
