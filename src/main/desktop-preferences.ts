import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './store'

const ROOT = 'electron-persisted-atom-state'
const KEY = 'enabled-reasoning-efforts'
// Defaults from the supported Codex desktop build. Max is opt-in in its UI.
const DEFAULT = ['low', 'medium', 'high', 'xhigh', 'ultra', 'persistent']
export interface EffortBackup { present: boolean; value?: string[]; written: string[]; added?: string[]; ultra?: { present: boolean; value?: boolean } }
const ULTRA = 'show-ultra-in-model-picker-slider'
export class DesktopPreferences {
  readonly path: string
  constructor(private home: string) { this.path = join(home, '.codex-global-state.json') }
  private read() { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {} }
  enabled() { try { return (this.read()[ROOT]?.[KEY] ?? DEFAULT).includes('max') } catch { return false } }
  capture(required: string[] = ['max']): EffortBackup {
    const atoms = this.read()[ROOT] ?? {}
    const value = atoms[KEY] ?? DEFAULT
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Codex 推理档位设置格式异常。')
    return { present: Object.hasOwn(atoms, KEY), ...(Object.hasOwn(atoms, KEY) ? { value } : {}), written: [...new Set([...value, ...required])], added: required.filter(effort => !value.includes(effort)), ...(required.includes('ultra') ? { ultra: { present: Object.hasOwn(atoms, ULTRA), ...(Object.hasOwn(atoms, ULTRA) ? { value: atoms[ULTRA] } : {}) } } : {}) }
  }
  prepare(previous?: EffortBackup, required: string[] = ['max']): EffortBackup {
    const captured = this.capture(required)
    if (!previous) return captured
    const added = previous.added ?? (previous.value?.includes('max') ? [] : ['max'])
    return { ...previous, written: captured.written, added: [...new Set([...added, ...captured.added ?? []])], ultra: previous.ultra ?? captured.ultra }
  }
  enable(previous?: EffortBackup, required: string[] = ['max']): EffortBackup {
    const state = this.read(); const atoms = state[ROOT] ??= {}
    const current = atoms[KEY] ?? DEFAULT
    if (!Array.isArray(current) || current.some(value => typeof value !== 'string')) throw new Error('Codex 推理档位设置格式异常。')
    const written = [...new Set([...current, ...required])]
    const backup = this.prepare(previous, required)
    if (required.some(effort => !current.includes(effort)) || (required.includes('ultra') && atoms[ULTRA] !== true)) {
      atoms[KEY] = written
      if (required.includes('ultra')) atoms[ULTRA] = true
      mkdirSync(this.home, { recursive: true }); atomicWrite(this.path, JSON.stringify(state))
    }
    return backup
  }
  restore(backup?: EffortBackup) {
    if (!backup || !existsSync(this.path)) return
    const state = this.read(); const atoms = state[ROOT]
    if (!Array.isArray(atoms?.[KEY])) return
    if (JSON.stringify(atoms[KEY]) === JSON.stringify(backup.written)) {
      if (backup.present) atoms[KEY] = backup.value
      else delete atoms[KEY]
    } else {
      const added = backup.added ?? (backup.value?.includes('max') ? [] : ['max'])
      atoms[KEY] = atoms[KEY].filter((effort: string) => !added.includes(effort))
    }
    if (backup.ultra && atoms[ULTRA] === true) {
      if (backup.ultra.present) atoms[ULTRA] = backup.ultra.value
      else delete atoms[ULTRA]
    }
    atomicWrite(this.path, JSON.stringify(state))
  }
}
