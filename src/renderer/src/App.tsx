import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  Activity, AlertCircle, ArrowDownUp, ArrowRight, Box, CalendarDays, Check, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Copy, Database, Download,
  ExternalLink, Eye, EyeOff, FileKey2, FolderOpen, Github, Grid2X2, House, Info, List, LoaderCircle,
  LockKeyhole, Minus, MoreHorizontal, MoreVertical, Network, Pencil, Plus, RefreshCw,
  RotateCcw, Search, Settings as SettingsIcon, ShieldCheck, SlidersHorizontal, Square,
  Star, Sun, Trash2, Unplug, X, Zap
} from 'lucide-react'
import type { ModelCapabilities, Provider, ProviderInput, ProviderKind, RequestLog, Settings, Snapshot, UpdateState, UsageHistory } from '../../shared/types'
import { PRESETS } from '../../shared/presets'
import { ISSUES_URL, REPOSITORY_URL } from '../../shared/project'
import { exactTokens, formatTokens, localDay, totalUsage } from '../../shared/usage'
import { UsageHeatmap } from './UsageHeatmap'
import { ModelLabel } from './ModelLabel'
import { paginationItems } from './pagination'
import { highestEffort, mergeCapabilities, modelCapabilities, reasoningProfile, REASONING_EFFORTS } from '../../shared/model-capabilities'
import { failureStageLabels, knownUsage, requestStatusHint, requestStatusLabel, upstreamOutcomeLabel } from '../../shared/request-log'
import fleetLogo from './assets/fleet-logo.png'
import deepseekLogo from './assets/deepseek.png'
import glmLogo from './assets/glm.png'
import kimiLogo from './assets/kimi.png'
import qwenLogo from './assets/qwen.png'
import minimaxLogo from './assets/minimax.png'
import deepseekCard from './assets/deepseek-card.png'
import glmCard from './assets/glm-card.png'
import kimiCard from './assets/kimi-card.png'

const api = window.fleet
const kinds: ProviderKind[] = ['deepseek', 'glm', 'kimi', 'qwen', 'minimax', 'custom']
const names: Record<ProviderKind, string> = { deepseek: 'DeepSeek', glm: '智谱 GLM', kimi: 'Kimi', qwen: '通义千问', minimax: 'MiniMax', custom: '自定义' }
const descriptions: Record<ProviderKind, string> = { deepseek: '高性能开源模型，适合代码与通用任务。', glm: '智谱大模型，具备优秀的中文理解能力。', kimi: '月之暗面出品，擅长长文本与创作。', qwen: '阿里通义大模型，支持多种应用场景。', minimax: '强大的多模态能力，拓展更多可能。', custom: '支持兼容 OpenAI 接口的任何模型服务。' }
const shortDescriptions = ['高性能开源模型', '国产领先大模型', '长文本与多模态', '阿里通义大模型', '强大的多模态能力', 'OpenAI 兼容格式']
const logos = { deepseek: deepseekLogo, glm: glmLogo, kimi: kimiLogo, qwen: qwenLogo, minimax: minimaxLogo }
const cardLogos = { ...logos, deepseek: deepseekCard, glm: glmCard, kimi: kimiCard }
const number = (n: number) => n.toLocaleString('en-US')
const duration = (ms: number) => `${(ms / 1000).toFixed(2)}s`
const cleanError = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
type Notice = { text: string; error?: boolean }
type View = 'dashboard' | 'logs' | 'providers' | 'settings'
type Act = (id: string, action: () => Promise<Snapshot>, success?: string) => Promise<void>

