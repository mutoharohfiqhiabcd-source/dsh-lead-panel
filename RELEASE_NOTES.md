# 更新说明

## v0.9.4 — 团队任务浮窗：任意会话触发，右上角自动出现

> 一句话：不用打开「领导面板」——只要任意会话里触发了团队任务（Agent Teams 的
> spawn_teammate，或 Codex / Claude Code 的一次执行），右上角就会浮出团队卡；
> 任务结束 20 秒后自动收起。

### 新增

- **右上角团队任务浮窗**：注册在 DSH 的整页浮层槽位 `shell.overlay`（fixed 右上角），
  不依赖领导面板，也不占输入框位置。
- **数据来自「当前会话」**：客户端从 `uiSession` 拿到当前页面所处会话 id，向
  `GET /lead-panel/api/team?sessionId=` 轮询；不传会话时 Host 会在所有活会话里自动挑
  正在跑团队任务的那个。
- 浮窗复用了团队总览卡：AI 名字 / harness 徽标 / 当前任务 / 阶段 / 成员圆点 + 图例。
- 判定「团队任务」：会话里见过 `spawn_teammate` 的队友（名册），或 `subagent_codex` /
  `subagent_claude_code` 的外部执行（tool/call）。
- **出现与收起**：有成员在跑（或领导在跑）就出现；全部结束后保留 20 秒再自动消失；
  点「×」收起 60 秒（有新活动会立刻重新出现）。
- **新接口**：`GET /lead-panel/api/team?sessionId=`，返回
  `{ active, sessionId, leader, task, stage, members, lastActivityAt }`。

### 说明

- 浮窗只看「当前会话」；切到别的会话会自动换成那个会话的团队任务。
- 只读，不会触发/打断任何任务；Host 半边不可用时浮窗安静地不显示。

### 实测

- `self-check` 116 项、`host-smoke` 107 项全绿（新增：/team 快照（任务 / 阶段 / 队友 +
  Codex 成员 / 领导模型名）、不传会话自动挑选、没有团队活动时为空）。
- 截图：沙盒实例里 6 个成员的团队任务，浮窗在右上角显示 4 个圆点 + 数量 + 展开名字。

## v0.9.3 — 团队总览卡：AI 名字 / harness / 任务阶段 / 成员圆点

> 一句话：面板顶部多了一张卡，一眼看清「谁在干活、干到哪一步、一共几个成员」。

### 新增 UI

- **团队总览卡**（面板顶部）：
  - 左上 AI 名字（模型名），右上对应的 harness 徽标；
  - **背景色按 harness 区分**：DSH 官方（DeepSeek）深蓝 / Codex（GPT）象牙白 / Claude Code 深橙；
  - 「当前任务」（取计划卡的【需求】，没有就用最后一条用户消息）与「阶段」
    （待开始 / 空闲 / 运行中 / 等待成员 / 已完成；外部领导显示「领导运行中」）；
  - 「创造的成员」用彩色圆点表示：空心 = 已创建未运行 / 已结束，粗圈 = 运行中 / 等领导回应，
    实心偏暗 = 已完成该任务；<4 个直接显示名字，≥4 个显示 4 个点 + 数量 + 展开按钮；
  - 卡片底部带一行圆点图例（未运行 / 运行中 / 已完成）。
- **「工人」详情行同步换装**：左侧 harness 色条 + 状态圆点 + harness 徽标，颜色与卡片一致。

### 说明

- 成员圆点跟随成员自己的 harness 上色：DSH 蓝、Codex 象牙白、Claude 橙。
- 纯前端改动（`lib/client.js`），接口与数据不变；自检新增 8 项 UI 标记检查。

### 实测

- `self-check` 108 项、`host-smoke` 96 项全绿。
- 截图里 6 个成员（4 个 DSH + Codex + Claude，含运行中 / 已完成 / 未运行），
  卡片显示 4 个点 + 数量 + 展开按钮，点开显示全部成员名字。

## v0.9.2 — 修掉「分工模式」的死路，顺便把轮询和磁盘扫描省一省

> 一句话：切到「分工」后领导平台不再整行消失（以前会卡在一组永远派不出去的状态里）；
> 面板闲着的时候也不再每 2.5 秒扫一遍磁盘。

