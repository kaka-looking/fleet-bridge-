import { app, BrowserWindow, ipcMain, safeStorage, shell, Tray, Menu, nativeImage, dialog, screen } from 'electron'
import { join, dirname } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Store } from './store'
import { Runtime } from './runtime'
import { initialWindowBounds } from './window'
import { formatLogsCsv } from './log-export'
import { autoUpdater } from 'electron-updater'
import { Updates } from './updates'
import type { Settings, WindowState } from '../shared/types'
import { ISSUES_URL, REPOSITORY_URL } from '../shared/project'

if (process.env.FLEET_DATA_DIR) app.setPath('userData', process.env.FLEET_DATA_DIR)
app.commandLine.appendSwitch('disable-lcd-text')
let window: BrowserWindow | undefined
let tray: Tray | undefined
let runtime: Runtime
let updates: Updates | undefined
let quitting = false
let quitPending = false
const iconPath = () => join(app.getAppPath(), 'resources', 'icon.png')
const single = app.requestSingleInstanceLock()
if (!single) app.quit()
else {
  app.on('second-instance', () => { window?.show(); window?.focus() })
  app.whenReady().then(async () => {
    app.setAppUserModelId('dev.fleet.bridge')
    const store = new Store(join(app.getPath('userData'), 'data'), {
      label: process.platform === 'win32' ? 'Windows DPAPI 加密' : '系统钥匙串加密',
      encrypt(value) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储暂不可用，无法保存 API Key。请确认系统账户已登录。')
        return safeStorage.encryptString(value).toString('base64')
      },
      decrypt(value) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储暂不可用，无法读取 API Key。')
        return safeStorage.decryptString(Buffer.from(value, 'base64'))
      }
    })
    runtime = new Runtime(store, process.env.FLEET_CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex'))
    await runtime.init()
    const packageInfo = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
    let resumeGateway = false
    updates = new Updates(autoUpdater, {
      version: app.getVersion(), repository: packageInfo.repository?.url ?? packageInfo.repository,
      packaged: app.isPackaged, portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
      installed: existsSync(join(dirname(process.execPath), 'Uninstall Fleet Bridge.exe')),
      platform: process.platform, feedExists: existsSync(join(process.resourcesPath, 'app-update.yml'))
    }, () => store.settings, state => { if (window && !window.isDestroyed()) window.webContents.send('fleet:update-state', state) }, {
      inflight: () => runtime.gateway.inflight,
      prepare: async () => {
        resumeGateway = runtime.gateway.running
        await runtime.gateway.stop()
        quitting = true
      },
      rollback: async () => { quitting = false; if (resumeGateway) await runtime.gateway.start() }
    })
    for (const method of ['updateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'openUpdatePage'] as const) {
      ipcMain.handle(`fleet:${method}`, async event => {
        if (event.sender !== window?.webContents || !updates) throw new Error('非法调用来源。')
        if (method === 'updateState') return updates.snapshot()
        if (method === 'checkForUpdates') return updates.check()
        if (method === 'downloadUpdate') return updates.download()
        if (method === 'installUpdate') return updates.install()
        const url = updates.snapshot().releasesUrl
        if (!url) throw new Error('尚未配置 GitHub 发布仓库。')
        await shell.openExternal(url)
      })
    }
    const methods = ['snapshot', 'saveProvider', 'saveAndConnectProvider', 'deleteProvider', 'selectProvider', 'setProviderEnabled', 'setOriginalEnabled', 'refreshOriginal', 'enableMaxEffort', 'testProvider', 'discoverModels', 'discoverModelDetails', 'setGateway', 'connectCodex', 'restoreCodex', 'saveSettings', 'clearLogs'] as const
    for (const method of methods) ipcMain.handle(`fleet:${method}`, async (event, ...args) => {
      if (event.sender !== window?.webContents) throw new Error('非法调用来源。')
      const previousSettings = store.settings
      const result = await (runtime[method] as (...params: any[]) => any).apply(runtime, args)
      if (method === 'saveSettings') updates?.settingsChanged(previousSettings)
      if (method === 'saveSettings' && !process.env.FLEET_DATA_DIR) app.setLoginItemSettings({
        openAtLogin: (args[0] as Settings).launchAtLogin,
        path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
        args: app.isPackaged ? [] : [app.getAppPath()]
      })
      updateTray()
      return result
    })
    ipcMain.handle('fleet:openDataFolder', () => shell.openPath(store.directory))
    ipcMain.handle('fleet:openCodexFolder', () => shell.openPath(dirname(runtime.codex.status().configPath)))
    ipcMain.handle('fleet:exportLogs', async event => {
      if (event.sender !== window?.webContents || !window) throw new Error('非法调用来源。')
      const result = await dialog.showSaveDialog(window, { title: '导出连接记录', defaultPath: `舰桥连接记录-${new Date().toISOString().slice(0, 10)}.csv`, filters: [{ name: 'CSV 表格', extensions: ['csv'] }] })
      if (result.canceled || !result.filePath) return false
      await writeFile(result.filePath, formatLogsCsv(store.logs), 'utf8')
      return true
    })
    ipcMain.handle('fleet:openCodex', () => shell.openExternal('codex://'))
    ipcMain.handle('fleet:openRepository', event => {
      if (event.sender !== window?.webContents) throw new Error('非法调用来源。')
      return shell.openExternal(REPOSITORY_URL)
    })
    ipcMain.handle('fleet:openIssues', event => {
      if (event.sender !== window?.webContents) throw new Error('非法调用来源。')
      return shell.openExternal(ISSUES_URL)
    })
    ipcMain.handle('fleet:windowState', event => {
      if (event.sender !== window?.webContents) throw new Error('非法调用来源。')
      return windowState()
    })
    ipcMain.handle('fleet:window', (event, action) => {
      if (event.sender !== window?.webContents || !window) throw new Error('非法调用来源。')
      if (action === 'minimize') window.minimize()
      else if (action === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize() }
      else if (action === 'close') window.hide()
      else throw new Error('未知的窗口操作。')
    })
    createWindow()
    updates.start()
    tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 20, height: 20 }))
    tray.on('click', () => { window?.show(); window?.focus() })
    updateTray()
    app.on('activate', () => { window?.show(); window?.focus() })
  }).catch(error => { dialog.showErrorBox('舰桥启动失败', error.message); app.exit(1) })
}
function createWindow() {
  const bounds = initialWindowBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea)
  window = new BrowserWindow({
    ...bounds, minWidth: Math.min(1000, bounds.width), minHeight: Math.min(640, bounds.height), show: false,
    resizable: true, minimizable: true, maximizable: true, fullscreen: false,
    title: '舰桥 · Fleet Bridge', frame: false, backgroundColor: '#f9fbfa', icon: iconPath(),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  window.on('ready-to-show', () => window?.show())
  const broadcastState = () => window?.webContents.send('fleet:window-state', windowState())
  window.on('maximize', broadcastState).on('unmaximize', broadcastState)
    .on('minimize', broadcastState).on('restore', broadcastState)
    .on('show', broadcastState).on('hide', broadcastState)
  window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide() } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => { event.preventDefault() })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}