function Brand() { return <img className="brand-icon" src={fleetLogo} alt="舰桥 Fleet Bridge"/> }
function RepositoryLink({ notify }: { notify: (text: string, error?: boolean) => void }) {
  return <a className="repository-link" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub 开源仓库" title="在浏览器中打开 GitHub 开源仓库" onClick={event => { event.preventDefault(); void api.openRepository().catch(error => notify(cleanError(error), true)) }}><Github size={16}/></a>
}
function ProviderMark({ kind, small = false, card = false }: { kind: ProviderKind; small?: boolean; card?: boolean }) {
  return kind === 'custom' ? <span className={`provider-mark custom ${small ? 'small' : ''}`}><Plus/></span> : <img className={`provider-mark ${small ? 'small' : ''}`} src={(card ? cardLogos : logos)[kind]} alt=""/>
}
function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <input className="switch-input" type="checkbox" role="switch" aria-label={label} disabled={disabled} checked={checked} onChange={event => onChange(event.target.checked)}/>
}
function useDialog(onClose: () => void, busy = false) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current
    const first = dialog?.querySelector<HTMLElement>('input, button, select, textarea')
    first?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length)
      const firstItem = focusable[0]; const lastItem = focusable.at(-1)
      if (event.shiftKey && document.activeElement === firstItem) { event.preventDefault(); lastItem?.focus() }
      else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); firstItem?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [busy])
  return ref
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [view, setView] = useState<View>('dashboard')
  const [notice, setNotice] = useState<Notice>()
  const [busy, setBusy] = useState('')
  const [editor, setEditor] = useState<{ provider?: Provider; kind?: ProviderKind }>()
  const [deleting, setDeleting] = useState<Provider>()
  const [clearing, setClearing] = useState(false)
  const [clearUsage, setClearUsage] = useState(false)
  const [help, setHelp] = useState(false)
  const [fatal, setFatal] = useState('')
  const [maximized, setMaximized] = useState(false)
  const [updates, setUpdates] = useState<UpdateState>()
  const mainContent = useRef<HTMLElement>(null)
  const refresh = () => api.snapshot().then(setSnapshot).catch(error => setFatal(cleanError(error)))
  const notify = (text: string, error = false) => setNotice({ text, error })
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 2000); return () => clearInterval(timer) }, [])
  useLayoutEffect(() => { mainContent.current?.scrollTo(0, 0) }, [view])
  useEffect(() => {
    const unsubscribe = api.onUpdateState(setUpdates)
    void api.updateState().then(setUpdates).catch(error => notify(cleanError(error), true))
    return unsubscribe
  }, [])
  useEffect(() => {
    const unsubscribe = api.onWindowState(state => setMaximized(state.maximized))
    void api.windowState().then(state => setMaximized(state.maximized)).catch(error => notify(cleanError(error), true))
    return unsubscribe
  }, [])
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(undefined), 6500); return () => clearTimeout(timer) } }, [notice])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { document.documentElement.dataset.theme = snapshot?.settings.theme === 'system' || !snapshot?.settings.theme ? media.matches ? 'dark' : 'light' : snapshot.settings.theme }
    apply(); media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [snapshot?.settings.theme])
  async function act(id: string, action: () => Promise<Snapshot>, success?: string) {
    if (busy) return
    setBusy(id)
    try { setSnapshot(await action()); if (success) notify(success) }
    catch (error) { notify(cleanError(error), true) }
    finally { setBusy('') }
  }
  async function test(provider: Provider) {
    if (busy) return
    setBusy(`test-${provider.id}`)
    try { const result = await api.testProvider(provider.id); notify(`${provider.name}：${result.message}`, !result.ok); await refresh() }
    catch (error) { notify(cleanError(error), true) }
    finally { setBusy('') }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); notify('已复制到剪贴板') }
    catch { notify('复制失败，请手动复制。', true) }
  }
  const active = snapshot?.providers.find(provider => provider.id === snapshot.activeProviderId)
  return <div className={`desktop view-${view}`}>
    <div className="app-shell">
      <aside className="sidebar">
        <div className="wordmark"><Brand/><div className="brand-name"><strong>舰桥</strong><span>FLEET BRIDGE</span></div></div>
        <p className="brand-tagline">模型自由，始于连接</p>
        <nav className="main-nav" aria-label="主导航">{([
          ['dashboard', House, '工作台'], ['logs', Clock3, '连接记录'], ['providers', Box, '服务商'], ['settings', SettingsIcon, '设置']
        ] as const).map(([id, Icon, title]) => <button className={view === id ? 'selected' : ''} key={id} onClick={() => setView(id)}><Icon size={21} fill={view === id && (id === 'dashboard' || id === 'settings') ? 'currentColor' : 'none'}/>{title}</button>)}</nav>
        <div className="sidebar-landscape"/>
        <div className="sidebar-bottom"><button className="help-link" onClick={() => setHelp(true)}><CircleHelp size={19}/>帮助文档<ExternalLink size={14}/></button><p>舰桥 Fleet Bridge<br/><span className="app-version"><span>v{snapshot?.version ?? '…'}</span><RepositoryLink notify={notify}/></span></p></div>
      </aside>
      <div className="titlebar-drag-region" aria-hidden="true"/>
      <div className="window-controls"><button aria-label="最小化" title="最小化" onClick={() => void api.window('minimize').catch(error => notify(cleanError(error), true))}><Minus size={15}/></button><button aria-label={maximized ? '还原窗口' : '最大化'} title={maximized ? '还原窗口' : '最大化'} onClick={() => void api.window('maximize').catch(error => notify(cleanError(error), true))}>{maximized ? <Copy size={12}/> : <Square size={12}/>}</button><button aria-label="收起到托盘" title="收起到托盘" onClick={() => void api.window('close').catch(error => notify(cleanError(error), true))}><X size={16}/></button></div>
      <main ref={mainContent} className="main-content">
        <header className="page-header"><div><h1>{({ dashboard: '工作台', logs: '连接记录', providers: '服务商', settings: '设置' })[view]}</h1><p>{({ dashboard: '把你熟悉的模型，连接到 Codex，让 AI 工作流更自由。', logs: '查看本地请求记录，了解模型使用情况与耗时。仅记录本地数据，不会上传任何内容。', providers: '管理你的模型服务商，选择默认模型供 Codex 使用。', settings: '自定义舰桥的运行方式，让它更好地适配你的工作习惯。' })[view]}</p></div>
          <div className="header-actions"><button className={`gateway-pill ${snapshot?.gateway.running ? 'online' : ''}`} disabled={!snapshot || Boolean(busy)} onClick={() => snapshot && void act('gateway', () => api.setGateway(!snapshot.gateway.running))} title={snapshot?.gateway.url + ' · 点击启动或停止代理'}><i/>{snapshot?.gateway.running ? '本地代理在线' : '本地代理离线'}</button>
          {view === 'logs' ? <><button className="button" disabled={!snapshot?.logs.length} onClick={() => void api.exportLogs().then(saved => { if (saved) notify('连接记录已导出') }).catch(error => notify(cleanError(error), true))}><Download size={17}/>导出记录</button><button className="button danger" disabled={(!snapshot?.logs.length && !snapshot?.usage.daily.length) || Boolean(busy)} onClick={() => { setClearUsage(false); setClearing(true) }}><Trash2 size={17}/>清空记录</button></> : <button className="button primary" onClick={() => setEditor({ kind: 'deepseek' })}><Plus size={20}/>添加服务商</button>}</div>
        </header>
        {updates && ['available', 'downloaded'].includes(updates.phase) && view !== 'settings' && <div className="update-banner" role="status"><Download size={18}/><span>{updates.phase === 'downloaded' ? snapshot?.settings.autoInstallUpdates !== false ? `新版 v${updates.version} 已下载，退出后自动安装，下次启动生效。` : `新版 v${updates.version} 已下载，可以重启安装。` : `发现新版 v${updates.version}。`}</span><button className="text-button" onClick={() => setView('settings')}>查看更新<ArrowRight size={14}/></button></div>}
        {!snapshot ? <div className="loading-state">{fatal ? <><AlertCircle size={32}/><p>{fatal}</p><button className="button" onClick={() => void refresh()}>重新加载</button></> : <><LoaderCircle className="spin" size={28}/><p>正在准备你的工作台…</p></>}</div> : <>
          {(view === 'dashboard' || view === 'providers') && <>
            {view === 'dashboard' && <><section className="hero dashboard-hero"><div className="hero-copy"><div className="eyebrow">FLEET BRIDGE</div><h2>让 <em>Codex</em> 接入<br/>你自己的模型舰队</h2><p>连接 DeepSeek、GLM、Kimi 以及更多模型服务，<br/>在本地构建属于你的 AI 能力桥梁。</p><div className="hero-providers">{(['deepseek', 'glm', 'kimi', 'custom'] as ProviderKind[]).map(kind => <button key={kind} onClick={() => setEditor({ kind })}><ProviderMark kind={kind} small/>{names[kind]}</button>)}</div></div></section><DashboardStats snapshot={snapshot} active={active} onProviders={() => setView('providers')} onLogs={() => setView('logs')} onEdit={() => active ? setEditor({ provider: active }) : setEditor({ kind: 'deepseek' })}/></>}
            {snapshot.gateway.error && <div className="error-banner"><AlertCircle size={17}/>{snapshot.gateway.error}<button onClick={() => setView('settings')}>前往设置</button></div>}
            <div className={`workspace-grid ${view === 'providers' ? 'providers-page' : ''}`}><ProviderFleet snapshot={snapshot} busy={Boolean(busy)} act={act} onAdd={kind => setEditor({ kind })} onEdit={provider => setEditor({ provider })} onDelete={setDeleting} onTest={provider => void test(provider)} onSelect={provider => void act(`select-${provider.id}`, () => api.selectProvider(provider.id), `默认航线已切换至 ${provider.name}`)}/>
              <QuickStart snapshot={snapshot} active={active} busy={busy} act={act} onAdd={() => setEditor({ kind: 'deepseek' })} onEdit={() => active && setEditor({ provider: active })} onSecurity={() => setView('settings')} notify={notify}/>
            </div>
          </>}
          {view === 'logs' && <LogsView logs={snapshot.logs} providers={snapshot.providers} usage={snapshot.usage}/>}
          {view === 'settings' && <SettingsView snapshot={snapshot} updates={updates} busy={Boolean(busy)} onSave={settings => void act('settings', () => api.saveSettings(settings), '设置已保存')} onSelect={id => void act('select', () => api.selectProvider(id), '默认服务商已更新')} copy={copy} notify={notify}/>}
        </>}
      </main>
    </div>
    {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role="status">{notice.error ? <AlertCircle size={18}/> : <CheckCircle2 size={18}/>}<span>{notice.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(undefined)}><X size={15}/></button></div>}
    {editor && <ProviderEditor provider={editor.provider} kind={editor.kind} onClose={() => setEditor(undefined)} onSaved={(next, result, codexError) => {
      setSnapshot(next); setEditor(undefined)
      if (codexError) notify(`服务商已保存，但未接入 Codex：${codexError}`, true)
      else notify(result?.ok === false ? `模型已接入 Codex，但接口测试失败：${result.message}` : '模型已接入 Codex。请完全退出并重开 Codex，在新对话中选择模型。', result?.ok === false)
    }}/>}
    {deleting && <SimpleDialog title={`删除 ${deleting.name}？`} onClose={() => setDeleting(undefined)}><p>该服务商的配置和已保存密钥会被移除。历史连接记录会保留。</p><div className="dialog-actions"><button className="button" onClick={() => setDeleting(undefined)}>取消</button><button className="button danger" disabled={Boolean(busy)} onClick={() => void act('delete', () => api.deleteProvider(deleting.id), '服务商已删除').then(() => setDeleting(undefined))}>删除服务商</button></div></SimpleDialog>}
    {clearing && <SimpleDialog title="清空连接记录？" onClose={() => { if (!busy) setClearing(false) }}><p>连接明细将被删除，默认保留每日用量和累计 Tokens。删除后无法恢复。</p><label className="clear-usage-option"><input type="checkbox" checked={clearUsage} disabled={Boolean(busy)} onChange={event => setClearUsage(event.target.checked)}/>同时清空每日用量统计与累计 Tokens</label><div className="dialog-actions"><button className="button" disabled={Boolean(busy)} onClick={() => setClearing(false)}>取消</button><button className="button danger" disabled={Boolean(busy)} onClick={() => void act('clear', async () => { const next = await api.clearLogs(clearUsage); setClearing(false); return next }, clearUsage ? '连接记录与用量统计已清空' : '连接明细已清空，用量统计已保留')}>确认清空</button></div></SimpleDialog>}
    {help && <SimpleDialog title="连接你的模型舰队" onClose={() => setHelp(false)}><ol className="help-steps"><li><strong>添加服务商</strong><p>填写服务商的 API 地址、API Key 和模型 ID。可以从接口读取模型列表，并测试工具调用。</p></li><li><strong>选择默认模型</strong><p>在服务商编辑窗口选择默认模型，在工作台切换默认服务商。</p></li><li><strong>接入 Codex</strong><p>点击“一键接入 Codex”，自动备份并写入配置。完全退出并重开 Codex，选择舰桥模型即可使用。</p></li></ol><div className="security-note"><ShieldCheck size={24}/><p>API Key 使用系统加密保存。可以随时恢复 Codex 原配置。连接记录只包含请求元数据。</p></div><button className="button primary" onClick={() => setHelp(false)}>开始使用 <ArrowRight size={16}/></button></SimpleDialog>}
  </div>
}