### 修复

- **分工模式里「领导平台」整行消失**：0.7 起领导平台只在单平台模式显示，而「分工」要求领导是
  DSH 官方 —— 一旦领导被切成外部 harness 再切到分工，就变成「不能派活、也换不了领导」的死路。
  现在分工模式下领导平台照常显示，外部 harness 置灰并提示原因；**切到分工时自动把领导切回
  DSH 官方**；旧状态里残留的「分工 + 外部领导」组合会在打开面板时自动修正。

### 优化

- **轮询分快慢两档**：领导 / 跨平台任务在跑时 2.5s 一刷，空闲时 6s 一刷。
- **Host 端缓存**（面板每 2.5s 轮询一次，以前每次都重新读盘）：
  - 外部 harness 的配置快照缓存 5s，「换模型」写盘后立即失效；
  - 模型清单缓存 60s，不再反复问 provider；
  - Codex / Claude Code 的可执行文件查找缓存 60s，不再反复扫 PATH 和安装目录。
- **按钮更明确**：「配置」改成「打开配置」；找不到平台命令行时「打开 …」按钮保留但置灰并给出提示，
  不再直接消失。

### 实测

- `self-check` 100 项、`host-smoke` 96 项全绿（新增：分工自动切回 DSH、模型清单缓存命中、
  分工模式领导平台可见、轮询快慢档、「打开配置」文案）。
- 沙盒实例：从「单平台 + Codex 领导」点「分工」→ 领导自动变 DSH 官方，领导平台一行保持可见。

## v0.9.1 — 换掉 GitHub / npm 上的介绍文案

> 一句话：功能与 0.9.0 完全一样，只是把仓库简介和 npm 包描述换成一句更好读的话。

- GitHub 仓库简介、npm 包描述统一为：

  > 在 DSH 输入框旁加一个「领导」按钮：领导可在 DSH 官方 / Codex / Claude Code 之间切换，
  > 模型直接换、平台一键打开；单平台 / 分工 / 会诊 / 流水线四种协作模式，实时看 token、金额与用时。
  > 团队与 harness 能力都来自 DSH 官方，插件只做面板。

- 同时在 GitHub 仓库补了 homepage（指向 npm 页面）和 `agent-teams` / `codex` / `claude-code` 三个 topics。
- 代码、接口、自检项数均无变化。

## v0.9.0 — 换外部领导的模型 + 一键打开对应平台

> 一句话：切到 Codex / Claude Code 当领导时，模型不再只是「由它自己定」——
> 面板读出它真正的模型、给你换，旁边还有「打开 Codex」「配置」两个按钮。

### 新增

- **「领导模型」一行**（外部 harness 当领导时出现）：
  - 模型胶囊显示**它现在真正在用的模型**，读自它自己的配置文件；
  - 点胶囊是快捷下拉（Codex 的选项来自 `model_catalog_json` 指向的模型目录）；
  - `换模型` 也可以手动输入 id，保存后**下一条领导回复就生效**，DSH 不用重启。
- **`打开 Codex` / `打开 Claude Code`**：新开一个终端窗口跑它的 CLI，
  在里面还能用 `/model` 等原生命令；**`配置`** 用记事本打开它的配置文件。
- **工人来源也沾光**：工人来源选到外部 harness 时，多一行「工人模型」，同样可换、可打开。
- **新接口**：`POST /lead-panel/api/harness-model {platform, model}`、`POST /lead-panel/api/open
  {platform, what}`；`/state` 新增 `harnessApps`（当前模型 / 模型选项 / 配置路径 / 可执行文件）。
- 写入很保守：只改 `model` 一个字段，写前备份成 `*.lead-panel.bak`；模型 id 校验字符集；
  `open` 只认白名单平台与动作，且仅允许本机访问。

### 模型来自哪

| 平台 | 配置文件 | 字段 |
|---|---|---|
| Codex | `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`） | `model` |
| Claude Code | `~/.claude/settings.json` | `model`（留空 = 默认） |

> 如果 profile 里的官方 `subagent-codex` / `subagent-claude-code` 行写死了 `model`，
> 那个优先于原生配置；本机 profile 没写，所以面板改完立即生效。

