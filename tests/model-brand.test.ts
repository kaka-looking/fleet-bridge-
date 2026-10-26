import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { detectModelBrand, MODEL_BRANDS, type ModelBrand } from '../src/shared/model-brand'

const examples: [string, ModelBrand][] = [
  ['claude-sonnet-4-6', 'claude'], ['gpt-6.1-sol', 'openai'], ['o3-pro', 'openai'], ['o4-mini', 'openai'],
  ['chatgpt-4o-latest', 'openai'], ['codex-mini-latest', 'openai'],
  ['gemini-2.5-pro', 'gemini'], ['gemma-3-27b-it', 'gemma'],
  ['grok-4-fast', 'grok'], ['muse-spark', 'muse'], ['muse', 'muse'],
  ['deepseek-v4.1-flash', 'deepseek'], ['glm-5.3', 'glm'], ['chatglm3-6b', 'glm'],
  ['kimi-k2.5', 'kimi'], ['moonshot-v1-128k', 'kimi'],
  ['Qwen3-Coder-480B-A35B-Instruct', 'qwen'], ['QwQ-32B', 'qwen'], ['QVQ-72B-Preview', 'qwen'],
  ['MiniMax-M2.5', 'minimax'], ['abab6.5-chat', 'minimax'],
  ['Llama-3.3-70B-Instruct', 'llama'], ['Llama3.1-8B-Instruct', 'llama'],
  ['mistral-large-latest', 'mistral'], ['mixtral-8x22b-instruct', 'mistral'],
  ['ministral-8b-latest', 'mistral'], ['codestral-latest', 'mistral'],
  ['devstral-small-latest', 'mistral'], ['pixtral-large-latest', 'mistral'],
  ['magistral-medium-latest', 'mistral'], ['mathstral-7b', 'mistral'], ['voxtral-mini-latest', 'mistral'],
  ['command-a-03-2025', 'cohere'], ['c4ai-command-r-plus', 'cohere'], ['aya-expanse-32b', 'cohere'],
  ['sonar-pro', 'perplexity'], ['llama-3.1-sonar-large-128k-online', 'perplexity'], ['pplx-70b-online', 'perplexity'],
  ['doubao-1.5-pro-32k', 'doubao'], ['Seed-OSS-36B-Instruct', 'seed'],
  ['seedance-1.0-pro', 'seed'], ['seedream-3.0', 'seed'],
  ['step-3.5-flash', 'stepfun'], ['step2-16k', 'stepfun'],
  ['hunyuan-turbos-latest', 'hunyuan'], ['ernie-4.5-turbo-128k', 'ernie'], ['wenxin-4', 'ernie'],
  ['yi-lightning', 'yi'], ['Baichuan4-Air', 'baichuan'], ['InternLM3-8B-Instruct', 'internlm'],
  ['mimo-v2-flash', 'mimo'], ['LongCat-Flash-Chat', 'longcat'], ['KAT-Coder-Pro', 'kat'],
  ['Spark-X1', 'spark'], ['sensenova-v6', 'sensenova'], ['SenseChat-5', 'sensenova'],
  ['Skywork-OR1-32B', 'skywork'], ['nemotron-nano-9b-v2', 'nvidia'],
  ['Llama-3.3-Nemotron-Super-49B-v1.5', 'nvidia'], ['Phi-4', 'phi'],
  ['granite-3.3-8b-instruct', 'granite'], ['jamba-large', 'ai21'], ['j2-ultra', 'ai21'],
  ['nova-pro-v1', 'nova'], ['Hermes-3-Llama-3.1-405B', 'hermes'], ['reka-core', 'reka'],
  ['RWKV-7-World', 'rwkv'], ['OLMo-2-0325-32B-Instruct', 'olmo'],
  ['inflection-3-pi', 'inflection'], ['dbrx-instruct', 'dbrx'], ['falcon-180B-chat', 'falcon'],
  ['Ling-1T', 'ling'], ['Ring-1T', 'ling'], ['bailing-7b', 'ling'], ['solar-pro2', 'solar']
]

