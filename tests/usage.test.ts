import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { Store, type Cipher } from '../src/main/store'
import type { RequestLog } from '../src/shared/types'
import { emptyUsage, exactTokens, formatTokens, localDay, migrateUsage, recordUsage, totalUsage, usageCalendar } from '../src/shared/usage'
import { ISSUES_URL, REPOSITORY_URL } from '../src/shared/project'

const artifacts = resolve('artifacts')
mkdirSync(artifacts, { recursive: true })
const cipher: Cipher = { label: 'fixture', encrypt: value => value, decrypt: value => value }
const createStore = () => new Store(mkdtempSync(join(artifacts, 'usage-unit-')), cipher)
const at = (date: string) => `${date}T12:00:00`
const log = (id: string, overrides: Partial<RequestLog> = {}): RequestLog => ({
  id, at: at('2026-10-26'), provider: '测试服务商', model: 'fixture', status: 'ok',
  latency: 100, inputTokens: 7, outputTokens: 3, usageKnown: true, ...overrides
})

describe('Token formatting', () => {
  it.each([
    [0, '0'], [999, '999'], [1_000_000, '1,000,000'], [999_999_999, '999,999,999'],
    [1_000_000_000, '1B'], [1_234_567_890, '1.23B'], [10_000_000_000, '10B'], [12_500_000_000, '12.5B']
  ])('formats %s as %s', (value, expected) => expect(formatTokens(value)).toBe(expected))
  it('retains the precise count for tooltips', () => expect(exactTokens(1_234_567_890)).toBe('1,234,567,890'))
})

describe('daily usage persistence', () => {
  it('migrates the retained old records exactly once and does not re-add them on restart', () => {
    const store = createStore()
    const file = join(store.directory, 'state.json')
    const state = JSON.parse(readFileSync(file, 'utf8'))
    delete state.usage
    state.logs = [log('a'), log('b', { at: at('2026-10-25'), usageKnown: undefined }), log('unknown', { inputTokens: 0, outputTokens: 0, usageKnown: undefined })]
    writeFileSync(file, JSON.stringify(state))
    const migrated = new Store(store.directory, cipher)
    expect(migrated.usage.since).toBe('2026-10-25')
    expect(migrated.usage.daily.map(day => day.date)).toEqual(['2026-10-25', '2026-10-26'])
    expect(totalUsage(migrated.usage.daily)).toMatchObject({ requests: 3, inputTokens: 14, outputTokens: 6, unknownUsageRequests: 1 })
    expect(new Store(store.directory, cipher).usage).toEqual(migrated.usage)
  })

  it('keeps totals and older days after 300 request details are evicted and the app restarts', () => {
    const store = createStore()
    store.addLog(log('old', { at: at('2025-12-31'), inputTokens: 1_000_000_000 }))
    for (let index = 0; index < 301; index++) store.addLog(log(`request-${index}`))
    expect(store.logs).toHaveLength(300)
    expect(store.logs.some(entry => entry.id === 'old')).toBe(false)
    expect(totalUsage(store.usage.daily)).toMatchObject({ requests: 302, inputTokens: 1_000_002_107, outputTokens: 906 })
    expect(store.usage.daily[0].date).toBe('2025-12-31')
    expect(new Store(store.directory, cipher).usage).toEqual(store.usage)
  })

  it('includes real usage from interrupted/cancelled/failed requests and distinguishes unknown from zero', () => {
    const history = migrateUsage([])
    for (const status of ['ok', 'error', 'interrupted', 'cancelled', 'timeout', 'incomplete'] as const) recordUsage(history, log(status, { status }))
    recordUsage(history, log('unknown', { usageKnown: false, inputTokens: 100 }))
    recordUsage(history, log('zero', { inputTokens: 0, outputTokens: 0 }))
    for (const value of [-1, Infinity, NaN, 1.5]) recordUsage(history, log(`invalid-${value}`, { inputTokens: value }))
    expect(totalUsage(history.daily)).toMatchObject({ requests: 12, inputTokens: 42, outputTokens: 18, unknownUsageRequests: 5 })
  })

  it('ignores invalid dates and duplicate retained request IDs', () => {
    const store = createStore()
    store.addLog(log('one')); store.addLog(log('one'))
    store.addLog(log('invalid-date', { at: 'not-a-date' }))
    expect(totalUsage(store.usage.daily).requests).toBe(1)
    expect(migrateUsage([log('same'), log('same')]).daily[0].requests).toBe(1)
  })

  it('preserves usage when only details are cleared, and resets it when explicitly requested', () => {
    const store = createStore()
    store.addLog(log('one')); const usage = store.usage
    store.clearLogs()
    expect(store.logs).toEqual([])
    expect(store.usage).toEqual(usage)
    const restarted = new Store(store.directory, cipher)
    expect(restarted.usage).toEqual(usage)
    restarted.addLog(log('two'))
    expect(restarted.usage.daily[0].requests).toBe(2)
    restarted.clearLogs(true)
    expect(new Store(store.directory, cipher).usage).toEqual({ since: localDay(new Date()), daily: [] })
  })

  it('returns an isolated snapshot so callers cannot mutate stored totals', () => {
    const store = createStore(); store.addLog(log('one'))
    const usage = store.usage; usage.daily[0].inputTokens = 999
    expect(store.usage.daily[0].inputTokens).toBe(7)
  })
})

