import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, it, expect, vi } from 'vitest'
import { Updates, githubRepository } from '../src/main/updates'
import type { Settings, UpdateState } from '../src/shared/types'
import packageInfo from '../package.json'
import lockInfo from '../package-lock.json'
import { REPOSITORY_URL } from '../src/shared/project'

const { releaseConfiguration, validateTag } = createRequire(import.meta.url)('../scripts/release-config.cjs')
function fixture(options = {}, initial: Partial<Settings> = {}) {
  const backend = Object.assign(new EventEmitter(), {
    autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true, disableWebInstaller: false,
    checkForUpdates: vi.fn(async () => { backend.emit('update-available', { version: '0.2.0' }); return null }),
    downloadUpdate: vi.fn(async () => { backend.emit('download-progress', { percent: 42 }); backend.emit('update-downloaded', { version: '0.2.0' }); return [] }),
    quitAndInstall: vi.fn()
  })
  const settings: Settings = { port: 24680, autoStart: true, launchAtLogin: false, ...initial }
  const states: UpdateState[] = []
  const installation = { inflight: vi.fn(() => 0), prepare: vi.fn(async () => {}), rollback: vi.fn(async () => {}) }
  const updates = new Updates(backend as any, { version: '0.1.6', repository: 'https://github.com/example/fleet-bridge.git', packaged: true, portable: false, installed: true, platform: 'win32', feedExists: true, ...options }, () => settings, state => states.push(state), installation)
  return { backend, settings, states, installation, updates }
}
describe('GitHub application updates', () => {
  it('automatically checks and downloads without installing or quitting an active app', async () => {
    const { backend, updates, installation, states } = fixture()
    expect(backend.autoDownload).toBe(false)
    expect(backend.autoInstallOnAppQuit).toBe(false)
    expect(backend.allowPrerelease).toBe(false)
    expect(backend.allowDowngrade).toBe(false)
    const result = await updates.check()
    expect(result).toMatchObject({ phase: 'downloaded', version: '0.2.0', percent: 100 })
    expect(states.some(state => state.phase === 'downloading' && state.percent === 42)).toBe(true)
    expect(installation.prepare).not.toHaveBeenCalled()
    expect(backend.quitAndInstall).not.toHaveBeenCalled()
  })
  it('respects manual download and avoids concurrent duplicate checks or downloads', async () => {
    const { backend, updates } = fixture({}, { autoDownloadUpdates: false })
    const [first, second] = await Promise.all([updates.check(), updates.check()])
    expect(first.phase).toBe('available'); expect(second.phase).toBe('available')
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(backend.downloadUpdate).not.toHaveBeenCalled()
    await Promise.all([updates.download(), updates.download()])
    expect(backend.downloadUpdate).toHaveBeenCalledTimes(1)
  })
  it('blocks installation during a model request and only prepares once the user retries while idle', async () => {
    const { backend, updates, installation } = fixture()
    await expect(updates.install()).rejects.toThrow('下载')
    await updates.check()
    installation.inflight.mockReturnValue(1)
    await expect(updates.install()).rejects.toThrow('模型请求')
    expect(installation.prepare).not.toHaveBeenCalled()
    installation.inflight.mockReturnValue(0)
    await Promise.all([updates.install(), updates.install()])
    expect(installation.prepare).toHaveBeenCalledTimes(1)
    expect(backend.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true)
    expect(updates.snapshot().message).toContain('重新打开')
  })
  it('keeps the first-install wizard and custom installation directory enabled', () => {
    const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
    expect(config.nsis).toMatchObject({ oneClick: false, allowToChangeInstallationDirectory: true })
  })
  it('does not install twice when a manual restart overlaps the quit handler', async () => {
    const { backend, updates, installation } = fixture()
    await updates.check()
    await Promise.all([updates.install(), updates.installOnQuit()])
    expect(installation.prepare).toHaveBeenCalledTimes(1)
    expect(backend.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true)
  })
  it('defaults to silent installation on real exit without restarting the app', async () => {
    const { backend, updates, installation } = fixture()
    await updates.check()
    expect(updates.snapshot().message).toContain('下次启动')
    // Downloading never stops the gateway or installs while the app is in use.
    expect(installation.prepare).not.toHaveBeenCalled()
    await Promise.all([updates.installOnQuit(), updates.installOnQuit()])
    expect(installation.prepare).toHaveBeenCalledTimes(1)
    expect(backend.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, false)
  })
  it.each([
    { autoInstallUpdates: false },
    { autoInstallUpdates: true, autoCheckUpdates: false },
    { autoInstallUpdates: true, autoDownloadUpdates: false }
  ])('does not install on exit when automatic updating is disabled: %j', async settings => {
    const { backend, updates, installation } = fixture({}, settings)
    await updates.check()
    if (updates.snapshot().phase === 'available') await updates.download()
    await updates.installOnQuit()
    expect(backend.quitAndInstall).not.toHaveBeenCalled()
    expect(installation.prepare).not.toHaveBeenCalled()
  })
  it('defers automatic installation during a model request and permits it on a later idle exit', async () => {
    const { backend, updates, installation } = fixture({}, { autoInstallUpdates: true })
    await updates.installOnQuit()
    await updates.check()
    installation.inflight.mockReturnValue(1)
    await updates.installOnQuit()
    expect(updates.snapshot().phase).toBe('downloaded')
    expect(installation.prepare).not.toHaveBeenCalled()
    installation.inflight.mockReturnValue(0)
    await updates.installOnQuit()
    expect(backend.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, false)
  })
  it('honors disabling automatic installation after an update has already downloaded', async () => {
    const { backend, updates, settings } = fixture({}, { autoInstallUpdates: true })
    await updates.check()
    const previous = { ...settings }
    settings.autoInstallUpdates = false
    updates.settingsChanged(previous)
    expect(updates.snapshot().message).toContain('手动')
    await updates.installOnQuit()
    expect(backend.quitAndInstall).not.toHaveBeenCalled()
    // Manual restart remains available even when automatic installation is off.
    await updates.install()
    expect(backend.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true)
  })
  it('checks immediately when automatic updating is enabled and uses an already downloaded update', async () => {
    const { backend, updates, settings } = fixture({}, { autoCheckUpdates: false, autoDownloadUpdates: false })
    const previous = { ...settings }
    Object.assign(settings, { autoCheckUpdates: true, autoDownloadUpdates: true, autoInstallUpdates: true })
    updates.settingsChanged(previous)
    await vi.waitFor(() => expect(updates.snapshot().phase).toBe('downloaded'))
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(backend.quitAndInstall).not.toHaveBeenCalled()
    await updates.installOnQuit()
    expect(backend.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, false)
  })
  it('downloads an available update immediately when automatic downloading is enabled', async () => {
    const { backend, updates, settings } = fixture({}, { autoDownloadUpdates: false })
    await updates.check()
    const previous = { ...settings }
    settings.autoDownloadUpdates = true
    updates.settingsChanged(previous)
    await vi.waitFor(() => expect(updates.snapshot().phase).toBe('downloaded'))
    expect(backend.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(backend.quitAndInstall).not.toHaveBeenCalled()
  })
  it('never installs an unverified or failed download on exit', async () => {
    const { backend, updates, installation } = fixture({}, { autoInstallUpdates: true })
    backend.downloadUpdate.mockRejectedValueOnce(new Error('checksum mismatch'))
    await updates.check()
    await updates.installOnQuit()
    expect(backend.quitAndInstall).not.toHaveBeenCalled()
    expect(installation.prepare).not.toHaveBeenCalled()
  })
  it('rolls back a failed automatic installation without leaving the app in an installing state', async () => {
    const { backend, updates, installation } = fixture({}, { autoInstallUpdates: true })
    backend.quitAndInstall.mockImplementationOnce(() => { throw new Error('installer failed') })
    await updates.check()
    await expect(updates.installOnQuit()).rejects.toThrow('installer failed')
    expect(installation.rollback).toHaveBeenCalledTimes(1)
    expect(updates.snapshot().phase).toBe('error')
    updates.stop()
  })
  it('recovers the proxy if the installer emits an asynchronous error', async () => {
    const { backend, updates, installation } = fixture()
    await updates.check(); await updates.install()
    backend.emit('error', new Error('installer spawn failed'))
    await vi.waitFor(() => expect(installation.rollback).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(updates.snapshot().phase).toBe('error'))
    updates.stop()
  })
  it('keeps failed downloads retryable and removes URLs from user-facing errors', async () => {
    const { backend, updates, installation } = fixture()
    backend.downloadUpdate.mockRejectedValueOnce(new Error('checksum mismatch https://example.test/secret?token=abc'))
    expect((await updates.check()).phase).toBe('error')
    expect(updates.snapshot().message).not.toContain('token=abc')
    expect(installation.prepare).not.toHaveBeenCalled()
    expect((await updates.download()).phase).toBe('downloaded')
  })
  it.each([
    [{ packaged: false }, 'development'], [{ portable: true }, 'portable'], [{ installed: false }, 'portable'],
    [{ repository: undefined }, 'unconfigured'], [{ feedExists: false }, 'unconfigured'], [{ platform: 'linux' }, 'unsupported']
  ])('does not attempt automatic installation for %j', async (options, mode) => {
    const { backend, updates } = fixture(options)
    expect(updates.snapshot()).toMatchObject({ mode, phase: 'disabled' })
    await updates.check(); await updates.download()
    await updates.installOnQuit()
    expect(backend.checkForUpdates).not.toHaveBeenCalled()
    expect(backend.quitAndInstall).not.toHaveBeenCalled()
    await expect(updates.install()).rejects.toThrow()
  })
  it('checks after startup and every six hours, respecting the persisted opt-out', async () => {
    vi.useFakeTimers()
    const { backend, updates, settings } = fixture({}, { autoCheckUpdates: false })
    try {
      backend.checkForUpdates.mockImplementation(async () => { backend.emit('update-not-available', { version: '0.1.6' }); return null })
      updates.start()
      await vi.advanceTimersByTimeAsync(15000)
      expect(backend.checkForUpdates).not.toHaveBeenCalled()
      settings.autoCheckUpdates = true
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
      expect(backend.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(updates.snapshot().phase).toBe('current')
    } finally { updates.stop(); vi.useRealTimers() }
  })
  it('only builds feeds from a valid GitHub repository and enforces matching release tags', () => {
    expect(githubRepository({ url: 'git+https://github.com/owner/project.git' })).toBe('owner/project')
    expect(githubRepository('https://evil.test/owner/project')).toBeUndefined()
    expect(githubRepository('https://github.com/owner/project?token=abc')).toBeUndefined()
    expect(releaseConfiguration({}, {}).publish).toBeNull()
    expect(releaseConfiguration({ GITHUB_REPOSITORY: 'owner/project' }, {})).toMatchObject({ publish: [{ provider: 'github', owner: 'owner', repo: 'project' }], extraMetadata: { repository: { url: 'https://github.com/owner/project.git' } } })
    expect(() => releaseConfiguration({ GITHUB_REPOSITORY: 'https://evil.test/a/b' }, {})).toThrow()
    expect(() => validateTag('v0.1.6', '0.1.6')).not.toThrow()
    expect(() => validateTag('v0.1.5', '0.1.6')).toThrow()
  })
  it('configures local release builds and the source link for the actual public repository', () => {
    expect(packageInfo.version).toBe(lockInfo.version)
    expect(packageInfo.version).toBe(lockInfo.packages[''].version)
    expect(packageInfo.license).toBe('SEE LICENSE IN LICENSE')
    expect(lockInfo.packages[''].license).toBe(packageInfo.license)
    expect(githubRepository(packageInfo.repository)).toBe('kaka-looking/fleet-bridge-')
    expect(REPOSITORY_URL).toBe('https://github.com/kaka-looking/fleet-bridge-')
    expect(releaseConfiguration({}, packageInfo)).toMatchObject({
      publish: [{ provider: 'github', owner: 'kaka-looking', repo: 'fleet-bridge-' }],
      extraMetadata: { repository: { url: `${REPOSITORY_URL}.git` } }
    })
    expect(() => validateTag(`v${packageInfo.version}`, packageInfo.version)).not.toThrow()
  })
})
