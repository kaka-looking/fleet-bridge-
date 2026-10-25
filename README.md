# 舰桥 Fleet Bridge

一个面向 Codex 桌面程序的模型接入工具，管理 DeepSeek、GLM、Kimi、通义、MiniMax 及其他 OpenAI 兼容模型。

## 直接使用

从 GitHub Releases 下载 `Fleet-Bridge-版本号-Setup.exe` 安装版，安装后可在程序内检查、下载并重启更新。首次迁移时，先在托盘菜单选择「退出舰桥」，再安装新版。便携版 `Fleet-Bridge-版本号-Windows.exe` 保留手动更新方式。使用程序无需安装 Node.js 或 Rust；需要刷新模型目录时，完全退出并重新打开 Codex。

1. 点击「添加服务商」，选择厂商并填写自己的 API Key。模型 ID 可以手动填写，或点击「从接口读取」。
2. 点击「保存并连接」，自动保存服务商、备份 Codex 原配置并写入本地代理和全部已配置模型，同时验证模型的工具调用能力。接入失败时会明确提示，已保存的服务商不会丢失。
3. 对于之前已保存但尚未接入的服务商，点击「一键接入 Codex」。添加自定义服务商后，未配置的 DeepSeek、GLM、Kimi 入口仍会保留。
4. **完全退出并重新打开 Codex**，在模型选择器中选择对应的厂商模型。

0.1.6 增加 Windows 安装版、GitHub Releases 自动更新和 GitHub Actions 发布流程。正式标签推送后构建并发布新版本；程序自动检查、后台下载，用户选择重启安装。首次发布步骤见 [上传 GitHub 与自动更新](docs/github-release.md)。本地未配置仓库的构建不会查询虚构更新源。

0.1.5 统一界面 Logo、任务栏、托盘和程序文件图标。更新不清空已保存的服务商、密钥和连接记录。

0.1.4 修正连接记录的结果判定。日志变化与验证范围见 [0.1.4 更新说明](docs/release-0.1.4.md)。

0.1.3 隐藏重复的「默认航线」入口，新配置直接使用具体模型。旧对话中的 `fleet/default` 仍可使用，并跟随舰桥的默认服务商；明确指定的模型继续使用对应服务商。新增或删除模型后，需要重新打开 Codex 刷新模型列表。模型的 `global:` 路由前缀不再重复展示，完整 ID 仍用于请求。

0.1.2 将「Codex 原配置」与各个舰桥 API 合并显示：原配置的 GPT 模型沿用原接口、请求头和凭据，DeepSeek、GLM、Kimi 等模型分别走自己的接口。服务商卡片和原配置入口都有独立开关；停用后从目录移除，并拒绝旧对话继续调用该接口，配置与密钥保留。更改后重开 Codex 刷新列表。「恢复原来的连接」仍恢复接入前的 Codex 配置，舰桥里保存的 API 不删除。

原接口支持环境变量密钥、配置中的 Bearer Token、`auth.json` API Key 和已有 ChatGPT 访问令牌，以及自定义请求头和查询参数。环境变量需要在运行舰桥的进程中可用；已有 ChatGPT 令牌过期时需要在 Codex 中重新登录。其他命令式认证和系统钥匙串认证暂未适配。

窗口右上角关闭按钮会把程序收起到系统托盘，本地代理继续运行。需要退出时，在系统托盘图标右键菜单中选择「退出舰桥」。使用第三方模型期间请保持舰桥运行。

点击工作台里的「恢复原来的连接」可恢复接入前的 Codex 配置，随后重开 Codex。

## 已实现

- 服务商添加、编辑、删除；模型列表读取、手动配置和默认服务商切换。
- Responses API 与 Chat Completions 协议转换，支持 JSON 与 SSE 流式输出。
- 函数调用、多轮工具结果、命名空间工具、`additional_tools` 和 `apply_patch` 等自由文本工具的适配。
- 原生 Responses 上游透传，支持自定义 API 基础地址。
- Codex 模型目录生成；`fleet/default` 默认别名与服务商独立的模型路由。
- Codex 配置备份、恢复，以及恢复时保留接入后新增的无关配置。
- Windows 系统加密存储 API Key；本机代理独立令牌；密钥不返回前端。
- 请求耗时、Token 和错误元数据记录；不把对话正文写入日志。
- 记录趋势图、搜索与状态筛选、排序、分页、错误详情和 CSV 导出。
- 将上游明确失败、连接中断、超时、取消、输出未完成和本地处理异常分别记录；详情保留上游 HTTP 状态、完成结果、请求 ID、网络错误码及异常阶段。
- 网格与列表视图、默认服务商偏好、浅色/深色/跟随系统外观、30–600 秒请求超时设置。
- 系统托盘、开机启动设置、代理启停和端口配置。