function windowState(): WindowState {
  return { maximized: window?.isMaximized() ?? false, minimized: window?.isMinimized() ?? false, visible: window?.isVisible() ?? false }
}
function updateTray() {
  if (!tray || !runtime) return
  const active = runtime.store.providers.find(p => p.id === runtime.store.activeProviderId)
  tray.setToolTip(`舰桥 · ${runtime.gateway.running ? '代理运行中' : '代理已停止'}${active ? ` · ${active.name}` : ''}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开舰桥', click: () => { window?.show(); window?.focus() } },
    { type: 'separator' },
    ...runtime.store.providers.map(provider => ({ label: provider.name, type: 'radio' as const, enabled: provider.enabled !== false, checked: active?.id === provider.id, click: () => { runtime.selectProvider(provider.id); updateTray() } })),
    { type: 'separator' },
    { label: runtime.gateway.running ? '停止本地代理' : '启动本地代理', click: () => { void runtime.setGateway(!runtime.gateway.running).then(updateTray).catch(error => dialog.showErrorBox('代理操作失败', error.message)) } },
    { label: '退出舰桥', click: () => { app.quit() } }
  ]))
}
app.on('window-all-closed', () => { /* Keep the local gateway running in the tray. */ })
app.on('before-quit', event => {
  updates?.stop()
  if (!quitting && runtime) {
    event.preventDefault()
    if (quitPending) return
    quitPending = true
    // Only a real exit installs an enabled, verified update. Hiding the window
    // leaves the gateway running. An active model request defers the update.
    void (async () => {
      await updates?.installOnQuit().catch(() => {})
      await runtime.gateway.stop()
    })().finally(() => { quitting = true; tray?.destroy(); app.quit() })
  }
})
