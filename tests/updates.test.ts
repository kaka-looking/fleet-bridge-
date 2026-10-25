import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { describe, it, expect, vi } from 'vitest'
import { Updates, githubRepository } from '../src/main/updates'
import type { Settings, UpdateState } from '../src/shared/types'

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
    expect(backend.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true)
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
    expect(backend.checkForUpdates).not.toHaveBeenCalled()
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
})
