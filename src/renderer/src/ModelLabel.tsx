import { useState } from 'react'
import { Cpu } from 'lucide-react'
import { detectModelBrand, MODEL_BRANDS } from '../../shared/model-brand'
import deepseek from './assets/deepseek.png'
import glm from './assets/glm.png'
import kimi from './assets/kimi.png'
import qwen from './assets/qwen.png'
import minimax from './assets/minimax.png'
import './model-brands.css'

const svgIcons = import.meta.glob<string>('./assets/model-brands/*.svg', { eager: true, query: '?url', import: 'default' })
const existingIcons: Record<string, string> = { deepseek, glm, kimi, qwen, minimax }

export function ModelLabel({ model }: { model: string }) {
  const brand = detectModelBrand(model)
  const source = brand ? existingIcons[brand] ?? svgIcons[`./assets/model-brands/${brand}.svg`] : undefined
  const [failedSource, setFailedSource] = useState<string>()
  const hint = brand ? `模型品牌：${MODEL_BRANDS[brand]}（根据模型名称识别，不代表实际调用渠道或模型真实性）` : '未识别的模型品牌'

  return <span className="log-model-label" data-model-brand={brand ?? 'unknown'}>
    <span className="model-brand-mark" title={hint} aria-hidden="true">
      {source && failedSource !== source
        ? <img src={source} alt="" aria-hidden="true" onError={() => setFailedSource(source)}/>
        : <Cpu size={14} aria-hidden="true"/>}
    </span>
    <span className="log-model-name" title={model}>{model}</span>
  </span>
}