function DashboardStats({ snapshot, active, onProviders, onLogs, onEdit }: { snapshot: Snapshot; active?: Provider; onProviders: () => void; onLogs: () => void; onEdit: () => void }) {
  const today = snapshot.logs.filter(log => localDay(new Date(log.at)) === localDay(new Date()))
  const totals = totalUsage(snapshot.usage.daily)
  const tokenCount = totals.inputTokens + totals.outputTokens
  const todayRequests = snapshot.usage.daily.find(day => day.date === localDay(new Date()))?.requests ?? 0
  const modelName = active?.defaultModel === 'deepseek-chat' ? 'DeepSeek Chat' : active?.defaultModel
  return <section className="summary-cards" aria-label="连接概览"><button className="summary-card" onClick={onProviders}><span className="stat-icon"><Box/></span><div><small>已配置服务商</small><strong>{snapshot.providers.length}<span> / {Math.max(10, snapshot.providers.length)}</span></strong><div className="progress-track"><i style={{ width: `${Math.min(snapshot.providers.length * 10, 100)}%` }}/></div></div><ChevronRight className="card-chevron" size={16}/></button><button className="summary-card" onClick={onEdit}><span className="stat-icon gold"><Star fill="currentColor"/></span><div><small>默认模型</small><strong className="model-name" title={active?.defaultModel}>{modelName ?? '等待选择'}</strong></div><ChevronRight className="card-chevron" size={16}/></button><button className="summary-card" onClick={onLogs}><span className="stat-icon"><Activity/></span><div><small>今日请求</small><strong>{number(todayRequests)}</strong></div><MiniBars logs={today}/><ChevronRight className="card-chevron" size={16}/></button><button className="summary-card" onClick={onLogs}><span className="stat-icon"><Database/></span><div><small>累计 Tokens</small><strong title={`${exactTokens(tokenCount)} Tokens`}>{formatTokens(tokenCount)}</strong></div><MiniBars logs={snapshot.logs} tokens/><ChevronRight className="card-chevron" size={16}/></button></section>
}
function MiniBars({ logs, tokens = false }: { logs: RequestLog[]; tokens?: boolean }) {
  if (!logs.length || (tokens && !logs.some(log => log.inputTokens + log.outputTokens > 0))) return null
  const values = Array.from({ length: 8 }, (_, index) => logs.filter((_, i) => i % 8 === index).reduce((sum, log) => sum + (tokens ? log.inputTokens + log.outputTokens : 1), 0))
  const max = Math.max(1, ...values)
  return <span className="mini-bars" aria-hidden="true">{values.map((value, i) => <i key={i} style={{ height: `${value ? 20 + value / max * 80 : 5}%` }}/>)}</span>
}

