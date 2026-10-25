import type { Provider, ReasoningEffort } from '../shared/types'
import { deepSeekEffort, highestEffort, isDeepSeekModel, isReasoningEffort, reasoningProfile, REASONING_EFFORTS } from '../shared/model-capabilities'

export function applyReasoning(request: Record<string, any>, body: Record<string, any>, provider: Provider, model: string, native = false) {
  const requested = request.reasoning?.effort ?? request.reasoning_effort
  if (requested !== undefined && !isReasoningEffort(requested)) throw new Error(`当前 Codex 不支持推理档位：${requested}`)
  const profile = reasoningProfile(provider, model)
  let effort: ReasoningEffort | undefined = requested
  if (provider.thinking === 'off') effort = 'none'
  else if (provider.thinking === 'max') {
    effort = highestEffort(profile.reasoningEfforts.filter(effort => effort !== 'none'))
    if (!effort && profile.thinkingMode !== 'always' && profile.thinkingMode !== 'none') throw new Error(`${model} 未声明推理能力，请先读取接口能力或在高级设置中配置推理档位。`)
    if (profile.thinkingMode === 'none') throw new Error(`${model} 不支持思考模式。`)
  } else if (provider.thinking === 'on' && (!effort || effort === 'none')) {
    effort = profile.defaultReasoningEffort === 'none' ? undefined : profile.defaultReasoningEffort
  }
  if (!profile.declaredEfforts && effort && isDeepSeekModel(provider, model)) effort = deepSeekEffort(effort)
  if (!profile.declaredEfforts && /(?:^|[/:])glm-5\.2(?:[-.]|$)/i.test(model)) {
    if (effort === 'minimal') effort = 'none'
    if (effort === 'xhigh') effort = 'max'
  }
  if (!profile.declaredEfforts && /(?:^|[/:])glm-5\.3(?:[-.]|$)/i.test(model)) {
    if (effort === 'minimal') effort = 'low'
    if (effort === 'medium') effort = 'high'
    if (effort === 'xhigh' || effort === 'ultra') effort = 'max'
  }
  if (effort === 'none' && profile.thinkingMode === 'always') throw new Error(`${model} 始终开启思考，不支持关闭；请使用跟随 Codex 或最高强度模式。`)
  if (effort && effort !== 'none' && profile.reasoningEfforts.length && !profile.reasoningEfforts.includes(effort)) {
    // A previous chat may retain an effort from another model.
    const rank = REASONING_EFFORTS.indexOf(effort)
    effort = highestEffort(profile.reasoningEfforts.filter(level => level !== 'none' && REASONING_EFFORTS.indexOf(level) <= rank))
      ?? profile.reasoningEfforts.find(level => level !== 'none')
  }
  const enabled = effort ? effort !== 'none' : ['on', 'max'].includes(provider.thinking) ? true : undefined
  const sendsEffort = (native || !profile.toggleOnly) && profile.thinkingMode !== 'none' && !(profile.thinkingMode === 'always' && !profile.reasoningEfforts.length)
  delete body.reasoning_effort
  if (native) {
    const reasoning = { ...body.reasoning }
    delete reasoning.effort
    if (effort && sendsEffort) reasoning.effort = effort
    if (Object.keys(reasoning).length) body.reasoning = reasoning
    else delete body.reasoning
  } else if (effort && sendsEffort && (effort !== 'none' || profile.thinkingControl === 'none')) body.reasoning_effort = effort
  if (!native) {
    if (profile.thinkingControl === 'enable_thinking' && enabled !== undefined) body.enable_thinking = enabled
    else if (profile.thinkingControl === 'thinking' && enabled !== undefined) body.thinking = { type: enabled ? 'enabled' : 'disabled' }
    else if (profile.thinkingMode === 'none') { delete body.thinking; delete body.enable_thinking }
  }
}
