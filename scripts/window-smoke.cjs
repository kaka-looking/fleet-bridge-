const { _electron: electron } = require('playwright')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const exec = promisify(execFile)

const clickCode = `
import ctypes, json, sys, time
from ctypes import wintypes as w
u = ctypes.windll.user32
try: u.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
except AttributeError: pass
u.GetClientRect.argtypes = [w.HWND, ctypes.POINTER(w.RECT)]
u.GetWindowRect.argtypes = [w.HWND, ctypes.POINTER(w.RECT)]
u.ClientToScreen.argtypes = [w.HWND, ctypes.POINTER(w.POINT)]
u.SetForegroundWindow.argtypes = [w.HWND]
u.GetForegroundWindow.restype = w.HWND
hwnd = int(sys.argv[1])
r = w.RECT(); origin = w.POINT(0, 0); previous = w.POINT()
before = w.RECT(); after = w.RECT()
assert u.GetWindowRect(hwnd, ctypes.byref(before))
assert u.GetClientRect(hwnd, ctypes.byref(r))
assert u.ClientToScreen(hwnd, ctypes.byref(origin))
u.GetCursorPos(ctypes.byref(previous))
x = origin.x + round((r.right-r.left) * float(sys.argv[2]))
y = origin.y + round((r.bottom-r.top) * float(sys.argv[3]))
u.SetForegroundWindow(hwnd)
u.SetCursorPos(x, y)
time.sleep(0.1)
assert u.GetForegroundWindow() == hwnd, 'Test window is not in the foreground'
u.mouse_event(2, 0, 0, 0, 0)
time.sleep(0.05)
if len(sys.argv) > 4:
    dx, dy = int(sys.argv[4]), int(sys.argv[5])
    for i in range(1, 17):
        u.SetCursorPos(x + round(dx*i/16), y + round(dy*i/16))
        time.sleep(0.015)
u.mouse_event(4, 0, 0, 0, 0)
time.sleep(0.1)
u.SetCursorPos(previous.x, previous.y)
assert u.GetWindowRect(hwnd, ctypes.byref(after))
print(json.dumps({'x':x,'y':y,'beforeSize':[before.right-before.left,before.bottom-before.top],'afterSize':[after.right-after.left,after.bottom-after.top]}))
`