describe('model brand recognition', () => {
  it.each(examples)('recognizes %s as %s', (model, brand) => expect(detectModelBrand(model)).toBe(brand))

  it.each([
    ['  GLOBAL:Claude-Sonnet-4-6  ', 'claude'],
    ['anthropic/claude-sonnet-4-6', 'claude'],
    ['openrouter/anthropic/claude-sonnet-4-6', 'claude'],
    ['global.anthropic.claude-sonnet-4-6', 'claude'],
    ['us.anthropic.claude-3-5-sonnet-20241022-v2:0', 'claude'],
    ['fleet/provider-id/openai/gpt-6.1-sol', 'openai'],
    ['models/gemini-2.5-pro', 'gemini'],
    ['x-ai/grok-4-fast', 'grok'],
    ['meta/muse-spark', 'muse'],
    ['deepseek/deepseek-r1:free', 'deepseek'],
    ['Qwen/Qwen3-Coder-480B-A35B-Instruct', 'qwen'],
    ['z-ai/glm-5.3:extended', 'glm'],
    ['amazon.nova-pro-v1:0', 'nova'],
    ['us.meta.llama3-1-70b-instruct-v1:0', 'llama'],
    ['mistral.mistral-large-2402-v1:0', 'mistral'],
    ['cohere.command-r-plus-v1:0', 'cohere']
  ] as [string, ModelBrand][])('normalizes %s without changing the model ID', (model, brand) => {
    const original = model
    expect(detectModelBrand(model)).toBe(brand)
    expect(model).toBe(original)
  })

  it.each([
    '', ' ', 'fixture-model', 'my-claude-proxy', 'claudeish', 'grokking', 'museums',
    'gptish', 'o10', 'o34', 'step-by-step', 'yiwen', 'phixture', 'qwenish',
    'minimaximum', 'unknown-gemini', 'openai/custom-model', 'mistral/my-custom-alias'
  ])('does not invent a brand for %j', model => expect(detectModelBrand(model)).toBeUndefined())

  it('does not misidentify derived models by an embedded base-model name', () => {
    expect(detectModelBrand('DeepSeek-R1-Distill-Qwen-32B')).toBe('deepseek')
    expect(detectModelBrand('NousResearch/Hermes-3-Llama-3.1-405B')).toBe('hermes')
    expect(detectModelBrand('nvidia/Llama-3.3-Nemotron-Super-49B-v1.5')).toBe('nvidia')
    expect(detectModelBrand('perplexity/llama-3.1-sonar-large-128k-online')).toBe('perplexity')
  })

  it('has recognition coverage for every catalog entry', () => {
    expect([...new Set(examples.map(([, brand]) => brand))].sort()).toEqual(Object.keys(MODEL_BRANDS).sort())
  })
})

describe('bundled brand assets', () => {
  const folder = resolve('src/renderer/src/assets/model-brands')
  const reused = new Set(['deepseek', 'glm', 'kimi', 'qwen', 'minimax'])
  it('has an offline asset for every known brand and reuses the five existing logos', () => {
    for (const brand of Object.keys(MODEL_BRANDS)) {
      const file = reused.has(brand) ? resolve('src/renderer/src/assets', `${brand}.png`) : resolve(folder, `${brand}.svg`)
      expect(existsSync(file), brand).toBe(true)
    }
    expect(readdirSync(folder).sort()).toEqual(Object.keys(MODEL_BRANDS).filter(brand => !reused.has(brand)).map(brand => `${brand}.svg`).sort())
  })
  it('does not bundle scripts or remote resources inside SVGs', () => {
    for (const file of readdirSync(folder)) {
      const svg = readFileSync(resolve(folder, file), 'utf8')
      expect(svg, file).toMatch(/<svg\b/)
      expect(svg, file).toMatch(/viewBox=/)
      expect(svg, file).not.toMatch(/<(?:script|foreignObject|image)\b|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|\/\/|javascript:|data:)/i)
    }
  })
  it('ships the attribution and original license with the app resources', () => {
    const license = readFileSync(resolve('resources/model-brand-icons.LICENSE.txt'), 'utf8')
    expect(license).toContain('MIT License')
    expect(license).toContain('Copyright (c) 2023 LobeHub')
    expect(license).toContain('8b7bbc433d38437fa2b0cca58ae896917162b812')
    for (const file of readdirSync(folder)) expect(license).toContain(`${file} <- `)
  })
})
