/** Display hints inferred from model IDs, not verification of an upstream model. */
export const MODEL_BRANDS = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
  gemma: 'Gemma',
  grok: 'Grok',
  muse: 'Muse（Meta）',
  deepseek: 'DeepSeek',
  glm: '智谱 GLM',
  kimi: 'Kimi / Moonshot',
  qwen: '通义千问 Qwen',
  minimax: 'MiniMax',
  llama: 'Meta Llama',
  mistral: 'Mistral',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  doubao: '豆包',
  seed: '字节跳动 Seed',
  stepfun: '阶跃星辰',
  hunyuan: '腾讯混元',
  ernie: '百度文心',
  yi: '零一万物 Yi',
  baichuan: '百川',
  internlm: '书生 InternLM',
  mimo: '小米 MiMo',
  longcat: '美团 LongCat',
  kat: '快手 KAT',
  spark: '讯飞星火',
  sensenova: '商汤日日新',
  skywork: '天工 Skywork',
  nvidia: 'NVIDIA Nemotron',
  phi: 'Microsoft Phi',
  granite: 'IBM Granite',
  ai21: 'AI21 Jamba',
  nova: 'Amazon Nova',
  hermes: 'Nous Research Hermes',
  reka: 'Reka',
  rwkv: 'RWKV',
  olmo: 'Ai2 OLMo',
  inflection: 'Inflection',
  dbrx: 'Databricks DBRX',
  falcon: 'TII Falcon',
  ling: '蚂蚁百灵 Ling',
  solar: 'Upstage Solar'
} as const

export type ModelBrand = keyof typeof MODEL_BRANDS

const rules: readonly { brand: ModelBrand; pattern: RegExp }[] = [
  { brand: 'claude', pattern: /^claude(?:[-_.\d]|$)/ },
  { brand: 'openai', pattern: /^(?:gpt(?:[-_.\d]|$)|chatgpt(?:[-_.]|$)|o[134](?:[-_.]|$)|codex(?:[-_.]|$))/ },
  { brand: 'gemini', pattern: /^gemini(?:[-_.\d]|$)/ },
  { brand: 'gemma', pattern: /^gemma(?:[-_.\d]|$)/ },
  { brand: 'grok', pattern: /^grok(?:[-_.\d]|$)/ },
  { brand: 'muse', pattern: /^muse(?:[-_.]|$)/ },
  { brand: 'deepseek', pattern: /^deepseek(?:[-_.\d]|$)/ },
  { brand: 'glm', pattern: /^(?:chat)?glm(?:[-_.\d]|$)/ },
  { brand: 'kimi', pattern: /^(?:kimi|moonshot)(?:[-_.\d]|$)/ },
  { brand: 'qwen', pattern: /^(?:qwen|qwq|qvq)(?:[-_.\d]|$)/ },
  { brand: 'minimax', pattern: /^(?:minimax(?:[-_.\d]|$)|abab\d)/ },
  // Derived models keep their own brand instead of an embedded base-model name.
  { brand: 'nvidia', pattern: /^(?:llama[-\d.]+-)?nemotron(?:[-_.\d]|$)/ },
  { brand: 'hermes', pattern: /^hermes(?:[-_.\d]|$)/ },
  { brand: 'llama', pattern: /^llama(?:[-_.\d]|$)/ },
  { brand: 'mistral', pattern: /^(?:mistral|mixtral|ministral|codestral|devstral|pixtral|magistral|mathstral|voxtral)(?:[-_.\d]|$)/ },
  { brand: 'cohere', pattern: /^(?:command|c4ai-command|aya)(?:[-_.\d]|$)/ },
  { brand: 'perplexity', pattern: /^(?:sonar|pplx)(?:[-_.]|$)/ },
  { brand: 'doubao', pattern: /^doubao(?:[-_.\d]|$)/ },
  { brand: 'seed', pattern: /^(?:seed(?:[-_.]|$)|seedance(?:[-_.\d]|$)|seedream(?:[-_.\d]|$))/ },
  { brand: 'stepfun', pattern: /^(?:step[-_.]?\d|stepfun(?:[-_.]|$))/ },
  { brand: 'hunyuan', pattern: /^hunyuan(?:[-_.\d]|$)/ },
  { brand: 'ernie', pattern: /^(?:ernie|wenxin)(?:[-_.\d]|$)/ },
  { brand: 'yi', pattern: /^yi(?:[-_.\d]|$)/ },
  { brand: 'baichuan', pattern: /^baichuan(?:[-_.\d]|$)/ },
  { brand: 'internlm', pattern: /^internlm(?:[-_.\d]|$)/ },
  { brand: 'mimo', pattern: /^mimo(?:[-_.\d]|$)/ },
  { brand: 'longcat', pattern: /^longcat(?:[-_.\d]|$)/ },
  { brand: 'kat', pattern: /^(?:kat|kwaikat|kwaipilot)(?:[-_.\d]|$)/ },
  { brand: 'spark', pattern: /^spark(?:[-_.\d]|$)/ },
  { brand: 'sensenova', pattern: /^(?:sensenova|sensechat)(?:[-_.\d]|$)/ },
  { brand: 'skywork', pattern: /^skywork(?:[-_.\d]|$)/ },
  { brand: 'phi', pattern: /^phi(?:[-_.\d]|$)/ },
  { brand: 'granite', pattern: /^granite(?:[-_.\d]|$)/ },
  { brand: 'ai21', pattern: /^(?:jamba|j2)(?:[-_.\d]|$)/ },
  { brand: 'nova', pattern: /^nova(?:[-_.\d]|$)/ },
  { brand: 'reka', pattern: /^reka(?:[-_.\d]|$)/ },
  { brand: 'rwkv', pattern: /^rwkv(?:[-_.\d]|$)/ },
  { brand: 'olmo', pattern: /^olmo(?:[-_.\d]|$)/ },
  { brand: 'inflection', pattern: /^inflection(?:[-_.\d]|$)/ },
  { brand: 'dbrx', pattern: /^dbrx(?:[-_.\d]|$)/ },
  { brand: 'falcon', pattern: /^falcon(?:[-_.\d]|$)/ },
  { brand: 'ling', pattern: /^(?:ling|ring|bailing)(?:[-_.\d]|$)/ },
  { brand: 'solar', pattern: /^solar(?:[-_.\d]|$)/ }
]

export function detectModelBrand(model: string): ModelBrand | undefined {
  // Handle router namespaces, OpenRouter suffixes and Bedrock regional IDs.
  const leaf = model.trim().toLowerCase()
    .replace(/:(?:\d+|free|extended|thinking|online|nitro|floor|exacto)$/, '')
    .split(/[/:]/).at(-1) ?? ''
  const name = leaf.replace(/^(?:(?:us|eu|apac|global)\.)?(?:anthropic|amazon|google|meta|mistral|cohere|openai|xai|nvidia)\./, '')
  // Sonar models can carry a Llama prefix; identify them before the base family.
  if (/^llama[-\d.]+-sonar(?:[-_.]|$)/.test(name)) return 'perplexity'
  return rules.find(rule => rule.pattern.test(name))?.brand
}
