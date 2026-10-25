import type { RequestLog } from './types'

export function normalizeRequestLog(log: RequestLog): RequestLog {
  if (log.upstreamOutcome !== undefined) return log
  const legacy = { ...log, legacyRecord: true }
  if (log.status !== 'error') return legacy
  const message = log.error ?? ''
  if (/timeout|timed out|超时/i.test(message)) return { ...legacy, status: 'timeout' }
  if (/fetch failed|terminated|ECONNRESET|ECONNREFUSED|ENOTFOUND|UND_ERR_|连接提前关闭|未收到完成/i.test(message)) return { ...legacy, status: 'interrupted' }
  if (/operation was aborted|用户取消/i.test(message)) return { ...legacy, status: 'cancelled' }
  return legacy
}

export function requestStatusLabel(log: RequestLog) {
  const status = normalizeRequestLog(log).status
  if (status === 'ok') return '成功'
  if (status === 'cancelled') return '已取消'
  if (status === 'interrupted') return '连接中断'
  if (status === 'timeout') return '超时'
  if (status === 'incomplete') return '输出未完成'
  return log.upstreamOutcome === 'failed' ? '上游失败' : log.legacyRecord || log.upstreamOutcome === undefined ? '历史异常' : '处理异常'
}

export function upstreamOutcomeLabel(log: RequestLog) {
  if (log.upstreamOutcome === 'completed') return '已收到上游完成响应'
  if (log.upstreamOutcome === 'failed') return '上游明确返回失败'
  if (log.upstreamOutcome === 'not_sent') return '未向上游发送'
  return log.legacyRecord || log.upstreamOutcome === undefined ? '旧记录未保存上游状态，无法确认' : '未确认，不能据此判断上游生成失败'
}

export const failureStageLabels = {
  prepare: '本地请求准备', connect: '等待上游响应', receive: '接收上游响应', convert: '转换响应格式', deliver: '向 Codex 返回响应'
}

export function requestStatusHint(log: RequestLog) {
  return [requestStatusLabel(log), log.upstreamHttpStatus ? `上游 HTTP ${log.upstreamHttpStatus}` : '', upstreamOutcomeLabel(log)].filter(Boolean).join(' · ')
}

export function knownUsage(log: RequestLog) {
  return log.usageKnown ?? (log.inputTokens > 0 || log.outputTokens > 0)
}
