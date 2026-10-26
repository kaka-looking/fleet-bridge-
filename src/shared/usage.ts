import type { DailyUsage, RequestLog, UsageHistory } from './types'
import { knownUsage } from './request-log'

export const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
export const exactTokens = (value: number) => value.toLocaleString('en-US')
export const formatTokens = (value: number) => value >= 1_000_000_000
  ? `${(value / 1_000_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}B`
  : exactTokens(value)

export function emptyUsage(date: string): DailyUsage {
  return { date, requests: 0, inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0 }
}

export function recordUsage(history: UsageHistory, log: RequestLog) {
  const at = new Date(log.at)
  if (!Number.isFinite(at.getTime())) return
  const date = localDay(at)
  const day = history.daily.find(day => day.date === date) ?? emptyUsage(date)
  if (!history.daily.includes(day)) {
    history.daily.push(day)
    history.daily.sort((a, b) => a.date.localeCompare(b.date))
  }
  history.since = date < history.since ? date : history.since
  day.requests++
  // Missing or malformed usage is not a measured zero, regardless of request status.
  if (knownUsage(log) && [log.inputTokens, log.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
    day.inputTokens += log.inputTokens
    day.outputTokens += log.outputTokens
  } else day.unknownUsageRequests++
}

export function migrateUsage(logs: RequestLog[], now = new Date()): UsageHistory {
  const history: UsageHistory = { since: localDay(now), daily: [] }
  const seen = new Set<string>()
  for (const log of logs) {
    if (seen.has(log.id)) continue
    seen.add(log.id)
    recordUsage(history, log)
  }
  return history
}

export function totalUsage(days: DailyUsage[]) {
  return days.reduce((sum, day) => ({
    ...sum,
    requests: sum.requests + day.requests,
    inputTokens: sum.inputTokens + day.inputTokens,
    outputTokens: sum.outputTokens + day.outputTokens,
    unknownUsageRequests: sum.unknownUsageRequests + day.unknownUsageRequests
  }), emptyUsage(''))
}

export interface UsageCalendarDay {
  date: string
  inRange: boolean
  recorded: boolean
  usage: DailyUsage
  level: number
}

// Advance by calendar days, not 24-hour durations, so DST cannot skip or duplicate cells.
export function usageCalendar(history: UsageHistory, period: string, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const start = period === 'recent' ? new Date(today) : new Date(Number(period), 0, 1)
  if (period === 'recent') start.setDate(start.getDate() - 364)
  const end = period === 'recent' ? today : new Date(Number(period), 11, 31)
  const first = new Date(start); first.setDate(first.getDate() - first.getDay())
  const last = new Date(end); last.setDate(last.getDate() + 6 - last.getDay())
  const byDate = new Map(history.daily.map(day => [day.date, day]))
  const startKey = localDay(start); const endKey = localDay(end); const todayKey = localDay(today)
  const visible = history.daily.filter(day => day.date >= startKey && day.date <= endKey && day.date <= todayKey)
  const maximum = Math.max(1, ...visible.map(day => day.inputTokens + day.outputTokens))
  const days: UsageCalendarDay[] = []
  for (const day = new Date(first); day <= last; day.setDate(day.getDate() + 1)) {
    const date = localDay(day)
    const usage = byDate.get(date) ?? emptyUsage(date)
    const tokens = usage.inputTokens + usage.outputTokens
    const inRange = date >= startKey && date <= endKey && date <= todayKey
    days.push({ date, inRange, recorded: inRange && date >= history.since, usage, level: tokens ? Math.max(1, Math.ceil(tokens / maximum * 4)) : 0 })
  }
  return { days, visible, start: startKey, end: endKey }
}