describe('local calendar', () => {
  it('groups requests using their local calendar date rather than UTC slicing', () => {
    const timestamp = '2026-10-25T23:30:00-05:00'
    const history = migrateUsage([log('tz', { at: timestamp })])
    expect(history.daily[0].date).toBe(localDay(new Date(timestamp)))
  })
  it('shows exactly 365 dates in the rolling year and aligns weeks to Sunday', () => {
    const calendar = usageCalendar({ since: '2026-10-01', daily: [] }, 'recent', new Date(at('2026-10-26')))
    expect(calendar.days.filter(day => day.inRange)).toHaveLength(365)
    expect(calendar.days.length % 7).toBe(0)
    expect(new Date(at(calendar.days[0].date)).getDay()).toBe(0)
    expect(calendar.days.find(day => day.date === '2026-09-30')?.recorded).toBe(false)
    expect(calendar.days.find(day => day.date === '2026-10-01')?.recorded).toBe(true)
    expect(calendar.days.filter(day => day.inRange).at(-1)?.date).toBe('2026-10-26')
  })
  it('includes leap day, uses unique dates through DST, and excludes future days', () => {
    const calendar = usageCalendar({ since: '2020-01-01', daily: [] }, '2024', new Date(at('2026-10-26')))
    const dates = calendar.days.filter(day => day.inRange).map(day => day.date)
    expect(dates).toHaveLength(366)
    expect(new Set(dates).size).toBe(366)
    expect(dates).toContain('2024-02-29')
    const current = usageCalendar({ since: '2026-01-01', daily: [] }, '2026', new Date(at('2026-10-26')))
    expect(current.days.find(day => day.date === '2026-10-27')?.inRange).toBe(false)
  })
  it('uses only the selected year for totals and relative color levels', () => {
    const history = { since: '2025-01-01', daily: [
      { ...emptyUsage('2025-10-26'), inputTokens: 1_000_000_000 },
      { ...emptyUsage('2026-10-25'), inputTokens: 25 },
      { ...emptyUsage('2026-10-26'), inputTokens: 100 }
    ] }
    const calendar = usageCalendar(history, '2026', new Date(at('2026-10-26')))
    expect(totalUsage(calendar.visible).inputTokens).toBe(125)
    expect(calendar.days.find(day => day.date === '2026-10-25')?.level).toBe(1)
    expect(calendar.days.find(day => day.date === '2026-10-26')?.level).toBe(4)
  })
})

it('uses the public repository for issue reporting', () => {
  expect(ISSUES_URL).toBe(`${REPOSITORY_URL}/issues`)
  expect(ISSUES_URL).toBe('https://github.com/kaka-looking/fleet-bridge-/issues')
})
