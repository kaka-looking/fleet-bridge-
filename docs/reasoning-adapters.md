# 推理能力适配与验证（0.1.3）

舰桥按每个模型的能力转换请求。优先级为手动校准、接口元数据、已知型号规则。型号的 `global:` 等路由前缀不影响厂商识别；发给上游的模型 ID 保持完整。

## 当前规则

| 模型 | 可调能力 | Chat 请求 |
| --- | --- | --- |
| DeepSeek Flash / V4 | low / high / max | reasoning_effort + thinking.type |
| GLM 5.3 / Flash | low / high / max，不能关闭 | reasoning_effort + thinking.type=enabled |
| GLM 5.2 | high / max，支持关闭 | reasoning_effort + thinking.type |
| GLM 4.7 | 思考开关 | thinking.type，不伪造多档强度 |
| Kimi K2.5 / K2.6 | 思考开关 | thinking.type |
| Kimi K2.7 Code / K2 Thinking | 始终思考 | 不发送虚构的强度参数 |
| Kimi K3 / K3.1 Pro | low / high / max，不能关闭 | reasoning_effort，不发送 K2 的 thinking 参数 |
| Qwen Plus / 通用混合思考 Qwen3 | 思考开关 | enable_thinking |
| MiniMax M2.x | 始终思考 | 不发送虚构的强度参数 |
| MiniMax M3.1 Flash | low / medium / high / xhigh / max | reasoning_effort |
| 其他接口 | 读取接口声明或手动校准 | 按声明转换 |

已知规则不能代表所有中转平台。相同型号在不同部署中可能有不同参数；接口声明和手动校准可覆盖默认规则。`reasoningEfforts` 不再因型号属于 DeepSeek 而被无条件改写。Codex 能接受的枚举仍取决于客户端版本；将来出现全新枚举需要升级客户端及其 schema，不能向客户端目录随意写字符串。

“始终使用模型最高强度”是可选模式：在模型声明的集合内按 `ultra > max > xhigh > high > medium > low > minimal` 选择；思考开关型开启思考；始终思考且无档位的模型沿用上游行为。未知能力会提示配置，不声称已经选择了最高档。这个模式会覆盖 Codex 对单次请求的低档选择，目录也只显示该模型的最高档。

## 当前 Codex 的 Ultra 行为

Codex app-server `0.164.0-alpha.11.1` 的验证结果：

- `model/list` 可以读取并返回自定义模型的 `ultra`。
- `turn/start(effort=ultra)` 发到舰桥的 HTTP 请求中，`reasoning.effort` 是 `max`。这发生在客户端序列化阶段。
- 跟随模式无法从一个单独的 `max` 判断用户原先点了 Max 还是 Ultra，不擅自混淆它们。
- 最高强度模式独立按接口能力选档，已验证即使客户端发 Max，声明支持 Ultra 的模型也实际收到 `reasoning_effort=ultra`。
- 桌面 Ultra 还有本地显示偏好及客户端功能开关。舰桥只合并相关本地显示偏好，不修改 Codex 安装文件。功能开关关闭时，不保证原生滑块显示 Ultra；最高强度模式仍可正确发送上游参数。

## 模型名重复

部分 Codex 桌面版本将模型与推理档位展开为多组选择，因此同一名字可能出现多次。旧目录还将 `fleet/default` 和实际模型都列为可选项。

0.1.3 隐藏旧默认别名，保留它用于已有对话；新配置直接使用具体模型路由。模型列表对同接口的相同 ID 去重。不同接口的相同模型保留独立入口；显示名去掉 `global:`，完整 ID 在请求与描述中保留。舰桥不能修改 Codex 自身对档位选项的布局。

## 验证边界

- 单元及 HTTP 集成测试验证能力优先级、厂商参数、最高模式、配置保存/恢复、独立 API 路由。
- `scripts/reasoning-smoke.cjs` 启动安装的真实 Codex app-server，在隔离配置中验证 18 轮请求，包含真实客户端的 Ultra→Max 序列化及最高模式的实际 Ultra 转发。上游是严格检查参数的本地测试服务，不代表这些厂商的真实服务都已在线测试。
- `scripts/reasoning-live.cjs` 可对用户已经配置的 DeepSeek 或 GLM 5.3 发送三个极短请求。只记录模型、选档、转发参数、HTTP 状态和用量，临时加密凭据在退出时删除。服务接受参数不等于可以证明其内部采用了多少推理计算。

上述客户端行为以已验证版本为准；其他版本应重新验证模型显示与推理强度的实际转发结果。