### 实测

- 沙盒实例：领导切到 Codex 后，面板读到 `deepseek-v4-flash`（`custom · api.deepseek.com`），
  下拉里能选 `deepseek-v4-pro`；改完 `config.toml` 的 `model` 变成新值、`model_provider` 与
  `base_url` 原样保留、`.bak` 落在旁边；`cmd /c start` 起 Codex 的窗口确认能拉起进程。
- `self-check` 96 项、`host-smoke` 92 项全绿。

## v0.8.0 — 跨平台协作：分工 / 会诊 / 流水线

> 一句话：同一个任务，可以交给多个平台一起处理，方式随你挑 —— 面板顶部多了「协作模式」。

### 新增

- **「协作模式」四选一**（模式下面自带一句说明）：
  - `单平台`：原来的用法（领导聊天 / 派活给一个工人来源）；
  - `分工`：领导（DSH 官方）把同一个任务拆给勾选的多个平台，各干一部分，最后汇总；
  - `会诊`：同一任务**并行**发给勾选的每个平台各做一遍，结果并排对比；
  - `流水线`：按勾选顺序**串行**执行，上一步的最终答复写进下一步的 prompt。
- **参与平台多选**：`DSH 官方` / `Codex` / `Claude Code`，没挂载的自动置灰；顺序即流水线顺序。
- **结果区**：每个平台的状态、耗时、最终答复；跑完写进 `state.json` 的 `lastRun`，刷新不丢，
  「重开」清空。外部平台不回传 token，金额仍只覆盖 DSH 自己的部分。
- **新接口**：`POST /lead-panel/api/mode`、`/picks`、`/run`；`/state` 新增
  `modes` / `mode` / `platforms` / `picks` / `lastRun`。
- 这次把 **0.7.0 的领导平台**一并带上 npm（npm 上此前只到 0.6.0）。

### 实测

- 会诊（DSH 官方 + Codex）：并行作答，两个平台各自返回，约 5.7s / 3.4s；
- 流水线（DSH → Codex）：DSH 创建文件并写交接说明，Codex 接着做字节级校验，文件内容正确；
- `self-check` 72 项、`host-smoke` 76 项全绿。

## v0.7.0 — 领导也能选平台：DSH 官方 / Codex（GPT）/ Claude Code

> 一句话：不止工人能选，**领导本身也能换人** —— 直接把「领导平台」切到 Codex，
> 让 Codex 里的 GPT 来当这个领导。

### 新增

- **「领导平台」三选一**（面板顶部）：`DSH 官方` / `Codex（GPT）` / `Claude Code`，选择记在
  `<DSH_HOME>\lead-panel\state.json`。不是 DSH 官方的平台会以「外部 harness」的方式工作。
- **外部 harness 当领导**：官方 subagent 提供方是一次性运行，所以面板自己维护这段对话——
  每轮把「角色说明 + 历史 + 新消息」拼成一条 prompt 交给官方 `ctx.subagents.start()`，
  把最终答复记回对话记录。派活 = 直接让它把活干完（它自己读写文件、跑命令）。
- **界面适配**：外部 harness 当领导时，模型下拉变成「模型由它自己定 + 平台名」，
  工人区隐藏，按钮变成「让它直接干活」，金额 / 速度显示 `—`，并提示「外部 harness 不回传 token」。
- **`POST /lead-panel/api/leader`** 切换领导平台；`/state` 新增 `leaders` / `leader` /
  `leaderKind` / `leaderRun`；`/ensure {reset:true}` 在外部 harness 模式下同时清空面板对话记录。
- **配置 `leaders`**：覆盖领导平台展示名；多挂几个官方 provider 实例（不同 `providerName` +
  `model`）就会在面板上各占一个「领导平台」格，用 `leaders` 给它们起名字。
- 领导 prompt 拆成「角色说明」与「派活规格」两段；派活时强制把四段计划与结果放进同一条最终回复
  （面板只读最后一条回复）。

### 实测

- 沙盒实例里把领导切到 Codex 后：闲聊能回（「我是领导，当前运行在 Codex 中，底层模型是 GPT-5」），
  派活能直接建文件并回来汇报，四段计划卡正常显示。
