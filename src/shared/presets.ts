import type { ProviderInput, ProviderKind } from './types'
export const PRESETS: Record<ProviderKind, Omit<ProviderInput, 'apiKey' | 'id'>> = {
  deepseek: { name: 'DeepSeek', kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', protocol: 'chat', models: ['deepseek-flash', 'deepseek-v4-pro'], defaultModel: 'deepseek-flash', contextWindow: 1048576, vision: true, thinking: 'auto' },
  glm: { name: '智谱 GLM', kind: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'chat', models: ['glm-5.3'], defaultModel: 'glm-5.3', contextWindow: 128000, vision: false, thinking: 'auto' },
  kimi: { name: 'Kimi', kind: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'chat', models: ['kimi-k2.5'], defaultModel: 'kimi-k2.5', contextWindow: 262144, vision: true, thinking: 'auto' },
  qwen: { name: '通义千问', kind: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'chat', models: ['qwen-plus'], defaultModel: 'qwen-plus', contextWindow: 128000, vision: false, thinking: 'auto' },
  minimax: { name: 'MiniMax', kind: 'minimax', baseUrl: 'https://api.minimaxi.com/v1', protocol: 'chat', models: ['MiniMax-M2.5'], defaultModel: 'MiniMax-M2.5', contextWindow: 128000, vision: false, thinking: 'auto' },
  custom: { name: '', kind: 'custom', baseUrl: '', protocol: 'chat', models: [], defaultModel: '', contextWindow: 128000, vision: false, thinking: 'auto' }
}
