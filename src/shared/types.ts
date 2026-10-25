export type ProviderKind = 'deepseek' | 'glm' | 'kimi' | 'qwen' | 'minimax' | 'custom'
export type Protocol = 'chat' | 'responses'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export interface ModelCapabilities {
  contextWindow?: number
  vision?: boolean
  reasoningEfforts?: ReasoningEffort[]
  defaultReasoningEffort?: ReasoningEffort
  thinkingControl?: 'thinking' | 'enable_thinking' | 'none'
  thinkingMode?: 'toggle' | 'always' | 'none'
  reasoningOverride?: boolean
}
export interface DiscoveredModel extends ModelCapabilities { id: string }

export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  protocol: Protocol
  models: string[]
  defaultModel: string
  contextWindow: number
  vision: boolean
  thinking: 'auto' | 'off' | 'on' | 'max'
  modelCapabilities?: Record<string, ModelCapabilities>
  apiKeySet: boolean
  enabled?: boolean
  lastTest?: { ok: boolean; message: string; latency: number; at: string }
}
export type ProviderInput = Omit<Provider, 'id' | 'apiKeySet' | 'lastTest'> & { id?: string; apiKey?: string }
export interface Settings {
  port: number; autoStart: boolean; launchAtLogin: boolean
  theme?: 'system' | 'light' | 'dark'
  timeout?: number
  includeOriginal?: boolean
  autoCheckUpdates?: boolean
  autoDownloadUpdates?: boolean
  autoInstallUpdates?: boolean
}
export interface RequestLog {
  id: string
  at: string
  provider: string
  model: string
  status: 'ok' | 'error' | 'cancelled' | 'interrupted' | 'timeout' | 'incomplete'
  latency: number
  inputTokens: number
  outputTokens: number
  path?: string
  error?: string
  reasoningEffort?: string
  upstreamHttpStatus?: number
  upstreamOutcome?: 'completed' | 'failed' | 'unknown' | 'not_sent'
  failureStage?: 'prepare' | 'connect' | 'receive' | 'convert' | 'deliver'
  upstreamRequestId?: string
  errorCode?: string
  usageKnown?: boolean
  note?: string
  legacyRecord?: boolean
}
export interface CodexStatus {
  connected: boolean
  configPath: string
  hasBackup: boolean
  conflict?: string
  maxEffortEnabled?: boolean
}
export interface OriginalStatus { available: boolean; enabled: boolean; name: string; models: string[]; defaultModel?: string; error?: string }
export interface Snapshot {
  providers: Provider[]
  activeProviderId: string | null
  settings: Settings
  gateway: { running: boolean; url: string; error?: string; inflight: number }
  codex: CodexStatus
  logs: RequestLog[]
  dataPath: string
  vault: string
  version: string
  originalCodex?: OriginalStatus
}
export interface ProviderSaveResult {
  snapshot: Snapshot
  providerId: string
  codexError?: string
}
export interface WindowState { maximized: boolean; minimized: boolean; visible: boolean }
export interface UpdateState {
  mode: 'installer' | 'portable' | 'development' | 'unconfigured' | 'unsupported'
  phase: 'disabled' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'
  currentVersion: string
  version?: string
  percent?: number
  checkedAt?: string
  releasesUrl?: string
  message: string
}
export interface FleetAPI {
  snapshot(): Promise<Snapshot>
  saveProvider(input: ProviderInput): Promise<Snapshot>
  saveAndConnectProvider(input: ProviderInput): Promise<ProviderSaveResult>
  deleteProvider(id: string): Promise<Snapshot>
  selectProvider(id: string): Promise<Snapshot>
  setProviderEnabled(id: string, enabled: boolean): Promise<Snapshot>
  setOriginalEnabled(enabled: boolean): Promise<Snapshot>
  refreshOriginal(): Promise<Snapshot>
  enableMaxEffort(): Promise<Snapshot>
  testProvider(id: string): Promise<{ ok: boolean; message: string; latency: number }>
  discoverModels(input: { id?: string; baseUrl: string; apiKey?: string }): Promise<string[]>
  discoverModelDetails(input: { id?: string; baseUrl: string; apiKey?: string }): Promise<DiscoveredModel[]>
  setGateway(running: boolean): Promise<Snapshot>
  connectCodex(): Promise<Snapshot>
  restoreCodex(): Promise<Snapshot>
  saveSettings(settings: Settings): Promise<Snapshot>
  clearLogs(): Promise<Snapshot>
  openDataFolder(): Promise<void>
  openCodexFolder(): Promise<void>
  exportLogs(): Promise<boolean>
  openCodex(): Promise<void>
  window(action: 'minimize' | 'maximize' | 'close'): Promise<void>
  windowState(): Promise<WindowState>
  onWindowState(listener: (state: WindowState) => void): () => void
  updateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  installUpdate(): Promise<void>
  openUpdatePage(): Promise<void>
  openRepository(): Promise<void>
  onUpdateState(listener: (state: UpdateState) => void): () => void
}
