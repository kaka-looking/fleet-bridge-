import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { Runtime } from '../src/main/runtime'
import { PRESETS } from '../src/shared/presets'
import { modelSlug } from '../src/main/catalog'
import { formatLogsCsv } from '../src/main/log-export'
import { knownUsage, requestStatusLabel, upstreamOutcomeLabel } from '../src/shared/request-log'
import type { RequestLog } from '../src/shared/types'

const temp = () => mkdtempSync(join(tmpdir(), 'fleet-request-logs-'))
const cipher = { label: 'test', encrypt: (value: string) => value, decrypt: (value: string) => value }
const packet = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
const nativePacket = (type: string, response: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`
const completed = (status = 'completed') => ({ id: 'resp-test', object: 'response', status, output: [], usage: { input_tokens: 7, output_tokens: 3 }, ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) })

describe('actual upstream results versus local request outcomes', () => {
  let upstream: Server
  let runtime: Runtime
  let baseUrl: string
  let timedController: AbortController | undefined
  const sent: string[] = []
  beforeAll(async () => {
    upstream = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw); const model: string = body.model; sent.push(model)
      response.setHeader('x-request-id', 'upstream-test-id')
      response.setHeader('Content-Type', body.stream ? 'text/event-stream' : 'application/json')
      const closeLater = () => { const timer = setTimeout(() => response.destroy(), 25); timer.unref() }
      if (model === 'drop-before-headers') { request.socket.destroy(); return }
      if (model === 'timeout') { timedController?.abort(new DOMException('test deadline', 'TimeoutError')); return }
      if (model === 'http-failure') { response.statusCode = 429; response.end(JSON.stringify({ error: { message: 'rate limit secret-fixture-key' } })); return }
      if (model === 'json-failure') { response.end(JSON.stringify({ error: { message: 'model rejected request' } })); return }
      if (model === 'convert-failure') { response.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { arguments: '{}' } }] } }], usage: { prompt_tokens: 9, completion_tokens: 2 } })); return }
      if (model === 'native-invalid') { response.end(JSON.stringify({ wrong: true })); return }
      if (model === 'native-failed-json') { response.end(JSON.stringify({ ...completed('failed'), error: null })); return }
      if (model === 'native-completed-open') { response.write(nativePacket('response.completed', completed())); return }
      if (model === 'native-incomplete') { response.end(nativePacket('response.incomplete', completed('incomplete'))); return }
      if (model === 'native-failed') { response.end(nativePacket('response.failed', { ...completed('failed'), error: { message: 'upstream generation failed' } })); return }
      if (model === 'native-cutoff') { response.write(nativePacket('response.in_progress', { id: 'partial' })); closeLater(); return }
      if (model === 'chat-usage-error') {
        response.write(packet({ choices: [{ delta: { content: 'partial' } }] }))
        response.end(packet({ error: { message: 'explicit model failure' }, usage: { prompt_tokens: 13, completion_tokens: 4 } }))
        return
      }
      if (model === 'chat-tail-reset' || model === 'chat-length') {
        response.write(packet({ choices: [{ delta: { content: 'complete' }, finish_reason: model === 'chat-length' ? 'length' : 'stop' }] }))
        response.write(packet({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 5 } }))
        if (model === 'chat-length') response.end('data: [DONE]\n\n')
        else closeLater()
        return
      }
      if (model === 'chat-cutoff' || model === 'client-cancel') {
        response.write(packet({ choices: [{ delta: { content: 'partial' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }))
        if (model === 'chat-cutoff') closeLater()
        return
      }
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }))
    })
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
    baseUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1`
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
    const port = (probe.address() as any).port; await new Promise<void>(resolve => probe.close(() => resolve()))
    const store = new Store(temp(), cipher); store.setSettings({ ...store.settings, autoStart: false, port })
    store.save({ ...PRESETS.custom, name: 'Fixture', baseUrl, apiKey: 'secret-fixture-key', models: ['drop-before-headers', 'http-failure', 'json-failure', 'convert-failure', 'chat-tail-reset', 'chat-length', 'chat-cutoff', 'chat-usage-error', 'client-cancel', 'timeout', 'prepare-failure'], defaultModel: 'drop-before-headers' })
    store.save({ ...PRESETS.custom, name: 'Native', baseUrl, protocol: 'responses', models: ['native-invalid', 'native-failed-json', 'native-completed-open', 'native-incomplete', 'native-failed', 'native-cutoff'], defaultModel: 'native-completed-open' })
    runtime = new Runtime(store, temp()); await runtime.gateway.start()
  })
  afterAll(async () => {
    vi.restoreAllMocks()
    await runtime?.gateway.stop()
    if (upstream) await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections() })
  })
  const request = (model: string, stream = false, signal?: AbortSignal, input: any = 'test') => {
    const provider = runtime.store.providers.find(provider => provider.models.includes(model))!
    return fetch(`${runtime.gateway.url}/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtime.store.token}` }, body: JSON.stringify({ model: modelSlug(provider, model), input, stream }), signal })
  }
  const log = async (model: string) => {
    await vi.waitFor(() => expect(runtime.store.logs.some(log => log.model === model)).toBe(true))
    return runtime.store.logs.find(log => log.model === model)!
  }

  it('records a network reset before headers as unknown/interrupted, without inventing an upstream failure or zero usage', async () => {
    const response = await request('drop-before-headers'); expect(response.status).toBe(502); await response.text()
    const entry = await log('drop-before-headers')
    expect(entry).toMatchObject({ status: 'interrupted', upstreamOutcome: 'unknown', failureStage: 'connect', usageKnown: false })
    expect(entry.upstreamHttpStatus).toBeUndefined()
    expect(entry.errorCode).toBeTruthy()
    expect(entry.error).toContain('尚未确认')
    expect(knownUsage(entry)).toBe(false)
    expect(upstreamOutcomeLabel(entry)).not.toContain('返回失败')
  })
  it('records an actual HTTP rejection and its correlation ID, with secrets redacted', async () => {
    const response = await request('http-failure'); expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('secret-fixture-key')
    const entry = await log('http-failure')
    expect(entry).toMatchObject({ status: 'error', upstreamOutcome: 'failed', upstreamHttpStatus: 429, upstreamRequestId: 'upstream-test-id' })
    expect(requestStatusLabel(entry)).toBe('上游失败')
    expect(JSON.stringify(entry)).not.toContain('secret-fixture-key')
  })
  it('recognizes an error response inside HTTP 200 without hiding it behind a choices conversion error', async () => {
    const response = await request('json-failure'); expect(response.status).toBe(502); expect(await response.text()).toContain('model rejected request')
    expect(await log('json-failure')).toMatchObject({ status: 'error', upstreamOutcome: 'failed', upstreamHttpStatus: 200 })
  })
  it('retains a successful upstream outcome when local tool conversion fails', async () => {
    const response = await request('convert-failure'); expect(response.status).toBe(502); await response.text()
    const entry = await log('convert-failure')
    expect(entry).toMatchObject({ status: 'error', failureStage: 'convert', upstreamOutcome: 'completed', upstreamHttpStatus: 200, inputTokens: 9, outputTokens: 2, usageKnown: true })
    expect(requestStatusLabel(entry)).toBe('处理异常')
  })
  it('does not turn an already finished Chat response into a failure when its trailing connection resets', async () => {
    const response = await request('chat-tail-reset', true); const events = await response.text()
    expect(events).toContain('response.completed'); expect(events).not.toContain('response.failed')
    expect(await log('chat-tail-reset')).toMatchObject({ status: 'ok', upstreamOutcome: 'completed', upstreamHttpStatus: 200, inputTokens: 11, outputTokens: 5, usageKnown: true })
  })
  it('finishes native SSE at its terminal event even when the upstream leaves the connection open', async () => {
    const response = await request('native-completed-open', true); expect(await response.text()).toContain('response.completed')
    expect(await log('native-completed-open')).toMatchObject({ status: 'ok', upstreamOutcome: 'completed', inputTokens: 7, outputTokens: 3 })
  }, 2000)
  it.each(['chat-length', 'native-incomplete'])('records %s as incomplete output rather than an API failure', async model => {
    const response = await request(model, true); expect(await response.text()).toContain('response.incomplete')
    const entry = await log(model)
    expect(entry).toMatchObject({ status: 'incomplete', upstreamOutcome: 'completed', upstreamHttpStatus: 200 })
    expect(requestStatusLabel(entry)).toBe('输出未完成')
  })
  it.each(['chat-cutoff', 'native-cutoff'])('records %s as incomplete transport without claiming model generation failed', async model => {
    const response = await request(model, true); expect(await response.text()).toContain('connection_interrupted')
    const entry = await log(model)
    expect(entry).toMatchObject({ status: 'interrupted', upstreamOutcome: 'unknown', upstreamHttpStatus: 200 })
    if (model === 'chat-cutoff') expect(entry).toMatchObject({ inputTokens: 5, outputTokens: 2, usageKnown: true })
  })
  it('preserves the explicit failed native event and any received usage', async () => {
    const response = await request('native-failed', true); expect(await response.text()).toContain('upstream generation failed')
    expect(await log('native-failed')).toMatchObject({ status: 'error', upstreamOutcome: 'failed', upstreamHttpStatus: 200, inputTokens: 7, outputTokens: 3 })
  })
  it('retains usage attached to a Chat error chunk', async () => {
    const response = await request('chat-usage-error', true); expect(await response.text()).toContain('explicit model failure')
    expect(await log('chat-usage-error')).toMatchObject({ status: 'error', upstreamOutcome: 'failed', inputTokens: 13, outputTokens: 4, usageKnown: true })
  })
  it('does not call malformed native JSON or a failed native status successful', async () => {
    for (const model of ['native-invalid', 'native-failed-json']) {
      const response = await request(model); expect(response.status).toBe(502); await response.text()
    }
    expect(await log('native-invalid')).toMatchObject({ status: 'error', failureStage: 'convert', upstreamOutcome: 'unknown' })
    expect(await log('native-failed-json')).toMatchObject({ status: 'error', upstreamOutcome: 'failed' })
  })
  it('distinguishes a client cancellation from an upstream failure and preserves received tokens', async () => {
    const controller = new AbortController()
    const response = await request('client-cancel', true, controller.signal)
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = ''
    while (!text.includes('response.output_text.delta')) text += decoder.decode((await reader.read()).value)
    controller.abort(); await reader.cancel().catch(() => {})
    expect(await log('client-cancel')).toMatchObject({ status: 'cancelled', upstreamOutcome: 'unknown', upstreamHttpStatus: 200, inputTokens: 5, outputTokens: 2 })
  })
  it('records a timeout separately and leaves the upstream outcome unknown', async () => {
    timedController = new AbortController()
    const stub = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timedController.signal)
    try {
      const response = await request('timeout'); expect(response.status).toBe(502); await response.text()
      expect(await log('timeout')).toMatchObject({ status: 'timeout', upstreamOutcome: 'unknown' })
    } finally { stub.mockRestore(); timedController = undefined }
  })
  it('records preflight conversion failures as not sent, with no upstream request', async () => {
    const before = sent.length
    const response = await request('prepare-failure', false, undefined, [{ type: 'unsupported' }])
    expect(response.status).toBe(502); await response.text()
    expect(sent.length).toBe(before)
    expect(await log('prepare-failure')).toMatchObject({ status: 'error', upstreamOutcome: 'not_sent', failureStage: 'prepare' })
  })
})

describe('historical records and export', () => {
  const old: RequestLog = { id: 'old', at: '2026-10-25T08:00:00Z', provider: '=formula', model: 'test', status: 'error', error: 'fetch failed', inputTokens: 0, outputTokens: 0, latency: 100 }
  it('reclassifies old network errors on read without fabricating HTTP evidence or rewriting history', () => {
    const store = new Store(temp(), cipher); store.addLog(old)
    const file = join(store.directory, 'state.json'); const before = readFileSync(file, 'utf8')
    const entry = store.logs[0]
    expect(entry).toMatchObject({ status: 'interrupted', legacyRecord: true })
    expect(entry.upstreamHttpStatus).toBeUndefined()
    expect(upstreamOutcomeLabel(entry)).toContain('无法确认')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
  it('exports unknown upstream status and unknown usage honestly while preserving CSV escaping', () => {
    const csv = formatLogsCsv([old])
    expect(csv).toContain('连接中断')
    expect(csv).toContain('旧记录未保存上游状态')
    expect(csv).toContain(`"'=formula"`)
    expect(csv).not.toContain('上游明确返回失败')
  })
})
