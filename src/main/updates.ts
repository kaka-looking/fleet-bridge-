import type { AppUpdater } from 'electron-updater'
import type { Settings, UpdateState } from '../shared/types'

type Backend = Pick<AppUpdater, 'on' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'autoDownload' | 'autoInstallOnAppQuit' | 'allowPrerelease' | 'allowDowngrade' | 'disableWebInstaller'>
export function githubRepository(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value : value && typeof value === 'object' && 'url' in value ? (value as { url: unknown }).url : undefined
  if (typeof raw !== 'string') return
  const match = /^(?:git\+)?https:\/\/github\.com\/([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+?)(?:\.git)?\/?$/i.exec(raw.trim())
  if (match && !['.', '..'].includes(match[2])) return `${match[1]}/${match[2]}`
}

/** Owns update state; the backend verifies and installs the downloaded NSIS package. */
export class Updates {
  private state: UpdateState
  private checking?: Promise<UpdateState>
  private downloading?: Promise<UpdateState>
  private startup?: ReturnType<typeof setTimeout>
  private interval?: ReturnType<typeof setInterval>
  private installRequested = false
  constructor(
    private backend: Backend,
    options: { version: string; repository?: string; packaged: boolean; portable: boolean; installed: boolean; platform: string; feedExists: boolean },
    private settings: () => Settings,
    private changed: (state: UpdateState) => void,
    private installation: { inflight: () => number; prepare: () => Promise<void>; rollback: () => Promise<void> }
  ) {
    const repository = githubRepository(options.repository)
    const mode: UpdateState['mode'] = !options.packaged ? 'development' : options.platform !== 'win32' ? 'unsupported' : !repository || !options.feedExists ? 'unconfigured' : options.portable || !options.installed ? 'portable' : 'installer'
    const message = mode === 'development' ? '开发模式不执行自动安装更新。'
      : mode === 'unsupported' ? '当前平台尚未提供自动更新安装包。'
      : mode === 'unconfigured' ? '尚未配置 GitHub 发布仓库；从仓库发布的安装版可自动更新。'
      : mode === 'portable' ? '便携版请从发布页下载安装版，之后即可在程序中自动更新。'
      : '默认自动检查、下载并校验新版本，退出时静默安装，下次启动使用新版；可在设置中关闭。'
    this.state = { mode, phase: mode === 'installer' ? 'idle' : 'disabled', currentVersion: options.version, message, ...(repository ? { releasesUrl: `https://github.com/${repository}/releases/latest` } : {}) }
    backend.autoDownload = false
    // The app owns quitting: stop the gateway first, then install silently only
    // unless the user opted out. Never let the updater race the tray/quit handlers.
    backend.autoInstallOnAppQuit = false
    backend.allowPrerelease = false
    backend.allowDowngrade = false
    backend.disableWebInstaller = true
    backend.on('checking-for-update', () => this.patch({ phase: 'checking', message: '正在检查 GitHub 新版本…' }))
    backend.on('update-not-available', () => this.patch({ phase: 'current', version: undefined, percent: undefined, checkedAt: new Date().toISOString(), message: '当前已是最新正式版。' }))
    backend.on('update-available', info => {
      this.patch({ phase: 'available', version: info.version, percent: undefined, checkedAt: new Date().toISOString(), message: `发现新版本 v${info.version}。` })
    })
    backend.on('download-progress', progress => this.patch({ phase: 'downloading', percent: Math.max(0, Math.min(100, progress.percent)), message: '正在后台下载更新，模型连接可继续使用。' }))
    backend.on('update-downloaded', info => this.patch({ phase: 'downloaded', version: info.version, percent: 100, message: this.downloadedMessage() }))
    backend.on('error', error => {
      if (!this.installRequested) { this.fail(error); return }
      this.installRequested = false
      void this.installation.rollback().catch(() => {}).then(() => { this.fail(error); this.start() })
    })
  }
  snapshot() { return { ...this.state } }
  private automaticInstallEnabled() {
    const settings = this.settings()
    return settings.autoInstallUpdates !== false && settings.autoCheckUpdates !== false && settings.autoDownloadUpdates !== false
  }
  private downloadedMessage() {
    return this.automaticInstallEnabled()
      ? '更新已下载并校验；退出舰桥时自动静默安装，下次启动使用新版。收起到托盘不会安装。'
      : '更新已下载并校验；可手动重启安装，或开启自动更新，在退出时安装。'
  }
  private patch(patch: Partial<UpdateState>) { this.state = { ...this.state, ...patch }; this.changed(this.snapshot()) }
  private fail(error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    // No request headers or download query strings are surfaced to the renderer.
    this.patch({ phase: 'error', percent: undefined, message: `更新失败，可稍后重试。${detail.replace(/https?:\/\/[^\s"'<>]+/g, '[下载地址]').slice(0, 260)}` })
  }
  start() {
    if (this.state.mode !== 'installer' || this.interval) return
    const automatic = () => { if (this.settings().autoCheckUpdates !== false) void this.check() }
    this.startup = setTimeout(automatic, 15000); this.startup.unref()
    this.interval = setInterval(automatic, 6 * 60 * 60 * 1000); this.interval.unref()
  }
  stop() { clearTimeout(this.startup); clearInterval(this.interval); this.startup = undefined; this.interval = undefined }
  settingsChanged(previous: Settings) {
    if (this.state.mode !== 'installer' || this.installRequested) return
    if (this.state.phase === 'downloaded') this.patch({ message: this.downloadedMessage() })
    const settings = this.settings()
    const enabled = settings.autoCheckUpdates !== false && (previous.autoCheckUpdates === false || (settings.autoInstallUpdates !== false && previous.autoInstallUpdates === false))
    if (enabled) void this.check()
    else if (settings.autoDownloadUpdates !== false && previous.autoDownloadUpdates === false && this.state.phase === 'available') void this.download()
  }
  async check(): Promise<UpdateState> {
    if (this.state.mode !== 'installer' || ['downloaded', 'downloading', 'installing'].includes(this.state.phase)) return this.snapshot()
    if (this.checking) return this.checking
    this.checking = (async () => {
      try {
        this.patch({ phase: 'checking', message: '正在检查 GitHub 新版本…' })
        await this.backend.checkForUpdates()
        if (this.snapshot().phase === 'available' && this.settings().autoDownloadUpdates !== false) await this.download()
      } catch (error) { this.fail(error) }
      return this.snapshot()
    })().finally(() => { this.checking = undefined })
    return this.checking
  }
  async download(): Promise<UpdateState> {
    if (this.downloading) return this.downloading
    if (this.state.mode !== 'installer' || !this.state.version || !['available', 'error'].includes(this.state.phase)) return this.snapshot()
    this.downloading = (async () => {
      try { this.patch({ phase: 'downloading', percent: 0, message: '正在下载更新…' }); await this.backend.downloadUpdate() }
      catch (error) { this.fail(error) }
      return this.snapshot()
    })().finally(() => { this.downloading = undefined })
    return this.downloading
  }
  async installOnQuit(): Promise<void> {
    if (this.state.mode !== 'installer' || !this.automaticInstallEnabled() || this.state.phase !== 'downloaded' || this.installation.inflight() > 0) return
    await this.installDownloaded(true)
  }
  async install() { await this.installDownloaded(false) }
  private async installDownloaded(silent: boolean) {
    if (this.installRequested) return
    if (this.state.mode !== 'installer' || this.state.phase !== 'downloaded') throw new Error('请先下载并校验更新。')
    if (this.installation.inflight() > 0) throw new Error('仍有模型请求进行中，请结束请求后再重启安装。')
    this.installRequested = true
    this.stop()
    this.patch({ phase: 'installing', message: silent ? '正在静默安装更新，下次启动使用新版…' : '正在退出舰桥并安装更新…' })
    try { await this.installation.prepare(); this.backend.quitAndInstall(silent, !silent) }
    catch (error) {
      if (this.installRequested) {
        this.installRequested = false
        await this.installation.rollback().catch(() => {})
        this.fail(error); this.start()
      }
      throw error
    }
  }
}