- `self-check` 64 项、`host-smoke` 64 项，全绿。

## v0.6.0 — 把活派给官方 Codex / Claude Code

> 一句话：面板多了「工人来源」，领导可以直接把活交给真正的 **Codex** 或 **Claude Code**，
> 而不再只能派给 Agent Teams 里现造的工人。

### 新增

- **「工人来源」四选一**：`官方团队` / `Codex` / `Claude Code` / `自动选`，选中项记在 Host
  状态里（`<DSH_HOME>\lead-panel\state.json`），下次打开面板还是它。
- **派活指令按来源区分**：`dispatch` 接口新增 `harness` 参数；`team` 仍走 `spawn_teammate`，
  `codex` / `claude-code` 则要求领导只调一次官方工具（`subagent_codex` / `subagent_claude_code`），
  并把任务写全（外部 harness 是单次任务、不会反问）。
- **外部工人实时显示**：从会话事件里的 `tool/call` + `tool/result` 还原 Codex / Claude Code
  的运行记录 —— 工人区出现带「外部」标记的卡片，状态 running → done / failed，跑完显示它的
  最终答复；`/state` 同时在 `harnesses` 里给出每个来源是否可用（读 `ctx.subagents.list()`）。
- **可用性置灰**：没装官方提供方的来源会置灰并提示，不会让人点了个寂寞。
- `/health` 增加 `subagents` 服务与提供方列表、build 标记更新到 `2026-10-22T14:10`。

### 能力来源（重要）

`subagent_codex` / `subagent_claude_code` 是 **DSH 官方 subagent 提供方包**暴露的工具，
本插件不实现任何 harness 逻辑：它只生成派活指令、并在面板上把过程还原出来。
装法与限制见 README 的「把活派给 Codex / Claude Code」一节（需要把官方包 link 进 profile、
在 preset 里启用工具行；Claude Code 需先在本机登录一次）。

### 自检

- `self-check` 49 项、`host-smoke` 47 项，全绿。

## v0.5.2 — 首次在 npm 上架

代码与 0.5.0 / 0.5.1 完全一致，只是终于发到了 npm。

**为什么不是 0.5.0 或 0.5.1**：`dsh-lead-panel` 曾在 2026-10-13 短暂上架过 0.5.0 与 0.5.1，
随后整包被撤销（npm 的 24 小时冷却 + 已撤销版本号不可复用）。所以首次正式上架用了 0.5.2，
之后按正常版本号递增。

- npm：<https://www.npmjs.com/package/dsh-lead-panel>
- 安装：`dsh plugin --profile web add dsh-lead-panel`
- 内容包含 README 的「官方能力 vs 本插件」一节与「关于『领导』模板」开场白。

## v0.5.1 — 文档同步

只改文档，代码与 0.5.0 完全一致。

- **新增「官方能力 vs 本插件」一节**：说清哪些是官方 Agent Teams 的（团队协作、`spawn_teammate`
  等工具、成员名册、共享任务看板、DSH 自带的「智能体团队」面板），哪些是本插件的
  （输入框按钮、对话、模型切换、计划卡、工人区、token / 金额 / 预计剩余）；
  并注明**前置条件**是官方那个「智能体团队」开关必须打开。包描述也补了同样的说明。
- README 把「关于『领导』模板」一节挪到**开头**当开场白（讲为什么要把 agent 当「人」用：
  一次性对话浪费 token 与缓存命中 → 当独立会话用、可相互通报 → 分封制 / 强模型带弱模型 /
  防止层层外包，附三点说明）。该节已注明「领导 / 工人」只是本插件的用法比喻。
- 安装方式补上 **npm**：`dsh plugin --profile web add dsh-lead-panel`
  （<https://www.npmjs.com/package/dsh-lead-panel>），顶部加 npm 版本徽章。
- 这次发版的主要目的：让 **npm 包页的 README 与 GitHub 一致**（npm 不允许覆盖已发布版本，
  只能发新版本同步）。

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
# npm（推荐）
dsh plugin --profile web add dsh-lead-panel

# GitHub
dsh plugin --profile web add github:mutoharohfiqhiabcd-source/dsh-lead-panel
```

npm 包：<https://www.npmjs.com/package/dsh-lead-panel>

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
