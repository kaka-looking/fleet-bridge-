import { contextBridge, ipcRenderer } from 'electron'
import type { FleetAPI } from '../shared/types'

const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke(`fleet:${method}`, ...args)
const api: FleetAPI = {
  snapshot: () => invoke('snapshot'),
  saveProvider: input => invoke('saveProvider', input),
  saveAndConnectProvider: input => invoke('saveAndConnectProvider', input),
  deleteProvider: id => invoke('deleteProvider', id),
  selectProvider: id => invoke('selectProvider', id),
  setProviderEnabled: (id, enabled) => invoke('setProviderEnabled', id, enabled),
  setOriginalEnabled: enabled => invoke('setOriginalEnabled', enabled),
  refreshOriginal: () => invoke('refreshOriginal'),
  enableMaxEffort: () => invoke('enableMaxEffort'),
  testProvider: id => invoke('testProvider', id),
  discoverModels: input => invoke('discoverModels', input),
  discoverModelDetails: input => invoke('discoverModelDetails', input),
  setGateway: running => invoke('setGateway', running),
  connectCodex: () => invoke('connectCodex'),
  restoreCodex: () => invoke('restoreCodex'),
  saveSettings: settings => invoke('saveSettings', settings),
  clearLogs: clearUsage => invoke('clearLogs', clearUsage),
  openDataFolder: () => invoke('openDataFolder'),
  openCodexFolder: () => invoke('openCodexFolder'),
  exportLogs: () => invoke('exportLogs'),
  openCodex: () => invoke('openCodex'),
  window: action => invoke('window', action),
  windowState: () => invoke('windowState'),
  updateState: () => invoke('updateState'),
  checkForUpdates: () => invoke('checkForUpdates'),
  downloadUpdate: () => invoke('downloadUpdate'),
  installUpdate: () => invoke('installUpdate'),
  openUpdatePage: () => invoke('openUpdatePage'),
  openRepository: () => invoke('openRepository'),
  openIssues: () => invoke('openIssues'),
  onUpdateState: listener => {
    const handle = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
    ipcRenderer.on('fleet:update-state', handle)
    return () => { ipcRenderer.removeListener('fleet:update-state', handle) }
  },
  onWindowState: listener => {
    const handle = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
    ipcRenderer.on('fleet:window-state', handle)
    return () => { ipcRenderer.removeListener('fleet:window-state', handle) }
  }
}
contextBridge.exposeInMainWorld('fleet', api)
