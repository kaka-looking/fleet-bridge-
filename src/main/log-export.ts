import type { RequestLog } from '../shared/types'
import { failureStageLabels, knownUsage, normalizeRequestLog, requestStatusLabel, upstreamOutcomeLabel } from '../shared/request-log'

export function formatLogsCsv(logs: RequestLog[]) {
  const cell = (value: unknown) => {
    const text = String(value ?? '')
    return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"`
  }
  const rows = [
    ['时间', '服务商', '模型', '请求路径', '本地结果', '上游 HTTP 状态', '上游结果', '异常阶段', '上游请求 ID', '输入 Tokens', '输出 Tokens', '耗时 (ms)', '网络错误码', '错误', '说明'],
    ...logs.map(normalizeRequestLog).map(log => [log.at, log.provider, log.model, log.path ?? '/v1/responses', requestStatusLabel(log), log.upstreamHttpStatus ?? '', upstreamOutcomeLabel(log), log.failureStage ? failureStageLabels[log.failureStage] : '', log.upstreamRequestId ?? '', knownUsage(log) ? log.inputTokens : '', knownUsage(log) ? log.outputTokens : '', log.latency, log.errorCode ?? '', log.error ?? '', log.note ?? ''])
  ]
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')
}