安装版从构建时写入的 GitHub 仓库获取正式更新，启动后及每 6 小时自动检查，支持后台下载、进度、重试和重启安装；自动检查及下载开关在设置中保存。安装前检查模型请求是否已结束。0.1.5 及更早版本需要手动安装一次支持更新的版本；便携版提供发布页入口。请求数、模型数和 Token 均来自本地真实记录。

连接记录中的每条数据代表一次本地请求尝试，Codex 的重试分别记录。「响应完成率」反映舰桥完整接收并处理响应的比例，排除已取消请求，不等同于上游 API 成功率。HTTP 200 只表示已收到响应头；后续流式输出可能仍中断。未收到用量时显示「—」，中途已收到的用量会保留。旧记录没有保存的上游状态保持未知，仅在读取时对 `fetch failed` 等历史错误重新分类，不重写历史文件，也不自动重发生成请求。

## 服务商与兼容性

预设模型 ID 只是起点，服务商的可用模型、API 地址及订阅计划会变化。请以你账号的实际接口为准；Coding Plan 可能需要专用地址和专用密钥。编辑时清空密钥输入框会保留已保存密钥。

Chat Completions 模式通过本地转换适配 Codex；原生 Responses 模式直接转发协议。后端模型需要具备可靠的 Function Calling 能力，才能完成文件编辑、终端操作等编码任务。工具参数会在收齐后发给 Codex，文本会实时流式输出。

上下文长度与图片输入能力按模型自动适配：优先使用 `/models` 返回的能力数据，其次使用已知模型参数；未知模型保留已有设置。高级设置包含 API 协议与思考模式，并可展开「按模型校准推理能力」，为未返回能力的接口设置真实支持的档位与开关参数。

思考模式选择「跟随 Codex 推理强度」后，在 Codex 中调节模型支持的推理档位。DeepSeek Flash / V4 支持 `low`、`high`、`max`；`medium` 是上游的 `high` 别名，因此不重复显示。旧的 `deepseek-chat` / `deepseek-reasoner` 别名需由上游声明支持档位。更新已有连接时，在舰桥中点击「一键接入 Codex」或「打开 Codex」，再完全退出并重新打开 Codex，以刷新模型目录及旧的默认强度。连接记录详情显示实际向上游发送的推理强度。

0.1.3 补齐 GLM 5.3 的 `low/high/max`、GLM 5.2 的 `high/max`、Kimi K3 的 `low/high/max`，并按各自协议处理 Kimi K2.x、GLM 4.7、Qwen 的思考开关。自定义接口中的模型名也能识别；接口元数据与手动校准优先于型号规则。不同版本的能力与已知边界见 [推理适配说明](docs/reasoning-adapters.md)。

新增「始终使用模型最高强度」：接口声明支持 Ultra 就发送 `ultra`，否则选其支持的最高档；仅支持开关的模型开启思考。未知能力会提示配置。已验证的 Codex 版本会将 `turn/start(effort=ultra)` 序列化为 `max`；跟随模式保留这个实际输入，最高模式则独立按模型声明选择，已通过真实 Codex 验证可以向上游发送 `ultra`。

Codex 桌面端另有「可用推理档位」偏好，当前桌面版本默认没有启用 `max`。0.1.2 接入时会为支持 Max 的模型补上这个偏好，并记录恢复信息。已有连接也可先完全退出 Codex，再点击舰桥的「修复 Max 显示」，然后重新打开 Codex；运行中的桌面程序可能用内存里的旧偏好覆盖磁盘，因此退出顺序很重要。也可直接在 Codex 设置的「模型功能 → 可用推理档位」中勾选 Max。

厂商原生网页搜索、Computer Use、图像生成、音频等额外能力是否可用取决于上游模型、协议和 Codex 版本。Chat 模式使用 Codex 的本地上下文压缩；不伪造远程 compact 响应。不支持 Responses 后台任务。

本项目已使用 Codex `0.164.0-alpha.11.1` 验证模型可见性、同一对话内的推理档位切换，并通过本地模拟模型完成真实 `apply_patch` 文件创建。0.1.1 也通过 DeepSeek 接口验证了 `low/high/max` 三档请求均成功，最大档返回非零推理 Token；不同账号、转发服务的实际能力仍以接口为准。

## 本地数据

默认在 Electron 用户数据目录下的 `data` 文件夹保存：

- `state.json`：服务商、系统加密后的密钥、设置与最近 300 条请求元数据。
- `codex-models.json`：生成的 Codex 模型目录。
- `codex-backup.json`：原始 Codex 配置及恢复元数据，仅在存在接入备份时保留。
- `original-models.json`：原接口的模型目录缓存，不含 API Key。

