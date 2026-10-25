import type { ModelCapabilities, Provider, ReasoningEffort } from './types'

export const REASONING_EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export const isReasoningEffort = (value: unknown): value is ReasoningEffort => REASONING_EFFORTS.includes(value as ReasoningEffort)
export const isDeepSeekModel = (provider: Pick<Provider, 'kind'>, model: string) => provider.kind === 'deepseek' || /(?:^|[/:])deepseek[-/]/i.test(model)
export const highestEffort = (levels: ReasoningEffort[]) => REASONING_EFFORTS.filter(effort => levels.includes(effort)).at(-1)
export function mergeCapabilities(previous: ModelCapabilities = {}, incoming: ModelCapabilities): ModelCapabilities {
  const merged = { ...previous, ...incoming }
  if (previous.reasoningOverride) {
    for (const key of ['reasoningEfforts', 'defaultReasoningEffort', 'thinkingMode', 'thinkingControl', 'reasoningOverride'] as const) {
      if (Object.hasOwn(previous, key)) Object.assign(merged, { [key]: previous[key] })
      else delete merged[key]
    }
  }
  return merged
}

export function sanitizeCapabilities(value: ModelCapabilities): ModelCapabilities {
  const result: ModelCapabilities = {}
  if (Number.isInteger(value.contextWindow) && value.contextWindow! >= 4096 && value.contextWindow! <= 10000000) result.contextWindow = value.contextWindow
  if (typeof value.vision === 'boolean') result.vision = value.vision
  if (Array.isArray(value.reasoningEfforts)) result.reasoningEfforts = REASONING_EFFORTS.filter(effort => value.reasoningEfforts!.includes(effort))
  if (isReasoningEffort(value.defaultReasoningEffort) && result.reasoningEfforts?.includes(value.defaultReasoningEffort)) result.defaultReasoningEffort = value.defaultReasoningEffort
  if (['thinking', 'enable_thinking', 'none'].includes(value.thinkingControl!)) result.thinkingControl = value.thinkingControl
  if (['toggle', 'always', 'none'].includes(value.thinkingMode!)) result.thinkingMode = value.thinkingMode
  if (value.reasoningOverride === true) result.reasoningOverride = true
  return result
}

type CapabilityProvider = Pick<Provider, 'kind' | 'contextWindow' | 'vision' | 'thinking' | 'modelCapabilities'>

