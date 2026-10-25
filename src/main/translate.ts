import { createHash, randomUUID } from 'node:crypto'
import type { Provider } from '../shared/types'
import { modelCapabilities } from '../shared/model-capabilities'
import { applyReasoning } from './reasoning'
export type Json = Record<string, any>
interface ToolSpec { name: string; namespace?: string; kind: 'function' | 'custom' | 'tool_search' }
const uid = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '')}`
const asString = (value: any): string => typeof value === 'string' ? value : JSON.stringify(value ?? '')
const toolName = (name: string) => {
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return clean === name && name.length <= 64 ? name : `${clean.slice(0, 48)}_${createHash('sha256').update(name).digest('hex').slice(0, 12)}`
}
export class ToolContext {
  specs = new Map<string, ToolSpec>()
  tools: Json[] = []
  constructor(request: Json) {
    const add = (tool: Json, namespace?: string) => {
      if (typeof tool === 'string') tool = { type: 'custom', name: tool }
      if (!tool || typeof tool !== 'object') return
      if (tool.type === 'namespace') {
        for (const child of tool.tools ?? tool.children ?? []) add(child, namespace ? `${namespace}.${tool.name}` : tool.name)
        return
      }
      if (!['function', 'custom', 'tool_search'].includes(tool.type)) return
      const original = tool.function ?? tool
      const name = tool.type === 'tool_search' ? 'tool_search' : original.name
      if (typeof name !== 'string' || !name.trim()) return
      const flat = toolName(namespace ? `${namespace}__${name}` : name)
      if (this.specs.has(flat)) return
      this.specs.set(flat, { name, namespace, kind: tool.type })
      let parameters: Json = original.parameters && typeof original.parameters === 'object' ? structuredClone(original.parameters) : { type: 'object', properties: {} }
      parameters.type = 'object'
      let description = original.description ?? ''
      if (tool.type === 'custom') {
        description = `Original tool definition:\n${JSON.stringify(tool)}\nReturn the exact raw tool input as the input string, preserving all formatting.`
        parameters = { type: 'object', properties: { input: { type: 'string', description: 'The exact raw input for this tool.' } }, required: ['input'] }
      } else if (tool.type === 'tool_search') {
        description = 'Search and load client tools, plugins, connectors, and MCP namespaces.'
        parameters = { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] }
      }
      this.tools.push({ type: 'function', function: { name: flat, description, parameters } })
    }
    for (const tool of request.tools ?? []) add(tool)
    const walk = (input: any) => {
      if (Array.isArray(input)) { input.forEach(walk); return }
      if (input?.type === 'additional_tools') for (const tool of input.tools ?? []) add(tool)
      if (input?.type === 'tool_search_output') walk(input.tools ?? input.output)
    }
    walk(request.input)
  }
  chatName(name: string, namespace?: string) { return toolName(namespace ? `${namespace}__${name}` : name) }
  output(call: Json, reasoning?: string): Json {
    const spec = this.specs.get(call.name)
    const base = { id: call.id, status: 'completed', call_id: call.callId, ...(reasoning ? { reasoning_content: reasoning } : {}) }
    if (spec?.kind === 'custom') {
      let input = call.arguments
      try { const parsed = JSON.parse(call.arguments); if (typeof parsed.input === 'string') input = parsed.input } catch { /* preserve raw input */ }
      return { ...base, type: 'custom_tool_call', name: spec.name, input }
    }
    if (spec?.kind === 'tool_search') {
      let args: Json
      try { args = JSON.parse(call.arguments) } catch { args = { query: call.arguments } }
      return { ...base, type: 'tool_search_call', execution: 'client', arguments: args }
    }
    return { ...base, type: 'function_call', name: spec?.name ?? call.name, arguments: call.arguments, ...(spec?.namespace ? { namespace: spec.namespace } : {}) }
  }
}
function contentToChat(content: any): any {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return asString(content)
  return content.flatMap((part: Json) => {
    if (['input_text', 'output_text', 'text'].includes(part.type)) return [{ type: 'text', text: part.text ?? '' }]
    if (part.type === 'input_image') return [{ type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } }]
    if (part.type === 'image_url') return [part]
    if (part.type === 'input_file') return [{ type: 'file', file: { file_data: part.file_data, file_id: part.file_id, filename: part.filename } }]
    return []
  })
}
export function toChat(request: Json, provider: Provider, model: string) {
  const context = new ToolContext(request)
  const messages: Json[] = []
  const systems: string[] = []
  if (request.instructions) systems.push(typeof request.instructions === 'string' ? request.instructions : asString(request.instructions))
  let pending: Json[] = []
  let pendingReasoning = ''
  const flush = () => {
    if (!pending.length) return
    const previous = messages.at(-1)
    if (previous?.role === 'assistant' && !previous.tool_calls) {
      previous.tool_calls = pending
      previous.reasoning_content = pendingReasoning || previous.reasoning_content || 'tool call'
    } else messages.push({ role: 'assistant', content: null, tool_calls: pending, reasoning_content: pendingReasoning || 'tool call' })
    pending = []; pendingReasoning = ''
  }
  const input = typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : Array.isArray(request.input) ? request.input : request.input ? [request.input] : []
  let reasoning = ''
  for (const item of input) {
    if (item.type === 'reasoning') {
      reasoning = (item.summary ?? []).map((part: Json) => part.text ?? '').join('') || item.reasoning_content || ''
    } else if (['function_call', 'custom_tool_call', 'tool_search_call'].includes(item.type)) {
      const name = item.type === 'tool_search_call' ? 'tool_search' : context.chatName(item.name, item.namespace)
      pending.push({ id: item.call_id ?? item.id, type: 'function', function: { name,
        arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input ?? '' }) : asString(item.arguments ?? '{}') } })
      pendingReasoning = item.reasoning_content || reasoning || pendingReasoning
    } else if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(item.type)) {
      flush()
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: asString(item.output ?? item.tools ?? '') })
    } else if (item.type === 'message' || item.role) {
      const role = item.role === 'developer' ? 'system' : item.role
      if (role === 'system') {
        const content = contentToChat(item.content)
        systems.push(typeof content === 'string' ? content : content.map((p: Json) => p.text ?? '').join('\n'))
      } else {
        flush()
        const content = contentToChat(item.content)
        messages.push({ role, content, ...(role === 'assistant' && reasoning ? { reasoning_content: reasoning } : {}) })
        reasoning = ''
      }
    } else if (!['additional_tools', 'compaction', 'compaction_trigger'].includes(item.type)) {
      throw new Error(`暂不支持的 Responses 输入类型：${item.type ?? 'unknown'}`)
    }
  }
  flush()
  if (systems.length) messages.unshift({ role: 'system', content: systems.join('\n\n') })
  // DeepSeek requires all tool outputs to follow their corresponding assistant call.
  const repaired: Json[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === 'tool') {
      const callIndex = repaired.findLastIndex(m => m.role === 'assistant' && m.tool_calls?.some((t: Json) => t.id === message.tool_call_id))
      if (callIndex < 0) throw new Error('工具结果缺少对应的工具调用，请新建对话后重试。')
      let after = callIndex + 1
      while (repaired[after]?.role === 'tool') after++
      repaired.splice(after, 0, message)
    } else repaired.push(message)
  }
  if (!modelCapabilities(provider, model).vision && repaired.some(m => Array.isArray(m.content) && m.content.some((p: Json) => p.type === 'image_url'))) throw new Error('当前模型未声明支持图片输入，请从接口刷新模型信息，或切换到支持图片的模型。')
  const body: Json = { model, messages: repaired, stream: request.stream === true }
  if (body.stream) body.stream_options = { include_usage: true }
  if (context.tools.length) {
    body.tools = context.tools
    if (request.parallel_tool_calls !== undefined) body.parallel_tool_calls = request.parallel_tool_calls
    if (request.tool_choice) {
      body.tool_choice = typeof request.tool_choice === 'string' ? request.tool_choice : { type: 'function', function: { name: context.chatName(request.tool_choice.name ?? request.tool_choice.function?.name, request.tool_choice.namespace) } }
    }
  }
  if (request.max_output_tokens) body.max_tokens = request.max_output_tokens
  for (const key of ['temperature', 'top_p']) if (request[key] !== undefined) body[key] = request[key]
  applyReasoning(request, body, provider, model)
  if (request.text?.format?.type === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: request.text.format.name ?? 'output', schema: request.text.format.schema, strict: request.text.format.strict } }
  else if (request.text?.format?.type === 'json_object') body.response_format = { type: 'json_object' }
  return { body, context }
}
export function responseUsage(usage: Json = {}) {
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0
  return { input_tokens: input, output_tokens: output, total_tokens: usage.total_tokens ?? input + output,
    input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 } }
}
export function responseShell(id: string, model: string, request: Json, output: Json[], usage: Json = {}, status = 'completed') {
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status,
    error: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    model, output, usage: responseUsage(usage), parallel_tool_calls: request.parallel_tool_calls ?? true,
    tool_choice: request.tool_choice ?? 'auto', tools: request.tools ?? [], metadata: request.metadata ?? {},
    temperature: request.temperature ?? null, top_p: request.top_p ?? null, max_output_tokens: request.max_output_tokens ?? null,
    previous_response_id: request.previous_response_id ?? null, store: false, instructions: request.instructions ?? null,
    reasoning: request.reasoning ?? null, text: request.text ?? { format: { type: 'text' } }, truncation: 'disabled' }
}
export function fromChat(chat: Json, request: Json, context: ToolContext) {
  const choice = chat.choices?.[0]
  if (!choice) throw new Error('上游响应缺少 choices，无法转换。')
  const message = choice.message ?? {}
  const output: Json[] = []
  const reasoning = message.reasoning_content ?? message.reasoning ?? ''
  if (reasoning) output.push({ id: uid('rs'), type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }], reasoning_content: reasoning })
  if (message.content) output.push({ id: uid('msg'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: asString(message.content), annotations: [], logprobs: [] }] })
  for (const call of message.tool_calls ?? []) {
    if (!call.function?.name) throw new Error('上游返回了缺少名称的工具调用。')
    output.push(context.output({ id: uid('fc'), callId: call.id ?? uid('call'), name: call.function.name, arguments: call.function.arguments ?? '{}' }, reasoning))
  }
  return responseShell(uid('resp'), request.model, request, output, chat.usage, choice.finish_reason === 'length' ? 'incomplete' : 'completed')
}

/** SSE parser tolerates split UTF-8, CRLF, comments and multi-line data fields. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const parseBlock = (block: string) => {
    let event: string | undefined
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    return data.length ? { event, data: data.join('\n') } : null
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let separator: RegExpExecArray | null
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const parsed = parseBlock(block)
        if (parsed) yield parsed
      }
      if (buffer.length > 8 * 1024 * 1024) throw new Error('上游流式事件超过大小限制。')
      if (done) { if (buffer.trim()) { const parsed = parseBlock(buffer); if (parsed) yield parsed }; break }
    }
  } finally { try { await reader.cancel() } catch { /* closed */ }; reader.releaseLock() }
}

export class ChatStream {
  readonly id = uid('resp')
  private sequence = 0
  private text = ''
  private reasoning = ''
  private textIndex = -1
  private reasoningIndex = -1
  private nextIndex = 0
  private textId = uid('msg')
  private reasoningId = uid('rs')
  private calls = new Map<number, Json>()
  private output = new Map<number, Json>()
  private usage: Json = {}
  private finishReason: string | null = null
  private finished = false
  get upstreamFinished() { return this.finishReason !== null }
  get currentUsage() { return responseUsage(this.usage) }
  constructor(private request: Json, private context: ToolContext, private write: (data: string) => void) {}
  emit(type: string, data: Json) { this.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...data })}\n\n`) }
  start() {
    const response = responseShell(this.id, this.request.model, this.request, [], {}, 'in_progress')
    this.emit('response.created', { response }); this.emit('response.in_progress', { response })
  }
  chunk(chunk: Json) {
    if (chunk.error) throw new Error(chunk.error.message ?? '上游返回流式错误。')
    if (chunk.usage) this.usage = chunk.usage
    const choice = chunk.choices?.[0]
    if (!choice) return
    const delta = choice.delta ?? {}
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (reasoning) {
      if (this.reasoningIndex < 0) {
        this.reasoningIndex = this.nextIndex++
        this.emit('response.output_item.added', { output_index: this.reasoningIndex, item: { id: this.reasoningId, type: 'reasoning', summary: [] } })
        this.emit('response.reasoning_summary_part.added', { item_id: this.reasoningId, output_index: this.reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: '' } })
      }
      this.reasoning += reasoning
      this.emit('response.reasoning_summary_text.delta', { item_id: this.reasoningId, output_index: this.reasoningIndex, summary_index: 0, delta: reasoning })
    }
    if (delta.content) {
      if (this.textIndex < 0) {
        this.textIndex = this.nextIndex++
        this.emit('response.output_item.added', { output_index: this.textIndex, item: { id: this.textId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
        this.emit('response.content_part.added', { item_id: this.textId, output_index: this.textIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      }
      this.text += delta.content
      this.emit('response.output_text.delta', { item_id: this.textId, output_index: this.textIndex, content_index: 0, delta: delta.content, logprobs: [] })
    }
    for (const tc of delta.tool_calls ?? []) {
      const index = tc.index ?? 0
      let call = this.calls.get(index)
      if (!call) { call = { id: uid('fc'), callId: '', name: '', arguments: '', outputIndex: this.nextIndex++ }; this.calls.set(index, call) }
      if (tc.id) call.callId = tc.id
      if (tc.function?.name) call.name += tc.function.name
      if (tc.function?.arguments) call.arguments += tc.function.arguments
      // Tool identities and custom-tool JSON wrappers can arrive in fragments.
      // Buffer the tool until complete so no malformed name/input reaches Codex.
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason
  }
  complete() {
    if (this.finished) throw new Error('流式响应已结束。')
    if (!this.finishReason) throw new Error('上游连接提前关闭，未收到完成标记。')
    if (this.reasoningIndex >= 0) {
      const part = { type: 'summary_text', text: this.reasoning }
      const fields = { item_id: this.reasoningId, output_index: this.reasoningIndex, summary_index: 0 }
      this.emit('response.reasoning_summary_text.done', { ...fields, text: this.reasoning })
      this.emit('response.reasoning_summary_part.done', { ...fields, part })
      const item = { id: this.reasoningId, type: 'reasoning', summary: [part], reasoning_content: this.reasoning }
      this.output.set(this.reasoningIndex, item)
      this.emit('response.output_item.done', { output_index: this.reasoningIndex, item })
    }
    if (this.textIndex >= 0) {
      const fields = { item_id: this.textId, output_index: this.textIndex, content_index: 0 }
      const part = { type: 'output_text', text: this.text, annotations: [], logprobs: [] }
      this.emit('response.output_text.done', { ...fields, text: this.text, logprobs: [] })
      this.emit('response.content_part.done', { ...fields, part })
      const item = { id: this.textId, type: 'message', role: 'assistant', status: 'completed', content: [part] }
      this.output.set(this.textIndex, item)
      this.emit('response.output_item.done', { output_index: this.textIndex, item })
    }
    for (const [, call] of [...this.calls].sort(([a], [b]) => a - b)) {
      if (!call.name.trim()) throw new Error('上游工具调用缺少名称。')
      call.callId ||= uid('call')
      const item = this.context.output(call, this.reasoning)
      const start: Json = { ...item, status: 'in_progress' }
      if (item.type === 'function_call') start.arguments = ''
      if (item.type === 'custom_tool_call') start.input = ''
      this.emit('response.output_item.added', { output_index: call.outputIndex, item: start })
      const fields = { item_id: item.id, output_index: call.outputIndex }
      if (item.type === 'function_call') {
        this.emit('response.function_call_arguments.delta', { ...fields, delta: item.arguments })
        this.emit('response.function_call_arguments.done', { ...fields, name: item.name, arguments: item.arguments })
      } else if (item.type === 'custom_tool_call') {
        this.emit('response.custom_tool_call_input.delta', { ...fields, delta: item.input })
        this.emit('response.custom_tool_call_input.done', { ...fields, input: item.input })
      }
      this.output.set(call.outputIndex, item)
      this.emit('response.output_item.done', { output_index: call.outputIndex, item })
    }
    const output = [...this.output].sort(([a], [b]) => a - b).map(([, item]) => item)
    const response = responseShell(this.id, this.request.model, this.request, output, this.usage, this.finishReason === 'length' ? 'incomplete' : 'completed')
    this.emit(response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response })
    this.finished = true
    return response
  }
  fail(message: string, code = 'fleet_bridge_error') {
    if (this.finished) return
    const response = { ...responseShell(this.id, this.request.model, this.request, [], this.usage, 'failed'), error: { code, message } }
    this.emit('response.failed', { response }); this.finished = true
  }
}