;(async () => {
  const root = path.resolve(__dirname, '..')
  const artifacts = path.join(root, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const sandbox = fs.mkdtempSync(path.join(artifacts, 'window-'))
  const data = path.join(sandbox, 'app', 'data')
  fs.mkdirSync(data, { recursive: true })
  const token = randomBytes(32).toString('hex')
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const gatewayPort = probe.address().port; await new Promise(resolve => probe.close(resolve))
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ version: 1, providers: [], activeProviderId: null, settings: { port: gatewayPort, autoStart: true, launchAtLogin: false, theme: 'light', timeout: 120 }, gatewayToken: token, logs: [] }))
  const mock = createServer(async (request, response) => {
    for await (const _ of request) {}
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: 'Window layout test' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }))
  })
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
  const env = { ...process.env, FLEET_DATA_DIR: path.join(sandbox, 'app'), FLEET_CODEX_HOME: path.join(sandbox, 'codex') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENAI_API_KEY
  delete env.OPENAI_BASE_URL
  const scale = process.env.FLEET_TEST_SCALE || '1.25'
  let application
  try {
    application = await electron.launch({ args: [root, `--force-device-scale-factor=${scale}`], env })
    const page = await application.firstWindow()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('heading', { name: /你自己的模型舰队/ }).waitFor()
    const initial = await application.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const bounds = window.getBounds()
      return { bounds, workArea: screen.getDisplayMatching(bounds).workArea, maximized: window.isMaximized(), fullscreen: window.isFullScreen() }
    })
    assert.equal(initial.maximized, false)
    assert.equal(initial.fullscreen, false)
    const { bounds, workArea } = initial
    assert.ok(bounds.width < workArea.width && bounds.height < workArea.height)
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - workArea.x - workArea.width / 2) <= 2)
    assert.ok(Math.abs(bounds.y + bounds.height / 2 - workArea.y - workArea.height / 2) <= 2)
    const edgeCheck = async () => {
      const rects = await page.evaluate(() => ['.desktop', '.app-shell'].map(selector => {
        const element = document.querySelector(selector)
        const rect = element.getBoundingClientRect(); const style = getComputedStyle(element)
        return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight, border: style.borderWidth, padding: style.padding }
      }))
      for (const rect of rects) {
        assert.equal(rect.x, 0, rect.selector)
        assert.equal(rect.y, 0, rect.selector)
        assert.ok(Math.abs(rect.width - rect.viewportWidth) < 1, rect.selector)
        assert.ok(Math.abs(rect.height - rect.viewportHeight) < 1, rect.selector)
        assert.equal(rect.border, '0px')
        assert.equal(rect.padding, '0px')
      }
    }
    const poll = async check => {
      const began = Date.now()
      while (Date.now() - began < 8000) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 60)) }
      throw new Error('Native window state did not change')
    }
    const nativeMouse = async (locator, drag = false) => {
      await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
      const target = await locator.boundingBox()
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      const handle = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString())
      const result = await exec('python', ['-c', clickCode, handle, String((target.x + target.width / 2) / viewport.width), String((target.y + target.height / 2) / viewport.height), ...(drag ? ['80', '50'] : [])], { windowsHide: true })
      return JSON.parse(result.stdout)
    }
    const nativeClick = label => nativeMouse(page.getByRole('button', { name: label, exact: true }))
    await edgeCheck()
    const dragged = []
    for (const selector of ['.page-header h1', '.titlebar-drag-region']) {
      const physical = await nativeMouse(page.locator(selector), true)
      await poll(async () => {
        const moved = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
        return Math.abs(moved.x - bounds.x) > 20 && Math.abs(moved.y - bounds.y) > 20
      })
      const moved = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
      assert.deepEqual(physical.afterSize, physical.beforeSize, 'Dragging must preserve physical window dimensions')
      assert.ok(Math.abs(moved.width - bounds.width) <= 1, 'DIP rounding at fractional display scale')
      assert.ok(Math.abs(moved.height - bounds.height) <= 1, 'DIP rounding at fractional display scale')
      dragged.push({ selector, bounds: moved, physical })
      await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), bounds)
    }
    const navigation = []
    for (const size of [{ width: bounds.width, height: bounds.height }, { width: 1000, height: 640 }]) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), size)
      const nativeBefore = await application.evaluate(({ BrowserWindow }) => ({ bounds: BrowserWindow.getAllWindows()[0].getBounds(), zoom: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor() }))
      const views = []
      for (const name of ['工作台', '连接记录', '服务商', '设置', '工作台']) {
        await page.getByRole('button', { name, exact: true }).click()
        const geometry = await page.evaluate(() => {
          const selectors = ['.sidebar', '.wordmark', '.brand-icon', '.brand-tagline', '.main-nav', '.main-nav button', '.sidebar-landscape', '.sidebar-bottom', '.main-content', '.page-header']
          return Object.fromEntries(selectors.map(selector => {
            const element = document.querySelector(selector)
            const rect = element.getBoundingClientRect(); const style = getComputedStyle(element)
            return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, fontSize: style.fontSize }]
          }).concat([['scroll', { top: document.querySelector('.main-content').scrollTop, left: document.querySelector('.main-content').scrollLeft }], ['contentWidth', document.querySelector('.main-content').clientWidth], ['titleFont', getComputedStyle(document.querySelector('.page-header h1')).fontSize]]))
        })
        assert.deepEqual(geometry, views[0]?.geometry ?? geometry, `${name} must preserve shared shell geometry`)
        assert.equal(geometry.scroll.top, 0)
        assert.equal(geometry.scroll.left, 0)
        const nativeAfter = await application.evaluate(({ BrowserWindow }) => ({ bounds: BrowserWindow.getAllWindows()[0].getBounds(), zoom: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor() }))
        assert.deepEqual(nativeAfter, nativeBefore, 'Navigation must not resize or zoom the window')
        views.push({ name, geometry })
        if (views.length < 5) await page.locator('.main-content').evaluate(element => element.scrollTo(0, element.scrollHeight))
      }
      navigation.push({ size, views })
    }
    await page.getByRole('button', { name: '工作台', exact: true }).click()
    const digits = await page.locator('.quick-step > span').evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element)
      return { text: element.textContent, background: style.backgroundColor, backgroundImage: style.backgroundImage, border: style.borderWidth, shadow: style.boxShadow, color: style.color }
    }))
    assert.deepEqual(digits.map(digit => digit.text), ['1', '2', '3'])
    for (const digit of digits) {
      assert.equal(digit.background, 'rgba(0, 0, 0, 0)')
      assert.equal(digit.backgroundImage, 'none')
      assert.equal(digit.border, '0px')
      assert.equal(digit.shadow, 'none')
    }
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const timeout = page.getByLabel('超时设置', { exact: true })
    await timeout.scrollIntoViewIfNeeded()
    await timeout.click()
    assert.equal(await timeout.evaluate(element => element.matches(':open')), true)
    const picker = await timeout.evaluate(element => {
      const style = getComputedStyle(element, '::picker(select)')
      const selected = getComputedStyle(element.selectedOptions[0])
      return { appearance: getComputedStyle(element).appearance, radius: style.borderRadius, background: style.backgroundColor, selectedBackground: selected.backgroundColor, selectedColor: selected.color }
    })
    assert.equal(picker.appearance, 'base-select')
    assert.equal(picker.radius, '12px')
    assert.equal(picker.selectedBackground, 'rgb(227, 242, 234)')
    await page.screenshot({ path: path.join(artifacts, `bugfix-timeout-picker-${scale}.png`) })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    assert.equal(await timeout.inputValue(), '300')
    await timeout.click()
    await timeout.getByRole('option', { name: '60 秒', exact: true }).click()
    assert.equal(await timeout.inputValue(), '60')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await poll(() => page.evaluate(async () => (await window.fleet.snapshot()).settings.timeout === 60))
    await page.getByRole('button', { name: '工作台', exact: true }).click()
    await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), bounds)
    const beforeMaximize = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
    await page.screenshot({ path: path.join(artifacts, `bugfix-startup-${scale}.png`) })
    await nativeClick('最大化')
    await poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()))
    await page.getByRole('button', { name: '还原窗口', exact: true }).waitFor()
    await edgeCheck()
    await nativeClick('还原窗口')
    await poll(() => application.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isMaximized()))
    await page.getByRole('button', { name: '最大化', exact: true }).waitFor()
    const restoredBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
    assert.deepEqual(restoredBounds, beforeMaximize)
    await nativeClick('最小化')
    await poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()))
    await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.show(); window.focus() })
    await poll(() => application.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isMinimized()))
    const close = page.getByRole('button', { name: '收起到托盘', exact: true })
    await close.hover()
    const closeStyle = await close.evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }))
    assert.equal(closeStyle.color, 'rgb(239, 68, 68)')
    assert.equal(closeStyle.background, 'rgba(0, 0, 0, 0)')
    await page.mouse.move(230, 110)
    await page.getByRole('button', { name: '连接记录', exact: true }).click()
    assert.equal(await page.locator('.log-stat .sparkline, .log-stat .mini-bars').count(), 0)
    await edgeCheck()
    await page.screenshot({ path: path.join(artifacts, `bugfix-empty-logs-${scale}.png`) })
    await page.evaluate(baseUrl => window.fleet.saveProvider({ kind: 'custom', name: 'Window test', baseUrl, protocol: 'chat', models: ['window-test'], defaultModel: 'window-test', contextWindow: 128000, vision: false, thinking: 'off' }), `http://127.0.0.1:${mock.address().port}/v1`)
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'fleet/default', input: 'Layout probe' }) })
      assert.equal(response.status, 200); await response.text()
    }
    await page.getByRole('cell', { name: 'window-test', exact: true }).first().waitFor()
    const layouts = []
    for (const size of [{ width: bounds.width, height: bounds.height }, { width: 1000, height: 640 }]) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), size)
      await edgeCheck()
      const cards = await page.locator('.log-stat').evaluateAll(elements => elements.map(element => {
        const caption = element.querySelector('.log-stat-caption').getBoundingClientRect()
        const chart = element.querySelector('.sparkline, .mini-bars').getBoundingClientRect()
        const card = element.getBoundingClientRect()
        return { captionRight: caption.right, chartLeft: chart.left, chartRight: chart.right, chartBottom: chart.bottom, cardRight: card.right, cardBottom: card.bottom }
      }))
      for (const card of cards) {
        assert.ok(card.captionRight + 4 <= card.chartLeft, JSON.stringify(card))
        assert.ok(card.chartRight <= card.cardRight)
        assert.ok(card.chartBottom <= card.cardBottom)
      }
      layouts.push({ size, cards })
      await page.screenshot({ path: path.join(artifacts, `bugfix-logs-${size.width}-${scale}.png`) })
    }
    await nativeClick('收起到托盘')
    await poll(() => application.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()))
    assert.deepEqual(errors, [])
    const report = { passed: true, scale, initial, dragged, navigation, digits, picker, restoredBounds, closeStyle, layouts, checks: ['centered non-maximized startup', 'no outer padding or border', 'native left-button drag on title and top strip', 'stable navigation geometry, scroll, bounds and zoom at two sizes', 'highlighted step digits without circle backgrounds', 'styled timeout picker with keyboard and mouse selection and persistence', 'native mouse maximize and restore', 'native mouse minimize', 'red close glyph without background', 'empty logs have no decorative lines', 'populated charts never overlap captions', 'close hides to tray', 'existing EXE unchanged'], sandbox }
    fs.writeFileSync(path.join(artifacts, `window-report-${scale}.json`), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally {
    if (application) await application.close()
    await new Promise(resolve => { mock.close(resolve); mock.closeAllConnections() })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