export function reasoningProfile(provider: CapabilityProvider, model: string) {
  const name = model.toLowerCase().split(/[/:]/).at(-1) ?? ''
  const known: ModelCapabilities = {}
  if (/^deepseek-(?:chat|reasoner)$/.test(name)) {
    known.contextWindow = 128000
    known.vision = false
    known.thinkingMode = name.endsWith('reasoner') ? 'always' : 'none'
    known.thinkingControl = 'none'
  }
  // Versioned DeepSeek V4 models and Flash aliases share the documented effort API.
  // Legacy V3 aliases need upstream metadata before advertising effort controls.
  if (/^deepseek-(?:flash|v4)/.test(name)) {
    known.contextWindow = 1048576
    known.vision = /flash/.test(name) && !/pro/.test(name)
    known.reasoningEfforts = ['low', 'high', 'max']
    known.defaultReasoningEffort = 'high'
    known.thinkingMode = 'toggle'
    known.thinkingControl = 'thinking'
  }
  if (/^glm-(?:4\.[567]|5(?:[.-]|$))/.test(name)) {
    Object.assign(known, { thinkingMode: 'toggle', thinkingControl: 'thinking' })
    if (/^glm-5\.3(?:[-.]|$)/.test(name)) {
      Object.assign(known, { reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max', thinkingMode: 'always' })
    } else if (/^glm-5\.2(?:[-.]|$)/.test(name)) {
      Object.assign(known, { reasoningEfforts: ['high', 'max'], defaultReasoningEffort: 'max' })
    }
  }
  if (/^kimi-k2\.[56](?:[-.]|$)/.test(name)) {
    Object.assign(known, { contextWindow: 262144, vision: true, thinkingMode: 'toggle', thinkingControl: 'thinking' })
  } else if (/^kimi-k2(?:-thinking|\.7-code)(?:-|$)/.test(name)) {
    Object.assign(known, { thinkingMode: 'always', thinkingControl: 'none' })
  } else if (/^kimi-k3(?:[.-]|$)/.test(name)) {
    Object.assign(known, { reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max', thinkingMode: 'always', thinkingControl: 'none' })
  }
  if (/^qwen(?:3|-(?:plus|max|flash))/.test(name) && !/omni/.test(name)) {
    Object.assign(known, { thinkingMode: 'toggle', thinkingControl: 'enable_thinking' })
    if (/coder|instruct/.test(name)) Object.assign(known, { thinkingMode: 'none', thinkingControl: 'none' })
    else if (/thinking/.test(name)) Object.assign(known, { thinkingMode: 'always', thinkingControl: 'none' })
  }
  if (/^minimax-m2(?:[.-]|$)/.test(name)) {
    Object.assign(known, { thinkingMode: 'always', thinkingControl: 'none' })
  } else if (/^minimax-m3\.1-flash(?:-|$)/.test(name)) {
    Object.assign(known, { reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'max', thinkingMode: 'always', thinkingControl: 'none' })
  }
  const declared = sanitizeCapabilities(provider.modelCapabilities?.[model] ?? {})
  const profile = { ...known, ...declared }
  // An explicit relay declaration can extend the family fallback, including Ultra.
  const levels = profile.reasoningEfforts ?? []
  const thinkingMode = declared.thinkingMode ?? (declared.reasoningEfforts?.includes('none') ? 'toggle' : profile.thinkingMode) ?? (levels.length ? 'toggle' : undefined)
  const thinkingControl = profile.thinkingControl ?? (provider.kind === 'qwen' ? 'enable_thinking' : provider.kind === 'custom' ? 'none' : 'thinking')
  const toggleOnly = !levels.length && thinkingMode === 'toggle' && thinkingControl !== 'none'
  const reasoningEfforts = thinkingMode === 'none' ? [] : toggleOnly ? ['none', 'high'] as ReasoningEffort[] : levels.filter(effort => thinkingMode !== 'always' || effort !== 'none')
  const preferred = profile.defaultReasoningEffort
  const defaultReasoningEffort = preferred && reasoningEfforts.includes(preferred) ? preferred : highestEffort(reasoningEfforts) ?? 'none'
  return { contextWindow: profile.contextWindow ?? provider.contextWindow, vision: profile.vision ?? provider.vision, reasoningEfforts, defaultReasoningEffort, thinkingMode, thinkingControl, toggleOnly, declaredEfforts: declared.reasoningEfforts !== undefined }
}

export function modelCapabilities(provider: CapabilityProvider, model: string) {
  const profile = reasoningProfile(provider, model)
  let reasoningEfforts = provider.thinking === 'off' ? [] : profile.reasoningEfforts.filter(effort => !['on', 'max'].includes(provider.thinking) || effort !== 'none')
  if (provider.thinking === 'max') {
    const highest = highestEffort(reasoningEfforts)
    reasoningEfforts = highest ? [highest] : []
  }
  const preferred = provider.thinking === 'max' ? highestEffort(reasoningEfforts) : profile.defaultReasoningEffort
  const defaultReasoningEffort = preferred && reasoningEfforts.includes(preferred) ? preferred : reasoningEfforts[0] ?? 'none'
  return { contextWindow: profile.contextWindow, vision: profile.vision, reasoningEfforts, defaultReasoningEffort }
}

export function deepSeekEffort(effort: ReasoningEffort): ReasoningEffort {
  if (effort === 'minimal') return 'low'
  if (effort === 'medium' || effort === 'xhigh') return 'high'
  if (effort === 'ultra') return 'max'
  return effort
}
