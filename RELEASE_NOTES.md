# 更新说明

## v0.5.0 — 首个公开版本

「领导面板」插件：DSH 网页版输入框里多一个 `● 领导` 按钮，按下去就能和「领导」
对话、切换它的模型，并由它把活派给工人 AI；运行期间实时显示 token、估算金额、
用时和预计剩余时间。

### 面板

- **模型切换**：下拉框列出本机全部 provider / 模型（读 `ctx.llm.listProviders()`
  与 `listModels()`），选一下即切换领导会话使用的模型（走 `sessionController.selectModel`）。
  下拉按 provider 分组、显示模型全名与 `provider · 模型id`、当前项打勾 —— 因为
  `DeepSeek` 与 `DeepSeek Account` 会提供同名模型，原生 select 在深色主题下根本分不清；
  头部常显当前模型名 + provider 胶囊 + 推理强度（`reasoningEffort`）。
- **对话**：和领导的完整来回；它的工具调用（`spawn_teammate` 等）以小标签挂在消息下面。
  运行时上下文、AGENTS.md、技能清单这些注入消息在 Host 侧就被过滤掉，不会刷屏。
- **计划卡片**：领导按「四段式」回答后（`【需求】【效果】【分工】【预计时间】`），
  面板把四段抽出来单独渲染成卡片。
- **工人区**：领导派出去的每个工人 AI —— 名字、状态、负责什么、各自的 token 与金额、
  最后一句结论。工人干完活会被卸载，插件改读它的**持久日志**折叠用量，所以 settle
  之后照样算得出来。
- **指标条**：token / 估算金额 / 用时 / 预计剩余 / 速度（tok/s）。
- **操作**：「总结并派活」发一条固定指令，让领导总结需求、效果、分工、预计时间，
  并立刻用 `spawn_teammate` 派活；另有「发送」「打断」「重开」「关闭」。

### 实现要点

- 只有一个会话概念：插件用 `sessionController.create` 建一个标题为「领导」的普通
  DSH 会话，之后所有对话都走 `prompt` / `resolveAgent + followup`，会话 id 记在
  `<DSH_HOME>\lead-panel\state.json`，重启 DSH 后复用同一个会话。
- 用量：优先读 `tokenUsage` 投影，投影没跟上或会话已卸载时回退折叠持久日志里
  每条 `assistant/message.usage`。
- 金额：DSH 本身只有 token 计数、没有金额模型，所以插件内置一张 DeepSeek 牌价表
  （元/百万 token，三档：未命中输入 / 命中输入 / 输出），可在 profile 配置里覆盖。
  面板上显示的是**估算值**。
- 预计剩余时间：没有历史时长库，用「已完成工人数 × 已用时长」外推；一个工人都没
  跑完时显示「估算中」。领导自己在计划里给的预计时间会出现在对话正文与计划卡片里。
- 界面整块带 `translate="no"`：否则 Chrome 自动翻译会把 `deepseek-flash` 翻成
  「深度寻道闪避」、`token` 翻成「令牌」，面板没法看。

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/lead-panel/api/state` | 面板轮询：消息 / 计划 / 工人 / 用量 / 模型清单 |
| GET | `/lead-panel/api/health` | 自检：Host 服务可用性、状态文件位置、build 标记 |
| GET | `/lead-panel/api/debug-session?id=` | 排查：直接读某个会话的持久日志算用量 |
| POST | `/lead-panel/api/ensure` | 确保领导会话存在（`{reset:true}` 重开） |
| POST | `/lead-panel/api/send` | `{text}` 给领导发消息 |
| POST | `/lead-panel/api/dispatch` | `{text}` 总结并派活 |
| POST | `/lead-panel/api/model` | `{provider, model}` 切换领导模型 |
| POST | `/lead-panel/api/cancel` | 打断领导当前回合 |

只允许本机（loopback）访问。

### 安装

```powershell
dsh plugin --profile web add github:mutoharohfiqhiabcd-source/dsh-lead-panel
```

或手工：把本目录复制到 `<DSH_HOME>\profiles\<profile>\node_modules\dsh-lead-panel`，
再往该 profile 的 `cordis.patch.yml` 追加

```yaml
- insert:
    - id: dsh-lead-panel
      name: dsh-lead-panel
```

### 自检

```powershell
npm test
```

两套断言，都不依赖 DSH：

- `test/self-check.mjs`（25 项）：Host 纯逻辑（用量折叠、金额折算、计划抽取、消息
  过滤、价目表覆盖）+ 浏览器半边（假 `window.__ModuleLoader__` / 假 react 下注册槽位、
  组件可构造、防翻译标记在位）。
- `test/host-smoke.mjs`（29 项）：假 ctx / 假服务驱动真实 HTTP 处理器 —— 验证
  `POST /send`、`/dispatch` 会给 `sessionController.prompt` 传 `AbortSignal`（曾经漏传，
  面板点「发送」直接报 `Cannot read properties of undefined (reading 'throwIfAborted')`）、
  `/state` 能抽出计划卡片与工人用量（含已卸载工人读持久日志）、金额按牌价折算、
  异常以 JSON 返回。字符串形式的计数会被强制转成数字而不是拼接。

### 已知边界

- 金额与预计剩余时间都是**估算**，不是账单。
- 依赖 Host 服务 `sessionController` / `sessionProjections` / `agentTeams`；缺哪个
  面板会显示对应错误，不影响 DSH 其它功能。
- 改 Host 代码后，DSH 会按 `package.json` 的 `name` 复用已缓存的模块：换个没用过的
  包名或重启 DSH 才会生效。
