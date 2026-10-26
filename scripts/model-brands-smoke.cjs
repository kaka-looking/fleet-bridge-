const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const assert = require('node:assert/strict')
const ts = require('typescript')

;(async () => {
  const root = path.resolve(__dirname, '..')
  const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const sandbox = fs.mkdtempSync(path.join(artifacts, 'model-brands-'))
  const data = path.join(sandbox, 'app', 'data')
  fs.mkdirSync(data, { recursive: true })
  const modulePath = path.join(sandbox, 'model-brand.cjs')
  fs.writeFileSync(modulePath, ts.transpileModule(fs.readFileSync(path.join(root, 'src/shared/model-brand.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText)
  const { MODEL_BRANDS, detectModelBrand } = require(modulePath)
  const examples = {
    claude: 'anthropic/claude-sonnet-4-6',
    grok: 'x-ai/grok-4-fast',
    muse: 'meta/muse-spark',
    openai: 'gpt-6.1-sol',
    gemini: 'models/gemini-2.5-pro',
    deepseek: 'global:deepseek-v4.1-flash',
    gemma: 'google/gemma-3-27b-it',
    glm: 'z-ai/glm-5.3',
    kimi: 'moonshot-v1-128k',
    qwen: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
    minimax: 'MiniMaxAI/MiniMax-M2.5',
    llama: 'meta-llama/Llama-3.3-70B-Instruct',
    mistral: 'mistralai/devstral-small-latest',
    cohere: 'cohere/command-a-03-2025',
    perplexity: 'perplexity/sonar-pro',
    doubao: 'doubao-1.5-pro-32k',
    seed: 'ByteDance-Seed/Seed-OSS-36B-Instruct',
    stepfun: 'step-3.5-flash',
    hunyuan: 'hunyuan-turbos-latest',
    ernie: 'ernie-4.5-turbo-128k',
    yi: 'yi-lightning',
    baichuan: 'Baichuan4-Air',
    internlm: 'internlm/InternLM3-8B-Instruct',
    mimo: 'xiaomi/mimo-v2-flash',
    longcat: 'meituan/LongCat-Flash-Chat',
    kat: 'KAT-Coder-Pro',
    spark: 'Spark-X1',
    sensenova: 'SenseChat-5',
    skywork: 'Skywork/Skywork-OR1-32B',
    nvidia: 'nvidia/Llama-3.3-Nemotron-Super-49B-v1.5',
    phi: 'microsoft/Phi-4',
    granite: 'ibm-granite/granite-3.3-8b-instruct',
    ai21: 'ai21/jamba-large',
    nova: 'us.amazon.nova-pro-v1:0',
    hermes: 'NousResearch/Hermes-3-Llama-3.1-405B',
    reka: 'reka-core',
    rwkv: 'RWKV-7-World',
    olmo: 'allenai/OLMo-2-0325-32B-Instruct',
    inflection: 'inflection-3-pi',
    dbrx: 'databricks/dbrx-instruct',
    falcon: 'tiiuae/falcon-180B-chat',
    ling: 'Ling-1T',
    solar: 'upstage/solar-pro2'
  }
  assert.deepEqual(Object.keys(examples).sort(), Object.keys(MODEL_BRANDS).sort())
  const now = new Date().toISOString()
  const logs = Object.entries(examples).map(([brand, model]) => ({
    id: `brand-${brand}`, at: now, provider: '混合模型中转', model, status: 'ok',
    latency: 200, inputTokens: 100, outputTokens: 20, usageKnown: true, upstreamOutcome: 'completed'
  }))
  logs.push({ ...logs[0], id: 'unknown', provider: 'Claude Proxy（仅渠道名）', model: 'my-custom-model' })
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({
    version: 1, providers: [], activeProviderId: null, gatewayToken: randomBytes(32).toString('hex'),
    settings: { port: 24680, autoStart: false, launchAtLogin: false, theme: 'light', timeout: 120 }, logs
  }))
  const env = { ...process.env, FLEET_DATA_DIR: path.join(sandbox, 'app'), FLEET_CODEX_HOME: path.join(sandbox, 'codex') }
  delete env.ELECTRON_RUN_AS_NODE; delete env.OPENAI_API_KEY; delete env.OPENAI_BASE_URL
  let application
  const errors = []
  const network = []
  try {
    application = await electron.launch({ args: [root, '--force-device-scale-factor=1'], env })
    const page = await application.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/^https?:\/\//, route => { network.push(route.request().url()); return route.abort() })
    await page.context().setOffline(true)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 1000))
    await page.getByRole('heading', { name: /你自己的模型舰队/ }).waitFor()
    await page.getByRole('button', { name: '连接记录', exact: true }).click()
    async function checkPage() {
      await page.waitForFunction(() => [...document.querySelectorAll('.model-brand-mark img')].every(image => image.complete && image.naturalWidth > 0))
      const rows = await page.locator('.log-table tbody tr').evaluateAll(rows => rows.map(row => {
        const label = row.querySelector('.log-model-label')
        const image = label.querySelector('img')
        return {
          model: label.querySelector('.log-model-name').textContent,
          provider: row.querySelector('.log-provider').textContent,
          brand: label.dataset.modelBrand,
          hint: label.querySelector('.model-brand-mark').title,
          image: image ? { source: image.src, width: image.naturalWidth, height: image.naturalHeight } : null
        }
      }))
      for (const row of rows) {
        assert.equal(await page.getByRole('cell', { name: row.model, exact: true }).count(), 1, 'Decorative logos must not change the accessible model name')
        assert.equal(row.brand, detectModelBrand(row.model) ?? 'unknown')
        if (row.brand === 'unknown') {
          assert.equal(row.provider, 'Claude Proxy（仅渠道名）')
          assert.equal(row.image, null, 'An unknown model must not inherit the provider name as its brand')
        } else {
          assert.equal(row.provider, '混合模型中转', 'The actual provider name must not be replaced by the model brand')
          assert.ok(row.image && row.image.width > 0 && row.image.height > 0, row.brand)
          assert.ok(!/^https?:/i.test(row.image.source), 'All icons must work offline')
          assert.match(row.hint, /根据模型名称识别/)
          assert.equal(row.model, examples[row.brand], 'Model IDs must stay unchanged')
        }
      }
      return rows
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async theme => {
        const snapshot = await window.fleet.snapshot()
        await window.fleet.saveSettings({ ...snapshot.settings, theme })
      }, theme)
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme)
      await page.getByRole('button', { name: '重置', exact: true }).click()
      const seen = []
      for (;;) {
        seen.push(...(await checkPage()).map(row => row.brand))
        const next = page.getByRole('button', { name: '下一页', exact: true })
        if (await next.isDisabled()) break
        const oldModel = await page.locator('.log-model-name').first().innerText()
        await next.click()
        await page.waitForFunction(oldModel => document.querySelector('.log-model-name')?.textContent !== oldModel, oldModel)
      }
      assert.deepEqual([...new Set(seen)].sort(), [...Object.keys(MODEL_BRANDS), 'unknown'].sort())
      await page.getByRole('button', { name: '重置', exact: true }).click()
      await checkPage()
      await page.locator('.logs-table-panel').screenshot({ path: path.join(artifacts, `model-brands-${theme}.png`) })
    }
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 740))
    await checkPage()
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('.main-content')
      return main.scrollWidth - main.clientWidth
    })
    assert.ok(overflow <= 1, 'Brand icons must not cause main-page horizontal overflow')
    await page.locator('.logs-table-panel').screenshot({ path: path.join(artifacts, 'model-brands-compact.png') })
    const first = page.locator('.log-model-label').first()
    await first.locator('img').evaluate(image => { image.src = 'data:image/svg+xml,invalid' })
    await first.locator('.model-brand-mark svg').waitFor()
    assert.equal(await first.locator('.log-model-name').innerText(), examples.claude)
    assert.deepEqual(network, [])
    assert.deepEqual(errors, [])
    assert.equal(fs.existsSync(path.join(sandbox, 'codex', 'config.toml')), false)
    console.log(`模型品牌桌面验证通过：${Object.keys(MODEL_BRANDS).length} 个品牌离线加载、旧记录自动识别、命名空间、深浅色、窄窗口、未知及损坏图标兜底，服务商与模型 ID 保持不变。`)
  } finally { if (application) await application.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