function ProviderFleet({ snapshot, busy, act, onAdd, onEdit, onDelete, onTest, onSelect }: { snapshot: Snapshot; busy: boolean; act: Act; onAdd: (kind: ProviderKind) => void; onEdit: (provider: Provider) => void; onDelete: (provider: Provider) => void; onTest: (provider: Provider) => void; onSelect: (provider: Provider) => void }) {
  const [query, setQuery] = useState('')
  const [list, setList] = useState(false)
  const [menu, setMenu] = useState('')
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest('.provider-menu-wrap')) setMenu('') }
    document.addEventListener('click', close); return () => document.removeEventListener('click', close)
  }, [])
  const entries: { key: string; kind: ProviderKind; provider?: Provider }[] = snapshot.providers.map(provider => ({ key: provider.id, kind: provider.kind, provider }))
  for (const kind of ['deepseek', 'glm', 'kimi'] as ProviderKind[]) {
    if (!snapshot.providers.some(provider => provider.kind === kind)) entries.push({ key: kind, kind })
  }
  entries.push({ key: 'add-custom', kind: 'custom' })
  const filtered = entries.filter(entry => `${entry.provider?.name ?? names[entry.kind]} ${entry.provider?.models.join(' ') ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  return <section className="panel fleet-panel" ref={ref}><div className="fleet-heading"><div><h2>模型舰队</h2><p>管理你的模型服务商，选择默认模型供 Codex 使用。</p></div><div className="fleet-tools"><label className="search-input"><Search size={17}/><input aria-label="搜索服务商或模型" placeholder="搜索服务商..." value={query} onChange={event => setQuery(event.target.value)}/></label><div className="view-switch"><button className={!list ? 'selected' : ''} aria-label="网格视图" onClick={() => setList(false)}><Grid2X2 size={17}/></button><button className={list ? 'selected' : ''} aria-label="列表视图" onClick={() => setList(true)}><List size={17}/></button></div></div></div>
    {snapshot.originalCodex?.available && <div className="original-connection"><span className="original-icon"><Network size={23}/></span><div><strong>Codex 原配置 <small>{snapshot.originalCodex.models.length} 个模型</small></strong><p title={snapshot.originalCodex.models.join('、')}>{snapshot.originalCodex.error ?? '保留原有 GPT 等模型，与下方 API 同时使用。'}</p></div><button className="icon-button" aria-label="刷新原配置模型" disabled={busy} onClick={() => void act('refresh-original', () => api.refreshOriginal(), '原配置模型列表已刷新')}><RefreshCw size={16}/></button><Toggle label="启用 Codex 原配置" disabled={busy} checked={snapshot.originalCodex.enabled} onChange={enabled => void act('toggle-original', () => api.setOriginalEnabled(enabled), '原配置入口已更新；重开 Codex 刷新列表')}/></div>}
    <div className={`provider-list ${list ? 'list-view' : ''}`}>{filtered.map(({ key, kind, provider }) => <article key={key} className={`provider-card provider-row ${provider?.id === snapshot.activeProviderId ? 'active' : ''} ${provider ? '' : 'unconfigured'} ${provider?.enabled === false ? 'provider-disabled' : ''}`}>
      <ProviderMark kind={kind} card/><div className="provider-info"><div className="provider-title"><h3>{provider?.name ?? (kind === 'custom' ? '自定义 OpenAI Compatible' : names[kind])}</h3><span className={`health-badge ${provider?.lastTest?.ok ? 'healthy' : provider?.lastTest ? 'unhealthy' : ''}`} title={provider?.lastTest?.message}><i/>{provider?.lastTest ? provider.lastTest.ok ? '在线' : '异常' : provider ? '待测试' : '未配置'}</span></div><p className="provider-description" title={provider?.defaultModel}>{descriptions[kind]}</p><div className="provider-tags"><span><FileKey2 size={11}/>{kind === 'custom' ? '自定义 API' : 'API 接口'}</span><span><FileKey2 size={11}/>{provider?.models.length ?? 0} 个模型</span>{provider && <label className="provider-enabled-control"><Toggle label={`启用 ${provider.name}`} disabled={busy} checked={provider.enabled !== false} onChange={enabled => void act(`enable-${provider.id}`, () => api.setProviderEnabled(provider.id, enabled), enabled ? '接口已启用；重开 Codex 刷新模型列表' : '接口已停用，配置已保留')}/>{provider.enabled === false ? '已停用' : '已启用'}</label>}</div></div>
      {provider && <div className="provider-menu-wrap"><button className="icon-button" aria-label={`${provider.name} 更多操作`} aria-expanded={menu === key} onClick={() => setMenu(menu === key ? '' : key)}><MoreVertical size={19}/></button>{menu === key && <div className="provider-menu"><button onClick={() => { setMenu(''); onEdit(provider) }}><Pencil size={14}/>编辑服务商</button><button disabled={busy} onClick={() => { setMenu(''); onTest(provider) }}><Activity size={14}/>测试连接</button><button disabled={busy || provider.enabled === false || provider.id === snapshot.activeProviderId} onClick={() => { setMenu(''); onSelect(provider) }}><Star size={14}/>设为默认</button><button className="delete-menu" aria-label={`删除 ${provider.name}`} disabled={busy} onClick={() => { setMenu(''); onDelete(provider) }}><Trash2 size={14}/>删除服务商</button></div>}</div>}
      <button className="select-button" aria-label={provider ? provider.id === snapshot.activeProviderId ? `编辑 ${provider.name}` : `选择 ${provider.name}` : `配置 ${names[kind]}`} title={provider ? provider.id === snapshot.activeProviderId ? '编辑服务商与模型' : '设为默认服务商' : '添加服务商'} disabled={busy || provider?.enabled === false} onClick={() => provider ? provider.id === snapshot.activeProviderId ? onEdit(provider) : onSelect(provider) : onAdd(kind)}><ChevronRight size={19}/></button>
    </article>)}</div>{!filtered.length && <div className="empty-state"><Search size={25}/><p>没有找到匹配的服务商或模型</p><button className="text-button" onClick={() => setQuery('')}>清除搜索</button></div>}
  </section>
}

function QuickStart({ snapshot, active, busy, act, onAdd, onEdit, onSecurity, notify }: { snapshot: Snapshot; active?: Provider; busy: string; act: Act; onAdd: () => void; onEdit: () => void; onSecurity: () => void; notify: (text: string, error?: boolean) => void }) {
  const connected = snapshot.codex.connected
  const originalOnly = !active && snapshot.originalCodex?.enabled && snapshot.originalCodex.available
  const modelCount = snapshot.providers.filter(provider => provider.enabled !== false).reduce((total, provider) => total + provider.models.length, snapshot.originalCodex?.enabled ? snapshot.originalCodex.models.length : 0)
  const connect = () => void act('connect', async () => {
    const next = await api.connectCodex()
    if (connected) await api.openCodex()
    return next
  }, '模型已接入 Codex。请完全退出并重开 Codex，在新对话中选择模型。')
  return <aside className="panel quick-panel"><div className="quick-heading"><span><Zap size={27} fill="currentColor"/></span><div><h2>快速开始接入 Codex</h2><p>只需三步，即可让 Codex 使用你的模型。</p></div></div><div className="quick-steps">
    <button className={`quick-step ${!active ? 'current' : 'done'}`} onClick={onAdd}><span>1</span><div><strong>添加服务商</strong><p>选择厂商，填入 API Key 和基础信息。</p></div></button>
    <button className={`quick-step ${active && !connected ? 'current' : active ? 'done' : ''}`} disabled={!active} onClick={onEdit}><span>2</span><div><strong>选择默认模型</strong><p title={active?.defaultModel}>{active ? `${active.name} · ${active.defaultModel}` : originalOnly ? `Codex 原配置 · ${snapshot.originalCodex?.defaultModel}` : '在模型舰队中选择一个模型作为默认。'}</p></div></button>
    <div className={`quick-step ${connected ? 'done' : ''}`}><span>3</span><div><button className="connect-action" disabled={(!active && !originalOnly) || Boolean(busy) || Boolean(snapshot.codex.conflict)} onClick={connect}>{busy === 'connect' && <LoaderCircle size={13} className="spin"/>}{connected ? '打开 Codex' : '一键接入 Codex'}<ArrowRight size={13}/></button><p>{connected ? `${modelCount} 个模型已接入 Codex。` : modelCount ? `${modelCount} 个模型已保存，点击上方接入 Codex。` : '完成配置后，在 Codex 中开始使用。'}</p>{connected && <p title="完全退出并重开 Codex，在新对话的模型列表中选择。">完全退出并重开 Codex，在新对话中选择。</p>}</div></div>
  </div>{connected && <div className="max-effort-note"><strong>Codex 最大推理档位</strong><p>先完全退出 Codex，再点修复并重开。也可在 Codex 设置 → 模型功能 → 可用推理档位中勾选 Max。</p><button className="text-button" disabled={Boolean(busy)} onClick={() => void act('max-effort', () => api.enableMaxEffort(), 'Max 档位已启用，请重新打开 Codex')}>修复 Max 显示 <ArrowRight size={13}/></button></div>}{snapshot.codex.conflict && <p className="inline-error">{snapshot.codex.conflict}</p>}{(connected || snapshot.codex.hasBackup) && <button className="restore-link" disabled={Boolean(busy)} onClick={() => void act('restore', () => api.restoreCodex(), 'Codex 原配置已恢复。请完全退出并重开 Codex。')}><Unplug size={12}/>恢复原来的连接</button>}
  <button className="security-note" onClick={onSecurity}><span><ShieldCheck size={26}/></span><div><strong>数据仅保存在本地</strong><p>你的配置和连接记录都存储在本地，<br/>API Key 使用 Windows DPAPI 加密。</p></div><ChevronRight size={16}/></button></aside>
}

function SectionTitle({ number: n, title, subtitle }: { number: number; title: string; subtitle: string }) { return <div className="editor-section-title"><span>{n}</span><div><h3>{title}</h3><p>{subtitle}</p></div></div> }
function ProviderEditor({ provider, kind = 'deepseek', onClose, onSaved }: { provider?: Provider; kind?: ProviderKind; onClose: () => void; onSaved: (snapshot: Snapshot, result?: { ok: boolean; message: string }, codexError?: string) => void }) {
  const initial = provider ?? PRESETS[kind]
  const [draft, setDraft] = useState<ProviderInput>({ ...initial, apiKey: '' })
  const [modelsText, setModelsText] = useState(provider ? initial.models.join('\n') : initial.defaultModel)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [modelQuery, setModelQuery] = useState('')
  const ref = useDialog(onClose, saving)
  const update = <K extends keyof ProviderInput,>(key: K, value: ProviderInput[K]) => setDraft(current => ({ ...current, [key]: value }))
  const models = [...new Set(modelsText.split(/[\n,，]/).map(model => model.trim()).filter(Boolean))]
  const capabilities = modelCapabilities(draft, models.includes(draft.defaultModel) ? draft.defaultModel : models[0] ?? '')
  const capabilityModel = models.includes(draft.defaultModel) ? draft.defaultModel : models[0] ?? ''
  const profile = reasoningProfile(draft, capabilityModel)
  function configureReasoning(model: string, change?: ModelCapabilities) {
    setDraft(current => {
      const previous = current.modelCapabilities?.[model] ?? {}
      const next = { ...previous }
      if (change) Object.assign(next, change, { reasoningOverride: true })
      else for (const key of ['reasoningEfforts', 'defaultReasoningEffort', 'thinkingMode', 'thinkingControl', 'reasoningOverride'] as const) delete next[key]
      return { ...current, modelCapabilities: { ...current.modelCapabilities, [model]: next } }
    })
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError(''); setSaving(true)
    try {
      const saved = await api.saveAndConnectProvider({ ...draft, models, defaultModel: models.includes(draft.defaultModel) ? draft.defaultModel : models[0] ?? '' })
      let result: { ok: boolean; message: string } | undefined
      try { result = await api.testProvider(saved.providerId) } catch (error) { result = { ok: false, message: cleanError(error) } }
      onSaved(await api.snapshot(), result, saved.codexError)
    } catch (error) { setError(cleanError(error)) }
    finally { setSaving(false) }
  }
  async function discover() {
    setError(''); setDiscovering(true)
    try {
      const available = await api.discoverModelDetails({ id: provider?.id, baseUrl: draft.baseUrl, apiKey: draft.apiKey })
      setAvailableModels(available.map(model => model.id))
      setDraft(current => ({ ...current, modelCapabilities: { ...current.modelCapabilities, ...Object.fromEntries(available.map(({ id, ...capabilities }) => [id, mergeCapabilities(current.modelCapabilities?.[id], capabilities)])) } }))
      if (!available.length) setError('接口未返回模型，请手动填写模型 ID。')
    }
    catch (error) { setError(cleanError(error)) }
    finally { setDiscovering(false) }
  }
  return <div className="modal-backdrop editor-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose() }}><section className="provider-editor" role="dialog" aria-modal="true" aria-labelledby="editor-title" ref={ref}>
    <div className="editor-header"><h2 id="editor-title">{provider ? '编辑模型服务商' : '添加模型服务商'}</h2><p>连接第三方大模型 API，让更多模型加入你的舰队。</p><button className="icon-button" aria-label="关闭编辑" disabled={saving} onClick={onClose}><X size={22}/></button></div>
    <form onSubmit={event => void save(event)}><div className="editor-body"><SectionTitle number={1} title="选择服务商" subtitle="选择你要连接的模型服务商"/><div className="preset-picker">{kinds.map((item, index) => <button type="button" key={item} aria-label={`选择 ${names[item]}`} className={draft.kind === item ? 'selected' : ''} onClick={() => { setDraft({ ...structuredClone(PRESETS[item]), id: provider?.id, apiKey: draft.apiKey }); setModelsText(PRESETS[item].defaultModel); setAvailableModels([]); setError('') }}><ProviderMark kind={item}/><strong>{item === 'custom' ? '自定义兼容服务' : names[item]}</strong><small>{shortDescriptions[index]}</small>{draft.kind === item && <span className="preset-check"><Check size={13}/></span>}</button>)}</div>
      <SectionTitle number={2} title="配置连接信息" subtitle="填写服务商的 API 连接信息"/><div className="connection-fields">
        <label className="field"><span>服务商名称 <b>*</b></span><input name="name" required maxLength={80} placeholder="例如：我的 DeepSeek" value={draft.name} onChange={event => update('name', event.target.value)}/><small>自定义一个便于识别的名称，如：我的 DeepSeek</small></label>
        <label className="field"><span>API 地址 <b>*</b></span><input name="baseUrl" required type="url" placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={event => { setDraft(current => ({ ...current, baseUrl: event.target.value, modelCapabilities: undefined })); setAvailableModels([]) }}/><small>填写 API 基础地址，通常以 /v1 结尾</small></label>
        <div className="field"><label htmlFor="api-key">API Key <b>*</b></label><div className="password-field"><input id="api-key" name="apiKey" type={showKey ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} placeholder={provider?.apiKeySet ? '留空保留已保存的密钥' : '输入你的 API Key'} value={draft.apiKey} onChange={event => update('apiKey', event.target.value)}/><button type="button" className="icon-button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div><small>填写你的 API Key，支持 sk- 开头的密钥；本地服务可留空</small></div>
        <div className="field"><div className="field-label-row"><label htmlFor="models">模型 ID <b>*</b></label><button type="button" className="text-button" disabled={discovering || !draft.baseUrl} onClick={() => void discover()}>{discovering ? <LoaderCircle className="spin" size={12}/> : <RefreshCw size={12}/>}从接口读取</button></div><textarea id="models" name="models" required rows={Math.min(3, Math.max(1, modelsText.split('\n').length))} spellCheck={false} placeholder="deepseek-chat" value={modelsText} onChange={event => setModelsText(event.target.value)}/><small>每行一个模型 ID，例如：deepseek-chat</small></div>
      </div>
      {availableModels.length > 0 && <div className="discovered-models"><label className="search-input"><Search size={14}/><input aria-label="筛选可用模型" placeholder={`筛选 ${availableModels.length} 个可用模型…`} value={modelQuery} onChange={event => setModelQuery(event.target.value)}/></label><div>{availableModels.filter(model => model.toLowerCase().includes(modelQuery.toLowerCase())).map(model => <button type="button" className={models.includes(model) ? 'selected' : ''} key={model} onClick={() => setModelsText((models.includes(model) ? models.filter(value => value !== model) : [...models, model]).join('\n'))}>{models.includes(model) ? <Check size={12}/> : <Plus size={12}/>}<span>{model}</span></button>)}</div></div>}
      {models.length > 1 && <label className="field default-model-field"><span><Star size={13}/>默认模型</span><select value={models.includes(draft.defaultModel) ? draft.defaultModel : models[0]} onChange={event => update('defaultModel', event.target.value)}>{models.map(model => <option key={model}>{model}</option>)}</select></label>}
      <SectionTitle number={3} title="高级设置" subtitle="根据需要配置更多选项"/><div className="advanced-fields">
        <label className="field"><span>上游 API 协议 <Info size={13}/></span><select value={draft.protocol} onChange={event => update('protocol', event.target.value as ProviderInput['protocol'])}><option value="chat">Chat Completions</option><option value="responses">Responses（原生）</option></select><small>选择服务商兼容的 API 协议</small></label>
        <label className="field"><span>思考模式 <Info size={13}/></span><select aria-label="思考模式" value={draft.thinking} onChange={event => update('thinking', event.target.value as ProviderInput['thinking'])}><option value="auto">跟随 Codex 推理强度</option><option value="max">始终使用模型最高强度</option><option value="on">开启思考</option><option value="off">关闭思考</option></select><small>{draft.thinking === 'max' ? '支持 Ultra 就用 Ultra，否则用模型最高档；仅支持开关时开启思考。' : profile.reasoningEfforts.includes('ultra') ? '当前 Codex 会把 Ultra 编码为 Max；需向接口发送 Ultra 时请选择最高强度模式。' : profile.toggleOnly ? '此模型仅支持思考开关，Codex 高档代表开启思考。' : profile.thinkingMode === 'always' && !profile.reasoningEfforts.length ? '此模型始终思考，上游未提供可调强度。' : `当前模型：${capabilities.reasoningEfforts.join(' / ') || '上游未声明可调档位'}`}</small></label>
        <p className="model-capability-note" title="舰桥不设置上下文窗口或自动压缩阈值，实际限制由上游接口决定。图片能力优先使用接口信息。"><Info size={14}/><span>上下文上限由上游决定</span><small>{capabilities.vision ? '支持图片' : '文本输入'}</small></p>
      </div>{error && <div className="form-error" role="alert"><AlertCircle size={16}/>{error}</div>}
      {!!models.length && <details className="reasoning-capability-editor"><summary>按模型校准推理能力</summary><p>接口未返回能力，或中转接口提供额外档位时，可按接口实际支持情况设置。自动模式会优先读取接口能力。</p>{models.map(model => {
        const info = reasoningProfile(draft, model)
        const declared = draft.modelCapabilities?.[model]
        return <div className="reasoning-model" key={model}><div className="reasoning-model-heading"><strong title={model}>{model}</strong><label><input type="checkbox" aria-label={`手动配置 ${model}`} checked={!!declared?.reasoningOverride} onChange={event => configureReasoning(model, event.target.checked ? { reasoningEfforts: info.toggleOnly ? [] : info.reasoningEfforts, defaultReasoningEffort: info.defaultReasoningEffort, thinkingMode: info.thinkingMode ?? 'toggle', thinkingControl: info.thinkingControl } : undefined)}/>手动配置</label></div>{declared?.reasoningOverride ? <>
          <div className="reasoning-model-fields"><label>思考能力<select aria-label={`${model} 思考能力`} value={info.thinkingMode ?? 'toggle'} onChange={event => configureReasoning(model, { thinkingMode: event.target.value as ModelCapabilities['thinkingMode'] })}><option value="toggle">可开启或关闭</option><option value="always">始终开启</option><option value="none">不支持思考</option></select></label><label>思考开关参数<select aria-label={`${model} 思考开关参数`} value={info.thinkingControl} onChange={event => configureReasoning(model, { thinkingControl: event.target.value as ModelCapabilities['thinkingControl'] })}><option value="none">仅发送 reasoning_effort</option><option value="thinking">thinking.type</option><option value="enable_thinking">enable_thinking</option></select></label></div>
          <fieldset><legend>接口支持的推理档位（仅开关型模型保持全不选）</legend><div className="reasoning-levels">{REASONING_EFFORTS.map(effort => <label key={effort}><input type="checkbox" aria-label={`${model} ${effort}`} disabled={info.thinkingMode === 'none' || (info.thinkingMode === 'always' && effort === 'none')} checked={declared.reasoningEfforts?.includes(effort) ?? false} onChange={event => { const levels = event.target.checked ? [...declared.reasoningEfforts ?? [], effort] : (declared.reasoningEfforts ?? []).filter(value => value !== effort); configureReasoning(model, { reasoningEfforts: levels, defaultReasoningEffort: highestEffort(levels) }) }}/>{effort}</label>)}</div></fieldset>
        </> : <small>{info.toggleOnly ? '思考开关' : info.reasoningEfforts.join(' / ') || (info.thinkingMode === 'always' ? '始终思考 · 无强度参数' : '未声明推理档位')}{info.thinkingMode === 'always' && info.reasoningEfforts.length ? ' · 不支持关闭' : ''}</small>}</div>
      })}</details>}
    </div><div className="editor-footer"><button type="button" className="button" disabled={saving} onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={saving || !models.length}>{saving ? <LoaderCircle size={17} className="spin"/> : <Check size={18}/>} {saving ? '正在接入 Codex…' : '保存并连接'}</button></div></form>
  </section></div>
}

function SettingsView({ snapshot, updates, busy, onSave, onSelect, copy, notify }: { snapshot: Snapshot; updates?: UpdateState; busy: boolean; onSave: (settings: Settings) => void; onSelect: (id: string) => void; copy: (text: string) => Promise<void>; notify: (text: string, error?: boolean) => void }) {
  const [draft, setDraft] = useState(snapshot.settings)
  const update = <K extends keyof Settings,>(key: K, value: Settings[K]) => setDraft(current => ({ ...current, [key]: value }))
  const open = (action: () => Promise<void>) => void action().catch(error => notify(cleanError(error), true))
  return <div className="settings-page"><section className="hero settings-hero"><div className="hero-copy"><div className="eyebrow">FLEET BRIDGE</div><h2>安全、<em>灵活、</em><br/>完全由<em>你掌控。</em></h2><p>通过本地代理、数据加密和灵活的配置选项，<br/>让舰桥在你的设备上更安全、更高效地运行。</p></div></section>
    <div className="settings-grid"><section className="panel runtime-settings"><div className="settings-heading"><span className="section-icon"><SlidersHorizontal/></span><div><h2>运行设置</h2><p>配置舰桥的基础运行行为。</p></div></div><form onSubmit={event => { event.preventDefault(); onSave(draft) }}>
      <div className="setting-row"><div><label htmlFor="proxy-port">本地代理端口</label><small>修改前，请先确保 Codex 原连接已关闭。</small></div><input id="proxy-port" type="number" min={1024} max={65535} value={draft.port} onChange={event => update('port', Number(event.target.value))}/></div>
      <div className="setting-row"><div><strong>打开舰桥时启动代理</strong><small>启动后即可接收 Codex 的模型请求。</small></div><Toggle label="打开舰桥时启动代理" checked={draft.autoStart} onChange={value => update('autoStart', value)}/></div>
      <div className="setting-row"><div><strong>登录电脑时启动舰桥</strong><small>随系统启动，保持本地连接可用。</small></div><Toggle label="登录电脑时启动舰桥" checked={draft.launchAtLogin} onChange={value => update('launchAtLogin', value)}/></div>
      <div className="setting-row appearance-row"><div><strong>外观与体验</strong><small>自定义舰桥的显示效果。</small></div><div className="appearance-controls"><label className="select-wrap"><Sun size={17}/><select aria-label="外观" value={draft.theme ?? 'system'} onChange={event => update('theme', event.target.value as Settings['theme'])}><option value="system">跟随系统</option><option value="light">浅色外观</option><option value="dark">深色外观</option></select><ChevronDown size={14}/></label></div></div>
      <UpdateControls state={updates} settings={draft} onSetting={(key, value) => update(key, value)} notify={notify}/>
      <div className="settings-save"><button className="button primary" disabled={busy} type="submit"><Check size={20}/>保存设置</button><span><i/>设置将即时生效</span></div>
    </form></section><div className="settings-right"><section className="panel security-settings"><div className="settings-heading"><span className="section-icon"><ShieldCheck/></span><div><h2>本地数据与安全</h2><p>舰桥的配置与数据仅保存在本地设备，安全可控。</p></div></div><div className="encryption-callout"><span><LockKeyhole size={26}/></span><div><strong>{snapshot.vault}</strong><p>使用 Windows 的 DPAPI 加密保护你的 API Key，<br className="wide-only"/>配置与连接记录仅保存在本地。</p></div><ShieldCheck size={16}/></div>
        <div className="path-row"><span>Codex 配置路径 <CircleHelp size={14}/></span><input readOnly aria-label="Codex 配置路径" value={snapshot.codex.configPath}/><button className="button icon-button" aria-label="复制 Codex 配置路径" onClick={() => void copy(snapshot.codex.configPath)}><Copy size={16}/></button><button className="button" onClick={() => open(api.openCodexFolder)}><FolderOpen size={17}/>打开</button></div>
        <div className="path-row"><span>舰桥数据目录 <CircleHelp size={14}/></span><input readOnly aria-label="舰桥数据目录" value={snapshot.dataPath}/><button className="button icon-button" aria-label="复制舰桥数据目录" onClick={() => void copy(snapshot.dataPath)}><Copy size={16}/></button><button className="button" onClick={() => open(api.openDataFolder)}><FolderOpen size={17}/>打开</button></div>
      </section><section className="panel preferences-settings"><div className="settings-heading"><span className="section-icon"><Network/></span><div><h2>连接偏好</h2><p>自定义连接与模型调用的默认行为。</p></div></div><div className="preference-row"><div><strong>新建对话时的默认服务商</strong><small>选择在工作台新建对话时默认使用的模型服务商。</small></div><label className="select-wrap"><Star size={19} className="gold-star" fill="currentColor"/><select aria-label="默认服务商" disabled={busy || !snapshot.providers.length} value={snapshot.activeProviderId ?? ''} onChange={event => onSelect(event.target.value)}>{!snapshot.providers.length && <option value="">等待添加</option>}{snapshot.providers.filter(provider => provider.enabled !== false).map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><ChevronDown size={14}/></label></div><div className="preference-row"><div><strong>超时设置</strong><small>设置请求超时时间，适应不同网络环境。</small></div><label className="select-wrap"><Clock3 size={18}/><select aria-label="超时设置" value={draft.timeout ?? 120} onChange={event => update('timeout', Number(event.target.value))}>{[30, 60, 120, 300, 600].map(value => <option key={value} value={value}>{value} 秒</option>)}</select><ChevronDown size={14}/></label></div></section></div></div>
    <section className="panel about-settings" aria-label="关于 Fleet Bridge"><div className="settings-heading"><span className="section-icon"><Info/></span><div><h2>关于 Fleet Bridge</h2><p>轻量、清爽，为你的使用习惯而定制。</p></div></div><p><strong>Fleet Bridge为轻量高定制度面板，去掉冗余功能面板清新整洁，适合新手使用，如果在使用中发现bug或者你想要定制添加其他功能请通过github提交 <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); open(api.openIssues) }}>Issues</a> 或通过博客，QQ等任意方式与我取得联系使我进行更新。</strong></p></section>
  </div>
}

function UpdateControls({ state, settings, onSetting, notify }: { state?: UpdateState; settings: Settings; onSetting: (key: 'autoCheckUpdates' | 'autoDownloadUpdates' | 'autoInstallUpdates', value: boolean) => void; notify: (text: string, error?: boolean) => void }) {
  const pending = state && ['checking', 'downloading', 'installing'].includes(state.phase)
  const automaticSupported = Boolean(state && ['installer', 'development'].includes(state.mode))
  const run = (action: () => Promise<unknown>) => void action().catch(error => notify(cleanError(error), true))
  const preference = (key: 'autoCheckUpdates' | 'autoDownloadUpdates' | 'autoInstallUpdates', value: boolean) => {
    if (key === 'autoInstallUpdates' && value) { onSetting('autoCheckUpdates', true); onSetting('autoDownloadUpdates', true) }
    else if (key !== 'autoInstallUpdates' && !value) onSetting('autoInstallUpdates', false)
    onSetting(key, value)
  }
  return <div className="update-settings" aria-label="应用更新">
    <div className="update-heading"><strong>应用更新 <small>v{state?.currentVersion ?? '…'}</small><RepositoryLink notify={notify}/></strong>{state?.releasesUrl && <button className="text-button" type="button" onClick={() => run(api.openUpdatePage)}>GitHub 发布页<ExternalLink size={13}/></button>}</div>
    <p className={state?.phase === 'error' ? 'update-error' : ''} role="status">{state?.message ?? '正在读取更新状态…'}</p>
    {state?.phase === 'downloading' && <progress aria-label="更新下载进度" max={100} value={state.percent ?? 0}/>}
    <div className="update-actions">
      <button className="button" type="button" disabled={!state || state.mode !== 'installer' || pending || state.phase === 'downloaded'} onClick={() => run(api.checkForUpdates)}><RefreshCw size={15} className={state?.phase === 'checking' ? 'spin' : ''}/>{state?.phase === 'checking' ? '正在检查…' : '检查更新'}</button>
      {state?.version && ['available', 'error'].includes(state.phase) && <button className="button primary" type="button" onClick={() => run(api.downloadUpdate)}><Download size={15}/>下载 v{state.version}</button>}
      {state?.phase === 'downloaded' && <button className="button primary" type="button" onClick={() => run(api.installUpdate)}><RefreshCw size={15}/>重启更新 v{state.version}</button>}
      {state?.phase === 'downloading' && <span>{(state.percent ?? 0).toFixed(1)}%</span>}
    </div>
    <label className="update-preference"><span>自动更新<small>退出时安装，下次启动使用新版</small></span><Toggle label="自动更新" checked={automaticSupported && settings.autoInstallUpdates !== false} disabled={!automaticSupported} onChange={value => preference('autoInstallUpdates', value)}/></label>
    <label className="update-preference"><span>启动后及运行期间自动检查</span><Toggle label="自动检查更新" checked={settings.autoCheckUpdates !== false} onChange={value => preference('autoCheckUpdates', value)}/></label>
    <label className="update-preference"><span>发现新版后自动下载</span><Toggle label="自动下载更新" checked={settings.autoDownloadUpdates !== false} onChange={value => preference('autoDownloadUpdates', value)}/></label>
    <p>保存设置后生效。安装版默认开启自动更新，可随时关闭；下载不打断模型请求。点击「重启更新」会静默更新并重新打开舰桥。从托盘选择「退出舰桥」时静默安装，不自动重启；收起到托盘不会安装。便携版请下载安装版以使用自动更新，本地配置会保留。</p>
  </div>
}

function LogsView({ logs, providers, usage }: { logs: RequestLog[]; providers: Provider[]; usage: UsageHistory }) {
  const [query, setQuery] = useState('')
  const [time, setTime] = useState('all')
  const [status, setStatus] = useState('all')
  const [provider, setProvider] = useState('all')
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<'time' | 'latency'>('time')
  const [ascending, setAscending] = useState(false)
  const [detail, setDetail] = useState<RequestLog>()
  const [group, setGroup] = useState('day')
  const today = new Date()
  const initialStart = new Date(today); initialStart.setDate(today.getDate() - 12)
  const [start, setStart] = useState(localDay(initialStart))
  const [end, setEnd] = useState(localDay(today))
  const successful = logs.filter(log => log.status === 'ok').length
  const completedAttempts = logs.filter(log => log.status !== 'cancelled').length
  const avg = logs.length ? logs.reduce((sum, log) => sum + log.latency, 0) / logs.length : 0
  const totals = totalUsage(usage.daily)
  const allTokens = totals.inputTokens + totals.outputTokens
  const filtered = logs.filter(log => (status === 'all' || status === log.status) && (provider === 'all' || provider === log.provider) && (time === 'all' || Date.now() - new Date(log.at).getTime() < Number(time) * 86400000) && `${log.provider} ${log.model} ${log.path ?? '/v1/responses'} ${log.error ?? ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => (sort === 'time' ? new Date(a.at).getTime() - new Date(b.at).getTime() : a.latency - b.latency) * (ascending ? 1 : -1))
  const pages = Math.max(1, Math.ceil(filtered.length / 6))
  const safePage = Math.min(page, pages)
  useEffect(() => setPage(1), [query, time, status, provider])
  const sortBy = (field: 'time' | 'latency') => { if (field === sort) setAscending(!ascending); else { setSort(field); setAscending(false) } }
  return <div className="logs-page"><section className="log-stats">{[
    { icon: Box, label: '累计请求', value: number(totals.requests), color: '', bars: true },
    { icon: Star, label: '响应完成率', value: completedAttempts ? `${(successful / completedAttempts * 100).toFixed(1)}%` : '—', color: 'gold', bars: false },
    { icon: Zap, label: '平均耗时', value: logs.length ? duration(avg) : '—', color: 'blue', bars: false },
    { icon: Database, label: '累计 Tokens', value: formatTokens(allTokens), color: 'purple', bars: true }
  ].map(({ icon: Icon, label, value, color, bars }) => <div className={`log-stat ${color}`} key={label}><span className={`stat-icon ${color === 'purple' ? '' : color}`}><Icon fill={color === 'gold' || color === 'blue' ? 'currentColor' : 'none'}/></span><div className="log-stat-copy"><small title={label === '响应完成率' ? '按舰桥完整接收到响应的请求尝试统计，排除主动取消；不代表上游 API 成功率。' : undefined}>{label}</small><strong title={color === 'purple' ? `${exactTokens(allTokens)} Tokens` : undefined}>{value}</strong></div><div className="log-stat-footer"><div className="log-stat-caption"><span className="stat-hint" title={label === '累计请求' ? '按本地每日统计累计全部请求尝试，包含失败、取消和用量未知的请求，不受最近 300 条连接明细限制。' : color === 'purple' ? '独立保存的每日统计，不受最近 300 条连接明细限制；仅累计有效的上游用量。' : label === '响应完成率' ? '每条记录对应一次本地请求尝试，重试会分别记录。' : `最近 ${logs.length} 条本地记录`}>{label === '累计请求' ? '历史请求累计' : color === 'purple' ? '每日用量累计' : label === '响应完成率' ? '取消不计入' : logs.length ? `${logs.length} 条本地记录` : '暂无请求记录'}</span><span className="stat-period">{color === 'purple' ? '仅统计已知用量' : label === '响应完成率' ? '本地接收结果' : (label === '累计请求' ? totals.requests : logs.length) ? '仅本地数据' : '等待首次请求'}</span></div>{bars ? <MiniBars logs={logs} tokens={color === 'purple'}/> : <Sparkline logs={logs} latency={color === 'blue'}/>}</div></div>)}</section>
    <UsageHeatmap history={usage}/>
    <section className="panel trend-panel"><div className="trend-heading"><h2>请求趋势</h2><div><label className="date-range"><CalendarDays size={15}/><input aria-label="趋势开始日期" type="date" value={start} max={end} onChange={event => setStart(event.target.value)}/><ArrowRight size={14}/><input aria-label="趋势结束日期" type="date" value={end} min={start} onChange={event => setEnd(event.target.value)}/></label><label className="select-wrap"><select aria-label="趋势分组" value={group} onChange={event => setGroup(event.target.value)}><option value="day">按天</option><option value="hour">按小时</option></select><ChevronDown size={14}/></label></div></div><TrendChart logs={logs} start={start} end={end} hourly={group === 'hour'}/></section>
    <div className="log-filters"><label className="search-input"><Search size={19}/><input aria-label="搜索连接记录" placeholder="搜索请求路径、模型、或其他内容..." value={query} onChange={event => setQuery(event.target.value)}/></label><label className="select-wrap"><CalendarDays size={16}/><select aria-label="时间范围" value={time} onChange={event => setTime(event.target.value)}><option value="all">全部时间</option><option value="1">最近 24 小时</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option></select><ChevronDown size={14}/></label><label className="select-wrap"><Clock3 size={17}/><select aria-label="请求状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="ok">成功</option><option value="error">失败 / 处理异常</option><option value="interrupted">连接中断</option><option value="timeout">超时</option><option value="incomplete">输出未完成</option><option value="cancelled">已取消</option></select><ChevronDown size={14}/></label><label className="select-wrap"><Box size={18}/><select aria-label="筛选服务商" value={provider} onChange={event => setProvider(event.target.value)}><option value="all">全部服务商</option>{[...new Set(logs.map(log => log.provider))].map(name => <option key={name}>{name}</option>)}</select><ChevronDown size={14}/></label><button className="button" onClick={() => { setQuery(''); setTime('all'); setStatus('all'); setProvider('all'); setSort('time'); setAscending(false); setPage(1) }}><RotateCcw size={16}/>重置</button></div>
    <section className="panel logs-table-panel"><div className="table-scroll"><table className="log-table"><thead><tr><th><button onClick={() => sortBy('time')}>时间<ArrowDownUp size={12}/></button></th><th>服务商</th><th>模型</th><th>请求路径</th><th>状态</th><th>输入 Tokens</th><th>输出 Tokens</th><th><button onClick={() => sortBy('latency')}>耗时<ArrowDownUp size={12}/></button></th><th>操作</th></tr></thead><tbody>{filtered.slice((safePage - 1) * 6, safePage * 6).map(log => <tr key={log.id}><td className="time-cell">{new Date(log.at).toLocaleString('sv-SE')}</td><td><span className="log-provider"><ProviderMark small kind={providers.find(provider => provider.name === log.provider)?.kind ?? 'custom'}/>{log.provider}</span></td><td className="log-model" title={log.model}><ModelLabel model={log.model}/></td><td>{log.path ?? '/v1/responses'}</td><td><span className={`log-status ${log.status}`} title={requestStatusHint(log)}><i/>{requestStatusLabel(log)}</span></td><td>{knownUsage(log) ? number(log.inputTokens) : '—'}</td><td>{knownUsage(log) ? number(log.outputTokens) : '—'}</td><td>{duration(log.latency)}</td><td><button className="icon-button" aria-label={`查看请求 ${log.id}`} onClick={() => setDetail(log)}><MoreHorizontal size={20}/></button></td></tr>)}</tbody></table></div>{!filtered.length && <div className="empty-state logs-empty"><Activity size={28}/><h3>{logs.length ? '没有匹配的连接记录' : '还没有连接记录'}</h3><p>{logs.length ? '调整筛选条件后重试。' : '在 Codex 中发出一次请求，记录就会出现在这里。'}</p></div>}
      <div className="table-footer"><span>共 {number(filtered.length)} 条记录</span><div className="pagination"><button aria-label="上一页" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}><ChevronLeft size={16}/></button>{paginationItems(safePage, pages).map((item, index) => item === 'ellipsis' ? <span key={`ellipsis-${index}`}>…</span> : <button className={item === safePage ? 'selected' : ''} aria-current={item === safePage ? 'page' : undefined} key={item} onClick={() => setPage(item)}>{item}</button>)}<button aria-label="下一页" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}><ChevronRight size={16}/></button></div></div>
    </section>
    {detail && <SimpleDialog title="请求详情" onClose={() => setDetail(undefined)}><dl className="request-detail">{Object.entries({ 时间: new Date(detail.at).toLocaleString(), 服务商: detail.provider, 模型: detail.model, 请求路径: detail.path ?? '/v1/responses', ...(detail.reasoningEffort ? { 上游推理强度: detail.reasoningEffort } : {}), 本地结果: requestStatusLabel(detail), 上游结果: upstreamOutcomeLabel(detail), 上游HTTP状态: detail.upstreamHttpStatus ?? '未收到或旧记录未保存', ...(detail.failureStage ? { 异常阶段: failureStageLabels[detail.failureStage] } : {}), ...(detail.upstreamRequestId ? { 上游请求ID: detail.upstreamRequestId } : {}), 输入Tokens: knownUsage(detail) ? detail.inputTokens : '未收到用量', 输出Tokens: knownUsage(detail) ? detail.outputTokens : '未收到用量', 耗时: duration(detail.latency), ...(detail.errorCode ? { 网络错误码: detail.errorCode } : {}), ...(detail.note ? { 说明: detail.note } : {}), ...(detail.error ? { 错误信息: detail.error } : {}) }).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl><p className="request-log-note">每条记录对应一次本地请求尝试，重试会分别记录。连接中断或超时不能直接认定上游模型生成失败。</p></SimpleDialog>}
  </div>
}

