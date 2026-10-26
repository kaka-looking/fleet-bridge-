import type { Provider } from '../shared/types'
import { modelCapabilities, reasoningProfile } from '../shared/model-capabilities'
export const DEFAULT_MODEL = 'fleet/default'
export function modelSlug(provider: Provider, model: string) { return `fleet/${provider.id}/${model}` }
export function modelLabel(model: string) {
  return model.replace(/^global:/i, '').replace(/^deepseek-/i, 'DeepSeek ').replace(/^glm-/i, 'GLM ').replace(/^kimi-/i, 'Kimi ')
}
export function buildCatalog(providers: Provider[], activeId: string | null, original?: { provider?: Provider; models: Record<string, any>[] }) {
  providers = providers.filter(provider => provider.enabled !== false)
  if (original?.provider?.enabled !== false && original?.provider) providers = [...providers, original.provider]
  const entries: { slug: string; model: string; provider: Provider; label: string }[] = []
  const active = providers.find(p => p.id === activeId) ?? providers[0]
  if (active) entries.push({ slug: DEFAULT_MODEL, model: active.defaultModel, provider: active, label: `默认航线 · ${active.name}` })
  for (const provider of providers) for (const model of new Set(provider.models.map(model => model.trim()).filter(Boolean))) entries.push({ slug: provider.id === 'codex-original' ? model : modelSlug(provider, model), model, provider, label: `${modelLabel(model)} · ${provider.name}` })
  return { models: entries.map(({ slug, model, provider, label }, priority) => {
    const capabilities = modelCapabilities(provider, model)
    const profile = reasoningProfile(provider, model)
    const entry = {
    slug, display_name: label, description: `${model} · 通过舰桥连接 ${provider.name}${provider.thinking === 'max' ? ' · 固定使用模型支持的最高强度' : ''}`,
    visibility: slug === DEFAULT_MODEL ? 'hide' : 'list', supported_in_api: true, priority,
    minimal_client_version: '0.0.0', shell_type: 'shell_command',
    availability_nux: null, upgrade: null,
    base_instructions: 'You are a coding agent. Work with the user to complete their tasks. Use the available tools to inspect files, make changes, and verify results. Follow the project instructions and preserve existing work.',
    model_messages: null, default_reasoning_level: capabilities.defaultReasoningEffort,
    supported_reasoning_levels: capabilities.reasoningEfforts.map(effort => ({ effort, description: profile.toggleOnly && effort !== 'none' ? '开启思考（此模型仅支持开关，不区分强度）' : ({ none: '关闭思考', minimal: '最少推理', low: '较少推理，响应更快', medium: '平衡推理与速度', high: '深入推理', xhigh: '更深入推理', max: '最大推理强度', ultra: '最高推理强度' })[effort] })), supports_reasoning_summaries: false,
    support_verbosity: false, default_verbosity: null,
    // A window alone also makes Codex derive a compaction threshold. Leave all
    // three unset so the upstream, not a bridge estimate, decides what fits.
    context_window: null, max_context_window: null,
    effective_context_window_percent: 100, auto_compact_token_limit: null,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    input_modalities: capabilities.vision ? ['text', 'image'] : ['text'],
    apply_patch_tool_type: 'freeform', supports_parallel_tool_calls: true,
    experimental_supported_tools: [], prefer_websockets: false,
    use_responses_lite: false, tool_mode: null, multi_agent_version: null,
    include_skills_usage_instructions: false, auto_review_model_override: null,
    reasoning_summary_format: 'none', default_reasoning_summary: 'none'
  }
    const inherited = provider.id === 'codex-original' ? original?.models.find(entry => entry.slug === model) : undefined
    return inherited ? { ...entry, ...inherited, slug, display_name: label, priority, visibility: slug === DEFAULT_MODEL ? 'hide' : 'list', supported_in_api: true, upgrade: null } : entry
  }) }
}