在「设置 → 打开数据目录」中访问。API Key 使用 Electron `safeStorage`，Windows 对应 DPAPI，复制到其他系统账户后无法直接解密。

默认读取 `CODEX_HOME`，未指定时使用用户目录下的 `.codex`。在点击「保存并连接」、接入或恢复时修改其中的 `config.toml`；不修改 `auth.json`、聊天记录、沙箱或审批设置。配置重新序列化可能调整注释和排版，未发生其他编辑时可按原始内容恢复。

接入时按目录合并 `.codex-global-state.json` 中的 `enabled-reasoning-efforts` 偏好，并在声明支持 Ultra 时开启相关本地显示偏好，保留其他桌面状态；恢复时撤回舰桥加入的变化。Ultra 是否出现在滑块中仍受 Codex 自身功能开关影响；最高强度模式的上游转发不依赖该显示开关。

本地接口仅绑定 `127.0.0.1`，默认端口 `24680`。`/health` 用于存活检查；模型与 Responses 接口需要独立本机令牌。修改端口前先恢复 Codex 原连接，然后保存端口并重新接入。

对使用 `previous_response_id` 的 Chat 请求，进程内最多缓存 64 条上下文，最长 30 分钟、总计最多约 32 MB，重启后清除；完整对话请求不依赖该缓存。

## 开发

建议 Node.js 22.12 或更新版本。

```powershell
npm install
npm run dev
```

```powershell
npm test
npm run build
npm run test:desktop
npm run test:visual
npm run test:reasoning
npm run test:coexistence
npm run test:logs-branding
npm run test:updates
npm run test:updates-ui
npm run dist
npm run test:portable
```

桌面验收会创建隔离的数据目录和 Codex 配置，启动模拟模型，自动操作界面，并生成 `artifacts/` 截图与报告。如果找到可用的 Codex CLI，还会通过真实 Codex 执行文件编辑。可通过 `FLEET_CODEX_CLI` 指定 CLI 路径。

视觉验收在 1672×941 尺寸下生成四个页面的截图，并检查深浅色切换及 1100×740 窗口布局。使用隔离测试数据，不写入日常使用的配置。截图位于 `artifacts/ui-*.png`。

`npm run test:logs-branding` 检查新旧日志分类、未知用量、详情、CSV 和透明图标，并验证深色与小窗口中的字标边界。设置 `FLEET_EXECUTABLE` 可对打包后的 `win-unpacked/Fleet Bridge.exe` 执行相同检查。

推理强度验收需要设置 `FLEET_CODEX_CLI`：启动真实 Codex app-server，验证 DeepSeek、GLM、Kimi、Qwen 和接口声明的 Ultra，共 18 轮请求；操作编辑器保存手动档位和最高模式，并检查上游真实收到的参数及连接记录。报告位于 `artifacts/reasoning-report.json`。

`npm run test:coexistence` 验证原 GPT 连接与三个独立 API 的目录、凭据、真实 HTTP 分流、界面启停及精确恢复。

`scripts/reasoning-live.cjs` 是单独启用的在线检查：显式设置 `FLEET_LIVE_STATE` 指向现有数据文件后，使用活动服务商发送三次请求，每次最多 48 个输出 Token，会产生上游用量。可用 `FLEET_LIVE_MODEL` 指定活动服务商内已保存的 GLM 5.3 或 DeepSeek 型号。它使用隔离数据目录，完成后移除复制的加密凭据，不改动日常 Codex 配置；结果位于 `artifacts/reasoning-live-report.json` 或 `artifacts/reasoning-live-glm-report.json`。0.1.3 对已配置的 GLM 5.3 完成三档在线检查，均返回 HTTP 200；这只证明接口接受参数，不推断内部推理质量。

可通过 `FLEET_DATA_DIR` 与 `FLEET_CODEX_HOME` 隔离程序数据和 Codex 配置，用于测试，不需要改动日常使用的配置。

公开源码、首次发布、版本号及 GitHub Actions 配置参见 [上传 GitHub 与自动更新](docs/github-release.md)。发布构建需要实际仓库地址；正式标签必须与 `package.json` 一致。工作流在公开 Release 前核验完整更新文件，不覆盖已发布版本。

源码结构：

```text
src/main/            Electron 主进程、本地代理、存储、配置管理
src/main/translate.ts  Responses / Chat 请求与 SSE 转换
src/preload/         隔离的桌面 IPC 接口
src/renderer/src/    React 界面与 CSS
src/renderer/src/assets/  界面插画、服务商图标与 Logo
src/shared/          类型定义和厂商预设
tests/               协议与配置测试
scripts/             桌面端到端验收
```
