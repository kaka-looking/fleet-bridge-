import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { Store, normalizeBaseUrl } from './store'
import { buildCatalog, DEFAULT_MODEL } from './catalog'
import { ChatStream, fromChat, parseSSE, responseUsage, toChat, type Json } from './translate'
import type { DiscoveredModel, Provider, RequestLog } from '../shared/types'
import { reasoningProfile, sanitizeCapabilities } from '../shared/model-capabilities'
import { applyReasoning } from './reasoning'
import { OriginalConnection, ORIGINAL_ID } from './original'

export class HttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
export function transportErrorCode(error: unknown): string | undefined {
  let current = error as any
  for (let depth = 0; current && depth < 4; depth++, current = current.cause) {
    if (typeof current.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(current.code)) return current.code
  }
}
function transportFailure(error: unknown) {
  return /fetch failed|terminated|socket|network|premature close/i.test(error instanceof Error ? error.message : String(error))
    || /^(?:ECONN|EPIPE|ENOTFOUND|EAI_|UND_ERR_|ERR_STREAM_PREMATURE_CLOSE)/.test(transportErrorCode(error) ?? '')
}
export function safeError(error: unknown, secrets: string[] = []) {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) if (secret) message = message.split(secret).join('[已隐藏密钥]')
  return message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').slice(0, 800)
}
async function upstreamError(response: Response, secret: string) {
  let message = `上游返回 HTTP ${response.status}`
  try {
    const raw = await response.text()
    try { const data = JSON.parse(raw); message += `：${data.error?.message ?? data.message ?? response.statusText}` }
    catch { message += `：${response.statusText}` }
  } catch { /* disconnected */ }
  return new HttpError(502, safeError(new Error(message), [secret]))
}
export function upstreamHeaders(key: string) { return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) } }
async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 32 * 1024 * 1024) throw new HttpError(413, '请求超过 32 MB，请减少附件或上下文。')
    chunks.push(Buffer.from(chunk))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new HttpError(400, '请求不是有效的 JSON。') }
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data))
}
export class Gateway {
  private server?: Server
  private starting?: Promise<void>
  private controllers = new Set<AbortController>()
  private previous = new Map<string, { input: any[]; providerId: string; model: string; at: number; size: number }>()
  private cacheBytes = 0
  error?: string
  constructor(private store: Store, private original?: OriginalConnection) {}
  private catalog() { return buildCatalog(this.store.providers, this.store.activeProviderId, this.original) }
  get running() { return this.server?.listening === true }
  get inflight() { return this.controllers.size }
  get url() { return `http://127.0.0.1:${this.store.settings.port}/v1` }
  async start() {
    if (this.running) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const server = createServer((req, res) => { void this.handle(req, res) })
      server.requestTimeout = 600000
      server.headersTimeout = 60000
      this.server = server
      try {
        server.listen(this.store.settings.port, '127.0.0.1')
        await once(server, 'listening')
        this.error = undefined
      } catch (error) {
        this.server = undefined
        this.error = `本地代理启动失败：${safeError(error)}。请在设置中更换端口。`
        throw new Error(this.error)
      }
    })().finally(() => { this.starting = undefined })
    return this.starting
  }
  async stop() {
    if (this.starting) await this.starting.catch(() => {})
    for (const controller of this.controllers) controller.abort(new Error('舰桥代理已停止，请求已取消。'))
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }
  private route(model: unknown) {
    const slug = typeof model === 'string' ? model : DEFAULT_MODEL
    if (slug === DEFAULT_MODEL) {
      const provider = this.store.providers.find(provider => provider.id === this.store.activeProviderId && provider.enabled !== false) ?? (this.original?.provider?.enabled !== false ? this.original?.provider : undefined)
      if (!provider) throw new HttpError(503, '请先启用一个服务商。')
      return { provider, model: provider.defaultModel }
    }
    if (slug.startsWith('fleet/')) {
      const [, id, ...name] = slug.split('/')
      const provider = this.store.providers.find(p => p.id === id)
      const model = name.join('/')
      if (provider?.models.includes(model) && provider.enabled !== false) return { provider, model }
      throw new HttpError(400, `模型已删除或未配置：${slug}。请刷新 Codex 的模型列表。`)
    }
    const original = this.original?.provider
    if (original?.enabled !== false && original?.models.includes(slug)) return { provider: original, model: slug }
    const matches = this.store.providers.filter(p => p.enabled !== false && p.models.includes(slug))
    if (matches.length === 1) return { provider: matches[0], model: slug }
    throw new HttpError(400, `无法唯一匹配模型 ${slug}。请在 Codex 中选择带有服务商名称的舰桥模型。`)
  }
  private remember(response: Json, request: Json, providerId: string, model: string) {
    if (!response.id || !Array.isArray(response.output)) return
    const input = [...(typeof request.input === 'string' ? [{ type: 'message', role: 'user', content: request.input }] : Array.isArray(request.input) ? request.input : []), ...response.output]
    const size = Buffer.byteLength(JSON.stringify(input))
    if (size > 16 * 1024 * 1024) return
    for (const [id, entry] of this.previous) {
      if (Date.now() - entry.at > 1800000 || this.previous.size >= 64 || this.cacheBytes + size > 32 * 1024 * 1024) { this.previous.delete(id); this.cacheBytes -= entry.size }
    }
    const old = this.previous.get(response.id)
    if (old) this.cacheBytes -= old.size
    this.previous.set(response.id, { input, providerId, model, at: Date.now(), size }); this.cacheBytes += size
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const controller = new AbortController()
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let converter: ChatStream | undefined
    let provider: Provider | undefined
    let model = ''
    let key = ''
    let usage: Json = {}
    let status: RequestLog['status'] = 'ok'
    let errorMessage: string | undefined
    let reasoningEffort: string | undefined
    let stage: NonNullable<RequestLog['failureStage']> = 'prepare'
    let failureStage: RequestLog['failureStage']
    let upstreamOutcome: NonNullable<RequestLog['upstreamOutcome']> = 'not_sent'
    let upstreamHttpStatus: number | undefined
    let upstreamRequestId: string | undefined
    let errorCode: string | undefined
    let note: string | undefined
    let usageKnown = false
    let timeoutSignal: AbortSignal | undefined
    let signal: AbortSignal | undefined
    const captureUsage = (value: any) => {
      if (!value || !['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens'].some(key => Number.isFinite(value[key]))) return
      usage = responseUsage(value); usageKnown = true
    }
    const began = performance.now()
    let logged = false
    try {
      if (req.headers.origin) throw new HttpError(403, '本地模型代理不接受网页跨域请求。')
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\/v1/, '')
      if (req.method === 'GET' && path === '/health') { json(res, 200, { status: 'ok', service: 'fleet-bridge' }); return }
      const provided = Buffer.from(req.headers.authorization ?? '')
      const expected = Buffer.from(`Bearer ${this.store.token}`)
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new HttpError(401, '本地代理认证失败，请在舰桥中重新接入 Codex。')
      if (req.method === 'GET' && path === '/models') {
        json(res, 200, { object: 'list', data: this.catalog().models.filter(m => m.visibility === 'list').map(m => ({ id: m.slug, object: 'model', owned_by: 'fleet-bridge' })) }); return
      }
      if (req.method === 'GET' && path === '/model-catalog') { json(res, 200, this.catalog()); return }
      if (req.method !== 'POST' || !['/responses', '/responses/compact'].includes(path)) throw new HttpError(404, '未找到接口。')
      const original = await readBody(req)
      if (!original || typeof original !== 'object' || Array.isArray(original)) throw new HttpError(400, '请求体必须为 JSON 对象。')
      const route = this.route(original.model)
      provider = route.provider; model = route.model; key = provider.id === ORIGINAL_ID ? this.original!.key : this.store.key(provider.id); logged = true
      if (path === '/responses/compact' && provider.protocol !== 'responses') throw new HttpError(400, '此模型使用本地上下文压缩，不支持远程 compact 接口。')
      if (original.background) throw new HttpError(400, '本地代理暂不支持后台 Responses 任务。')
      const request = structuredClone(original)
      if (request.previous_response_id && provider.protocol === 'chat') {
        const previous = this.previous.get(request.previous_response_id)
        if (!previous || Date.now() - previous.at > 1800000) throw new HttpError(400, '前一轮上下文已过期，请重发完整对话或新建对话。')
        if (previous.providerId !== provider.id || previous.model !== model) throw new HttpError(400, '引用的对话属于其他模型，请新建对话。')
        request.input = [...previous.input, ...(typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : request.input ?? [])]
      }
      this.controllers.add(controller)
      res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('Codex 已取消请求或断开连接。')) })
      timeoutSignal = AbortSignal.timeout((this.store.settings.timeout ?? 120) * 1000)
      signal = AbortSignal.any([controller.signal, timeoutSignal])
      const native = provider.protocol === 'responses'
      const converted = native ? undefined : toChat(request, provider, model)
      const body = native ? { ...request, model } : converted!.body
      if (native) applyReasoning(request, body, provider, model, true)
      reasoningEffort = body.reasoning_effort ?? body.reasoning?.effort ?? (body.thinking ? `thinking:${body.thinking.type}` : typeof body.enable_thinking === 'boolean' ? `enable_thinking:${body.enable_thinking}` : undefined)
      const upstreamPath = native ? path === '/responses/compact' ? 'responses/compact' : 'responses' : 'chat/completions'
      stage = 'connect'; upstreamOutcome = 'unknown'
      const upstream = await fetch(provider.id === ORIGINAL_ID ? this.original!.url(upstreamPath) : `${provider.baseUrl}/${upstreamPath}`, { method: 'POST', headers: provider.id === ORIGINAL_ID ? this.original!.headers() : upstreamHeaders(key), body: JSON.stringify(body), signal })
      upstreamHttpStatus = upstream.status
      const requestId = upstream.headers.get('x-request-id') ?? upstream.headers.get('request-id') ?? upstream.headers.get('x-amzn-requestid')
      if (requestId) upstreamRequestId = safeError(new Error(requestId), [key, this.store.token]).slice(0, 160)
      stage = 'receive'
      if (!upstream.ok) { upstreamOutcome = 'failed'; throw await upstreamError(upstream, key) }
      if (request.stream === true) {
        if (!upstream.body) throw new Error('上游返回空响应。')
        if (!upstream.headers.get('content-type')?.includes('text/event-stream')) throw new Error('上游未返回 SSE 流，请检查服务商协议设置。')
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
        heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n') }, 15000)
        if (native) {
          let complete = false
          for await (const event of parseSSE(upstream.body)) {
            if (event.data === '[DONE]') continue
            const data = JSON.parse(event.data)
            const type = data.type ?? event.event
            captureUsage(data.response?.usage ?? data.usage)
            if (['error', 'response.failed'].includes(type) || data.response?.status === 'failed') {
              upstreamOutcome = 'failed'
              throw new Error(data.error?.message ?? data.response?.error?.message ?? '上游响应失败。')
            }
            if (type === 'response.completed' || type === 'response.incomplete') {
              complete = true; upstreamOutcome = 'completed'
              status = type === 'response.incomplete' ? 'incomplete' : 'ok'
              if (status === 'incomplete') note = `上游已结束输出：${data.response?.incomplete_details?.reason ?? '输出未完成'}`
              if (data.response) { data.response.model = original.model; this.remember(data.response, request, provider.id, model) }
            }
            if (data.response) data.response.model = original.model
            if (!res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)) await once(res, 'drain', { signal })
            // A valid terminal event completes the request; a later socket reset
            // or a server that keeps SSE open must not turn it into a failure.
            if (complete) break
          }
          if (!complete) throw new Error('上游连接提前关闭，未收到完成事件。')
        } else {
          converter = new ChatStream(original, converted!.context, data => { res.write(data) })
          converter.start()
          try {
            for await (const event of parseSSE(upstream.body)) {
              if (event.data === '[DONE]') break
              const chunk = JSON.parse(event.data)
              captureUsage(chunk.usage)
              if (chunk.error) { upstreamOutcome = 'failed'; throw new Error(chunk.error.message ?? '上游返回流式错误。') }
              converter.chunk(chunk)
              if (converter.upstreamFinished) upstreamOutcome = 'completed'
              if (res.writableLength > 65536) await once(res, 'drain', { signal })
            }
          } catch (error) {
            const tailInterrupted = transportFailure(error) || (timeoutSignal.aborted && signal.reason === timeoutSignal.reason)
            if (!converter.upstreamFinished || controller.signal.aborted || upstreamOutcome === 'failed' || !tailInterrupted) throw error
            note = '已收到上游完成标记；尾部连接中断，已保留完整响应及已收到的用量。'
          }
          if (!converter.upstreamFinished) throw new Error('上游连接提前关闭，未收到完成标记。')
          stage = 'convert'
          const response = converter.complete(); usage = response.usage
          upstreamOutcome = 'completed'
          status = response.status === 'incomplete' ? 'incomplete' : 'ok'
          if (status === 'incomplete') note = '上游已结束输出：达到输出长度限制。'
          this.remember(response, request, provider.id, model)
        }
        stage = 'deliver'
        if (controller.signal.aborted || res.destroyed) throw controller.signal.reason ?? new Error('Codex 连接已关闭。')
        res.end()
      } else {
        const upstreamBody = await upstream.json() as Json
        captureUsage(upstreamBody.usage)
        if (upstreamBody.error || (native && upstreamBody.status === 'failed')) {
          upstreamOutcome = 'failed'
          throw new Error(upstreamBody.error?.message ?? '上游明确返回响应失败。')
        }
        if (native ? Array.isArray(upstreamBody.output) : upstreamBody.choices?.[0]?.message) upstreamOutcome = 'completed'
        stage = 'convert'
        if (native && !Array.isArray(upstreamBody.output)) throw new Error('上游响应缺少 output，无法作为 Responses 响应返回。')
        const response = native ? upstreamBody : fromChat(upstreamBody, original, converted!.context)
        if (response.error) throw new Error(response.error.message ?? '上游响应失败。')
        response.model = original.model
        usage = response.usage ?? {}
        status = response.status === 'incomplete' ? 'incomplete' : 'ok'
        if (status === 'incomplete') note = `上游已结束输出：${response.incomplete_details?.reason ?? '输出未完成'}`
        this.remember(response, request, provider.id, model)
        stage = 'deliver'
        if (controller.signal.aborted || res.destroyed) throw controller.signal.reason ?? new Error('Codex 连接已关闭。')
        json(res, 200, response)
      }
    } catch (error) {
      errorCode = transportErrorCode(error)
      const timedOut = (timeoutSignal?.aborted && signal?.reason === timeoutSignal.reason) || (!controller.signal.aborted && /TIMEOUT/.test(errorCode ?? ''))
      const cancelled = controller.signal.aborted || res.destroyed
      const disconnected = upstreamOutcome !== 'failed' && (transportFailure(error) || /连接提前关闭|未收到完成/.test(error instanceof Error ? error.message : String(error)))
      status = cancelled && !timedOut ? 'cancelled' : timedOut ? 'timeout' : disconnected ? 'interrupted' : 'error'
      failureStage = cancelled && !timedOut ? 'deliver' : stage
      const detail = safeError(error, [key, this.store.token])
      errorMessage = status === 'interrupted' ? `${upstreamHttpStatus ? `上游已返回 HTTP ${upstreamHttpStatus}，但舰桥未收到完整响应` : '舰桥未收到上游响应头'}；上游是否完成尚未确认。${detail}${errorCode ? `（${errorCode}）` : ''}`
        : status === 'timeout' ? `等待上游响应超时；上游是否完成尚未确认。${detail}` : detail
      if (!res.destroyed) {
        if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 502, { error: { message: errorMessage, type: 'fleet_bridge_error' } })
        else {
          const code = status === 'interrupted' ? 'connection_interrupted' : status === 'timeout' ? 'request_timeout' : upstreamOutcome === 'failed' ? 'upstream_error' : 'fleet_bridge_error'
          if (converter) converter.fail(errorMessage, code)
          else res.write(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { code, message: errorMessage } } })}\n\n`)
          res.end()
        }
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      this.controllers.delete(controller)
      if (converter && !usageKnown) usage = converter.currentUsage
      if (logged && provider) this.store.addLog({ id: randomUUID(), at: new Date().toISOString(), provider: provider.name, model, path: new URL(req.url ?? '/', 'http://127.0.0.1').pathname, status, latency: Math.round(performance.now() - began), inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, upstreamOutcome, usageKnown, ...(upstreamHttpStatus !== undefined ? { upstreamHttpStatus } : {}), ...(upstreamRequestId ? { upstreamRequestId } : {}), ...(failureStage ? { failureStage } : {}), ...(errorCode ? { errorCode } : {}), ...(note ? { note } : {}), ...(errorMessage ? { error: errorMessage } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) })
    }
  }
}
export async function testConnection(provider: Provider, key: string) {
  const began = performance.now()
  try {
    const native = provider.protocol === 'responses'
    const body = native ? {
      model: provider.defaultModel, input: 'Call fleet_ping with ok=true to verify tools.', max_output_tokens: 256,
      tools: [{ type: 'function', name: 'fleet_ping', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }]
    } : {
      model: provider.defaultModel, messages: [{ role: 'user', content: 'Call fleet_ping with ok=true to verify tools.' }], max_tokens: 256,
      tools: [{ type: 'function', function: { name: 'fleet_ping', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } }],
    }
    const profile = reasoningProfile(provider, provider.defaultModel)
    // Tool probes may disable optional thinking to stay short. Required-thinking
    // models must use a valid level instead of an invalid disabled toggle.
    const canDisable = profile.thinkingMode === 'toggle' && (profile.thinkingControl !== 'none' || profile.reasoningEfforts.includes('none'))
    const probe = canDisable ? 'none' : profile.reasoningEfforts.find(effort => effort !== 'none')
    applyReasoning(probe ? { reasoning: { effort: probe } } : {}, body, { ...provider, thinking: 'auto' }, provider.defaultModel, native)
    const response = await fetch(`${provider.baseUrl}/${native ? 'responses' : 'chat/completions'}`, { method: 'POST', headers: upstreamHeaders(key), body: JSON.stringify(body), signal: AbortSignal.timeout(45000) })
    if (!response.ok) throw await upstreamError(response, key)
    const result = await response.json() as Json
    const calls = native ? result.output?.some((item: Json) => item.type === 'function_call' && item.name === 'fleet_ping') : result.choices?.[0]?.message?.tool_calls?.some((call: Json) => call.function?.name === 'fleet_ping')
    if (result.error || (!native && !result.choices?.length) || (native && !Array.isArray(result.output))) throw new Error(result.error?.message ?? '响应格式与所选协议不符。')
    return { ok: true, message: calls ? '模型连接正常，工具调用验证通过。' : '模型连接正常；本次未返回工具调用，请确认模型支持 Function Calling。', latency: Math.round(performance.now() - began) }
  } catch (error) { return { ok: false, message: safeError(error, [key]), latency: Math.round(performance.now() - began) } }
}
export async function discoverModelDetails(baseUrl: string, key: string, timeout = 20000): Promise<DiscoveredModel[]> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, { headers: upstreamHeaders(key), signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw await upstreamError(response, key)
  const result = await response.json() as Json
  const candidates = result.data ?? result.models
  if (!Array.isArray(candidates)) throw new Error('该接口未返回模型列表，请手动填写模型 ID。')
  const models = new Map<string, DiscoveredModel>()
  for (const model of candidates) {
    const id = model?.id ?? model?.slug
    if (typeof id !== 'string' || !id.trim()) continue
    const modalities = model.input_modalities ?? model.architecture?.input_modalities
    const levels = model.effort?.supported_levels ?? model.supported_reasoning_levels ?? model.supported_reasoning_efforts
    models.set(id.trim(), { id: id.trim(), ...sanitizeCapabilities({
      contextWindow: model.context_window ?? model.context_length,
      vision: Array.isArray(modalities) ? modalities.includes('image') : undefined,
      reasoningEfforts: Array.isArray(levels) ? levels.map(level => typeof level === 'string' ? level : level?.effort) : undefined,
      defaultReasoningEffort: model.effort?.default_level ?? model.default_reasoning_level ?? model.default_reasoning_effort,
      thinkingMode: model.thinking_mode,
      thinkingControl: model.thinking_control
    }) })
    if (models.size >= 500) break
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id))
}
export async function discoverModels(baseUrl: string, key: string) { return (await discoverModelDetails(baseUrl, key)).map(model => model.id) }