function Sparkline({ logs, latency }: { logs: RequestLog[]; latency: boolean }) {
  if (logs.length < 2) return null
  const values = logs.slice(0, 16).reverse().map(log => latency ? log.latency : log.status === 'ok' ? 1 : 0)
  const max = Math.max(1, ...values); const min = Math.min(0, ...values)
  const points = values.length ? values.map((value, i) => `${i / Math.max(1, values.length - 1) * 110},${43 - (value - min) / (max - min) * 35}`).join(' ') : '0,43 110,43'
  return <svg className="sparkline" viewBox="0 0 110 50" aria-hidden="true"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.8"/></svg>
}
function TrendChart({ logs, start, end, hourly }: { logs: RequestLog[]; start: string; end: string; hourly: boolean }) {
  const startDate = new Date(`${start}T00:00:00`); const endDate = new Date(`${end}T23:59:59.999`)
  const days = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86400000))
  const binDays = Math.max(1, Math.ceil(days / 62))
  const count = hourly ? 24 : Math.ceil(days / binDays)
  const values = Array.from({ length: count }, (_, i) => ({ label: hourly ? `${String(i).padStart(2, '0')}:00` : localDay(new Date(startDate.getTime() + i * binDays * 86400000)).slice(5), value: 0 }))
  for (const log of logs) {
    const date = new Date(log.at)
    if (date >= startDate && date <= endDate) {
      const i = hourly ? date.getHours() : Math.floor(Math.round((new Date(`${localDay(date)}T00:00:00`).getTime() - startDate.getTime()) / 86400000) / binDays)
      if (values[i]) values[i].value++
    }
  }
  const max = Math.max(2, Math.ceil(Math.max(0, ...values.map(item => item.value)) / 2) * 2)
  return <div className="trend-chart"><div className="chart-axis"><span>{max}</span><span>{max / 2}</span><span>0</span></div><div className="chart-plot"><div className="chart-grid-lines"><i/><i/><i/></div><div className="chart-bars">{values.map((item, i) => <div className="chart-column" key={i}><div className="bar-slot"><i title={`${item.label}：${item.value} 次请求`} style={{ height: `${item.value / max * 100}%` }}/></div><span>{i % Math.max(1, Math.ceil(count / 8)) === 0 || i === count - 1 ? item.label : ''}</span></div>)}</div></div></div>
}
function SimpleDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useDialog(onClose)
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section ref={ref} className="simple-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><button className="icon-button dialog-close" aria-label="关闭窗口" onClick={onClose}><X size={20}/></button><h2 id="dialog-title">{title}</h2>{children}</section></div>
}
