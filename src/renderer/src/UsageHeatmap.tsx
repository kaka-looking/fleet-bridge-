import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { CalendarDays, ChevronDown, Info } from 'lucide-react'
import type { UsageCalendarDay } from '../../shared/usage'
import type { UsageHistory } from '../../shared/types'
import { exactTokens, formatTokens, localDay, totalUsage, usageCalendar } from '../../shared/usage'

function describeDay(day: UsageCalendarDay) {
  if (!day.recorded) return `${day.date}：尚未开始记录，历史用量未知`
  const { usage } = day
  if (usage.requests > 0 && usage.unknownUsageRequests === usage.requests) return `${day.date}：用量未知，${usage.requests} 次请求`
  return `${day.date}：已记录 ${exactTokens(usage.inputTokens + usage.outputTokens)} Tokens，输入 ${exactTokens(usage.inputTokens)}，输出 ${exactTokens(usage.outputTokens)}，${usage.requests} 次请求`
}

export function UsageHeatmap({ history }: { history: UsageHistory }) {
  const [period, setPeriod] = useState('recent')
  const [selected, setSelected] = useState<string>()
  const grid = useRef<HTMLDivElement>(null)
  const now = new Date()
  const years = [...new Set([now.getFullYear(), ...history.daily.map(day => Number(day.date.slice(0, 4)))])]
    .filter(year => year <= now.getFullYear()).sort((a, b) => b - a)
  const selectedPeriod = period === 'recent' || years.includes(Number(period)) ? period : 'recent'
  const calendar = usageCalendar(history, selectedPeriod, now)
  const totals = totalUsage(calendar.visible)
  const tokens = totals.inputTokens + totals.outputTokens
  const activeDays = calendar.visible.filter(day => day.inputTokens + day.outputTokens > 0).length
  const selectedDay = calendar.days.find(day => day.inRange && day.date === selected)
    ?? calendar.days.find(day => day.inRange && day.date === localDay(now))
    ?? calendar.days.findLast(day => day.inRange)!
  const columns = calendar.days.length / 7
  const months = new Map<number, string>()
  calendar.days.forEach((day, index) => {
    if (day.inRange && (!calendar.days[index - 1]?.inRange || day.date.endsWith('-01'))) {
      months.set(Math.floor(index / 7), `${Number(day.date.slice(5, 7))}月`)
    }
  })
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const offset = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key]
    if (offset === undefined) return
    event.preventDefault()
    const next = grid.current?.children[index + offset]
    if (next instanceof HTMLButtonElement) next.focus()
  }

  return <section className="panel usage-panel" aria-label="每日 Token 使用记录">
    <div className="usage-heading">
      <div><h2><CalendarDays size={18}/>使用记录</h2><p>{selectedPeriod === 'recent' ? '最近一年' : `${selectedPeriod} 年`}已记录 <strong title={`${exactTokens(tokens)} Tokens`}>{formatTokens(tokens)}</strong> Tokens · 使用 <strong>{activeDays}</strong> 天</p></div>
      <label className="select-wrap"><select aria-label="使用记录年份" value={selectedPeriod} onChange={event => { setPeriod(event.target.value); setSelected(undefined) }}>
        <option value="recent">最近一年</option>{years.map(year => <option key={year} value={year}>{year} 年</option>)}
      </select><ChevronDown size={14}/></label>
    </div>
    <div className="usage-scroll" tabIndex={0} aria-label="每日用量日历，可横向滚动">
      <div className="usage-calendar" style={{ '--usage-columns': columns } as CSSProperties}>
        <div className="usage-months" aria-hidden="true">{[...months].map(([column, label]) => <span key={column} style={{ gridColumn: column + 1 }}>{label}</span>)}</div>
        <div className="usage-weekdays" aria-hidden="true"><span style={{ gridRow: 2 }}>周一</span><span style={{ gridRow: 4 }}>周三</span><span style={{ gridRow: 6 }}>周五</span></div>
        <div className="usage-cells" ref={grid}>
          {calendar.days.map((day, index) => day.inRange
            ? <button key={day.date} type="button" data-date={day.date} data-level={day.level}
              className={`usage-cell${day.recorded ? '' : ' unrecorded'}${day.usage.unknownUsageRequests && !day.level ? ' usage-unknown' : ''}`}
              aria-label={describeDay(day)} title={describeDay(day)} aria-pressed={selectedDay.date === day.date}
              tabIndex={selectedDay.date === day.date ? 0 : -1}
              onFocus={() => setSelected(day.date)} onClick={() => setSelected(day.date)} onKeyDown={event => navigate(event, index)}/>
            : <span className="usage-cell usage-padding" key={day.date} aria-hidden="true"/>)}
        </div>
      </div>
    </div>
    <div className="usage-footer">
      <span>{calendar.start} 至 {localDay(now) < calendar.end ? localDay(now) : calendar.end}</span>
      <div className="usage-legend" aria-label="颜色越深，每日 Token 用量越多"><span>少</span>{[0, 1, 2, 3, 4].map(level => <i className="usage-cell" data-level={level} key={level}/>)}<span>多</span></div>
    </div>
    <div className="usage-day-detail" role="status">{describeDay(selectedDay)}</div>
    <details className="usage-explanation"><summary><Info size={13}/>统计说明 · 开始记录于 {history.since}</summary>
      <p>按请求完成时的本地日期累计输入和输出 Tokens，包含异常或取消请求中已收到的有效用量。未返回用量的请求不会估算为实际消耗；斜纹方格表示当日有请求但用量未知，浅色虚线方格表示尚未开始记录。</p>
      <p>每日统计独立保存在本地，不受最近 300 条连接明细限制。升级时仅迁移仍保留的旧记录，已经淘汰的历史无法补回。清空连接明细默认保留统计，也可选择同时清空用量。</p>
    </details>
  </section>
}
