# dsh-lead-panel

[![npm version](https://img.shields.io/npm/v/dsh-lead-panel)](https://www.npmjs.com/package/dsh-lead-panel)

## 关于「领导」模板：把 agent 当「人」用

> 这一节是作者的初衷，跟代码无关。
> 「领导 / 工人」是**本插件的用法比喻**；底下真正干活的那套团队机制是官方 Agent Teams
> （见下一节「官方能力 vs 本插件」）。

- 传统的 agent 主要用于**一次性对话**：做完这个「任务」后无法继续进行对话 ——
  这样很浪费 token，缓存命中率也白搭。
- 而「领导」这个模板把这些 agent 当作**单独的对话**使用，并且可以**相互通报、提交进度**。
- 这样子搞的话，到时候要修改，**直接让领导通知对应的（工人）模板**就行。
- 效果类似于（中国古代的）**「分封制」**：
  - 你是最高权力的**「老板」**，可以管理「领导」；
  - 「领导」管理「工人」，可以控制一切的选择和过程；
  - 而「领导」**永远不会控制「老板」**。
- 个人推荐：**「强模型」（领导）**把任务给**「次模型 / 本地模型」（工人）**
  （唯一的缺点可能就是速度问题）。
- 其实本质上就是**让 AI 管外包，但是有「领导」看着**：它可以实时地管理它们，
  甚至可以随时关掉它们 —— 防止出现**「层层外包」**这一情况。

### 三点说明

1. **关于总结**：领导会总结几个关键点用于简单说明（这方面主要给使用者看；
   如果你认为不行，可以让它对任务或者是计划进行修改）。
2. **目前无法切换创建后的（工人）「模型」**（如同上面说的）——
   面板上能切换的只是**领导自己**的模型；想换工人的模型，只能让它重新造一个。
3. **你可以不用「领导按钮」**（我也觉得这个没有用……）。
   按钮只是入口：领导会话说到底就是个普通 DSH 会话，在会话列表里直接打开它、
   跟它说话，效果一样；面板的价值只在于「看得见过程与花费」。

---

DSH 网页版的「领导面板」插件：在输入框的**「完全权限」右边**加一个 `领导` 按钮。
按下去弹出对话框，你和「领导」聊需求 —— 聊完让它总结并派活，运行期间实时显示
token、估算金额、用时和预计剩余时间。

派活时可以选择**工人来源**：官方 Agent Teams 现场组队，或者直接把活交给官方
**Codex / Claude Code** 的 subagent 提供方（都是 DSH 官方能力，本插件只负责发指令和显示过程）。

**领导本身也能换平台**：顶部的「领导平台」可以在 `DSH 官方`、`Codex（GPT）`、`Claude Code`
之间切换 —— 选外部 harness 时，它就是领导，每轮带着对话历史跑一次，「派活」= 直接让它把活干完。

当前版本 **0.7.0** ｜ [更新说明](RELEASE_NOTES.md) ｜ 自检 64 项 + Host 冒烟 64 项全过 ｜ 依赖官方 Agent Teams / 官方 Codex、Claude Code subagent 提供方（实验性）

![DSH 领导面板](https://raw.githubusercontent.com/mutoharohfiqhiabcd-source/dsh-lead-panel/main/images/panel.png)

> 面板长这样：顶部是状态、**「领导平台」切换**、**模型选择**（当前模型名 + provider 胶囊 +
> 推理强度）与 **「工人来源」切换**（官方团队 / Codex / Claude Code / 自动选），中间是计划卡片、
> 对话与工人区，底部是 token / 估算金额 / 用时 / 预计剩余 / 速度五个指标块，
> 以及「总结并派活」「发送」两个按钮。

## 它做什么

| 面板区域 | 内容 |
|---|---|
| 顶部 | 领导当前状态（运行中 / 空闲）、**「领导平台」切换**（DSH 官方 / Codex / Claude Code，见下一节）、**模型下拉框**（列出本机所有 provider/模型，按 provider 分组、模型全名、当前项打勾，选一下即切换），并常显当前模型 + provider 胶囊 + 推理强度；另有打断、重开 |
| 领导平台 | `DSH 官方` / `Codex（GPT）` / `Claude Code` 三选一。DSH 官方是普通会话（模型可切、能组队派活）；外部 harness 让它自己当领导，每轮带着对话历史跑一次，派活 = 直接动手 |
| 工人来源 | `官方团队` / `Codex` / `Claude Code` / `自动选` 四选一。没装官方提供方的来源会置灰，鼠标悬停有提示；选择记在 Host 里，下次打开面板还是它 |
| 计划卡 | 领导总结的四段：`【需求】【效果】【分工】【预计时间】`，自动抽成卡片 |
| 中部 | 与领导的对话；助手消息下面挂它调用的工具名（`spawn_teammate`、`subagent_codex` 等） |
| 工人区 | 领导派出去的工人 AI：名字、状态、负责什么、各自的 token 与金额、最后一句结论；外部 harness 的工人带「外部」标记，完成后显示它的最终答复 |
| 底部 | 实时指标块：`token / 估算金额 / 用时 / 预计剩余 / tok/s`，下面是输入框、「总结并派活」、「发送」 |

「总结并派活」会给领导一条按来源不同的固定指令：让它先按四段回答，再立刻派活 ——
`官方团队` 用 Agent Teams 的 `spawn_teammate` 组队；`Codex` 调一次 `subagent_codex`；
`Claude Code` 调一次 `subagent_claude_code`；`自动选` 则由领导按任务性质自己决定。

## 官方能力 vs 本插件（先说清楚）

> 一句话：**团队是官方的，这个插件是官方的「仪表盘 + 对讲机」。**

| 能力 | 提供方 |
|---|---|
| 团队协作；`spawn_teammate` / `send_message` / `team_task_*` / `list_agents` / `wait_agent` 等工具；成员名册；**共享任务看板**；DSH 自带的「智能体团队」面板 | **官方**（实验性功能，就是设置里那个「智能体团队」开关："启用团队协作、团队工具、成员列表和共享任务看板"） |
| 输入框旁的 `领导` 按钮；面板里的对话、**模型切换**、计划卡片、工人区、token / 估算金额 / 用时 / 预计剩余 | **本插件** |

本插件**不实现任何团队逻辑**：它只是建一个普通 DSH 会话当「领导」，把指令发给它，
再读官方的名册（`ctx.agentTeams.listMembers`）与用量投影，把过程显示出来。
代码里唯一出现 `spawn_teammate` 的地方，是**发给领导的指令文本**，不是它的实现。

**前置条件**：官方那个「智能体团队」开关必须打开，否则插件拿不到 `agentTeams` 服务，
「工人区」会是空的（面板会直接把原因显示出来）。

## 和官方的 Agent Teams 一起用

这个面板本质上是 Agent Teams 的「驾驶舱」：你只跟「领导」说话，造队友、派活、
收结果都由它自己完成（都是官方工具），而你在旁边看得见全过程。

### 1. 本地 AI 现场给你造队友

一句「你派几个子智能体来做」就够了 —— 领导自己起名字、定职责，用 `spawn_teammate`
把队友拉起来（下图里它自己造了「定位分析器 / 翻译 / 配置管理器」三个）：

![让本地 AI 直接创造智能体队友](https://raw.githubusercontent.com/mutoharohfiqhiabcd-source/dsh-lead-panel/main/images/teams-spawn.png)

### 2. 队友之间互相汇报、统一推进

队友不是各干各的：它们能用 `send_message` 互发上下文与结论，领导再用
`wait_agent` 收口、`team_task_*` 协调分工，最后汇总成一份结果：

![智能体队友互相报告与统一推进](https://raw.githubusercontent.com/mutoharohfiqhiabcd-source/dsh-lead-panel/main/images/teams-messaging.png)

### 3. 全队状态一目了然

DSH 自带的「智能体团队」面板列出每个成员与状态（谁是当前会话、谁在跑）：

![智能体团队面板](https://raw.githubusercontent.com/mutoharohfiqhiabcd-source/dsh-lead-panel/main/images/teams-roster.png)

面板里的「工人」区块读的就是同一份名册（`ctx.agentTeams.listMembers`），
额外补上每个队友花掉的 token 与估算金额 —— 即使队友干完活被卸载了，
数字仍然从它的持久日志里折叠出来。

### 4. 队伍可以随着任务长大

人不够就继续造：下图是一支 8 人队伍 —— 一个 `lead` 加七个各管一段的工人
（本地化分析、翻译、配置管理、BepInEx 安装、构建、字符串提取、字体排查）：

![一支 8 人队伍](https://raw.githubusercontent.com/mutoharohfiqhiabcd-source/dsh-lead-panel/main/images/teams-members8.png)

### 5. 派活不是发一段 prompt，而是开一张任务板

领导把活拆成带编号的共享任务（谁能写哪些文件、交付物是什么、验收标准是什么），
每个任务有 owner、有写入范围；成员名册与任务板就是它的施工图：

![成员与共享任务](https://raw.githubusercontent.com/mutoharohfiqhiabcd-source/dsh-lead-panel/main/images/teams-taskboard.png)

### 6. 给工人的指令是一份交付规格，不是一句「你去做」

任务卡里写明目标、环境事实、步骤、交付物（可复用的脚本 + 报告），
甚至规定「严禁修改游戏目录内任何文件」这种边界：

![任务卡：目标 / 环境 / 步骤 / 交付物](https://raw.githubusercontent.com/mutoharohfiqhiabcd-source/dsh-lead-panel/main/images/teams-task-brief.png)

连算法都写死到这种程度 —— 判据、保留规则、丢弃规则、去重、分类，
工人照着做就行，不需要它自己「发挥」：

![任务卡：算法与判据](https://raw.githubusercontent.com/mutoharohfiqhiabcd-source/dsh-lead-panel/main/images/teams-task-spec.png)

这种「规格级」的派活方式正是「领导」模板的价值：**决策留在领导，执行交给工人**，
出问题时能一眼看出是哪一层的责任。

## 把活派给 Codex / Claude Code（0.6.0 新增）

> 一句话：**harness 是官方的，本插件只是把「派给谁」和「它干得怎么样」搬到面板上。**

DSH 官方本来就带两个 subagent 提供方包：

| 官方包 | 面板上的来源 | 模型侧工具 | 本机要求 |
|---|---|---|---|
| `@deepseek-ai/dsh-subagent-codex` | `Codex` | `subagent_codex` | 本机 Codex 已登录（`~/.codex/auth.json`） |
| `@deepseek-ai/dsh-subagent-claude-code` | `Claude Code` | `subagent_claude_code` | 本机先跑一次 `claude` 完成登录 |

它们做的事很单纯：每次运行拉起一个**全新的、无人值守的一次性会话**，把一段任务文本
交给真正的 Codex / Claude Code，等它跑完，只把**最终答案或失败诊断**交回来。
推理过程、工具调用、stderr、工作区 diff 都不会进入领导的上下文（这是官方包的约定）。

### 装法（本机是 DSH 源码检出，所以用 link）

1. 把两个官方包 link 进 profile（它们就在检出里，不用下载）：

   ```powershell
   # <dsh-checkout> 换成你的检出目录
   cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-subagent-codex" "<dsh-checkout>\packages\subagent\subagent-codex"
   cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-subagent-claude-code" "<dsh-checkout>\packages\subagent\subagent-claude-code"
   ```

   若 DSH 是 npm 安装版，用官方的安装方式（`dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex` 等）即可。

2. 在 profile 的 `cordis.patch.yml` 里挂上两个提供方（它们只注册「休眠的提供方」，不启动进程）：

   ```yaml
   - insert:
       - id: subagent-codex
         name: '@deepseek-ai/dsh-subagent-codex'
         config:
           permissionMode: approve-for-me   # 工作区可写，审批由 Codex 自动评审
       - id: subagent-claude-code
         name: '@deepseek-ai/dsh-subagent-claude-code'
         config:
           permissionMode: acceptEdits
   ```

3. 在**领导的 agent preset**（默认 `anchored-standard`）里启用工具行 —— 官方 preset 默认把它们
   `disabled: true` 收着，删掉这一行即可：

   ```yaml
   - id: tool-subagent-codex
     name: '@deepseek-ai/dsh-tool-subagent'
     config: { provider: codex, toolName: subagent_codex, backgroundMode: one-shot, maxDepth: provider-managed }
   - id: tool-subagent-claude-code
     name: '@deepseek-ai/dsh-tool-subagent'
     config: { provider: claude-code, toolName: subagent_claude_code, backgroundMode: one-shot, maxDepth: provider-managed }
   ```

4. 重启 DSH，打开面板，把「工人来源」切到 `Codex`，发需求、点「总结并派活」。

### 你会看到什么

- 领导先给四段计划，然后调用 `subagent_codex` / `subagent_claude_code`；
- 工人区出现一条**带「外部」标记**的记录：状态 running → done（或 failed），
  跑完显示 Codex / Claude Code 的最终答复；
- 它耗时比较真实（冷启动 + 自己的思考），简单的写文件任务大约 1～2 分钟。

![工人来源切到 Codex：工人区显示外部 Codex 的最终结果](https://raw.githubusercontent.com/mutoharohfiqhiabcd-source/dsh-lead-panel/main/images/panel-harness.png)

### 三个限制（官方包本身的约束，不是插件的 bug）

1. **单次任务、不会反问** —— 领导必须把目标、文件、验收标准一次写进 prompt。
2. **不回传 token** —— 所以底部金额 / 速度只统计领导自己；外部 harness 的消耗请以各自订阅为准。
3. **一次一个外部任务** —— 官方提供方是一次性运行；要多人并行请切回 `官方团队`。

### 和 Agent Teams 怎么选

| 场景 | 建议来源 |
|---|---|
| 需要多个人并行、边做边汇报、共享任务看板 | `官方团队` |
| 单点硬活：代码改动、跑构建/测试、命令行操作 | `Codex` |
| 大段文本重构、审阅、写文档、长上下文分析 | `Claude Code` |
| 懒得选 | `自动选` |

## 让 Codex / Claude Code 当「领导」（0.7.0 新增）

> 一句话：**领导也可以不是 DSH 会话** —— 直接把面板顶部的「领导平台」切到 Codex / Claude Code，
> 让它的 GPT / Claude 来当这个领导。

![领导平台切到 Codex（GPT），派活 = 它直接动手](https://raw.githubusercontent.com/mutoharohfiqhiabcd-source/dsh-lead-panel/main/images/panel-leader.png)

| 领导平台 | 领导是谁 | 能干的事 |
|---|---|---|
| `DSH 官方` | 一个普通 DSH 会话（模型可切） | 聊天、出计划、用 Agent Teams 派活给工人；也是 Codex / Claude Code「工人模式」的前提 |
| `Codex（GPT）` | 官方 Codex harness | 每轮带着对话历史跑一次；派活 = 它直接动手做（自己读写文件、跑命令） |
| `Claude Code` | 官方 Claude Code harness | 同上，需要本机先登录 Claude Code |

选外部 harness 当领导时：

- 面板自己保存对话记录，每轮把「角色说明 + 历史 + 新消息」拼成一条 prompt 交给官方提供方；
- 「工人」暂时不适用（它自己就是执行者），按钮从「总结并派活」变成「让它直接干活」，
  点下去它先给四段计划、再直接把活做完；
- 官方提供方只回传**最终答案**，不回传 token，所以底部金额 / 速度显示「—」；
- 切回 `DSH 官方` 就恢复原来的领导 + 工人模式，两边的对话记录各自保留（存在
  `<DSH_HOME>\lead-panel\state.json` 的 `transcripts` 里）。

### 多挂几个「人」

Codex / Claude Code 各自的模型由它们的 profile 行决定（`@deepseek-ai/dsh-subagent-codex` 的
`model` 配置）。想要面板里出现「Codex · GPT-5.1」「Codex · GPT-5.4」这种多人可选，就在 profile
里多挂几个 provider 实例（每个用不同的 `providerName` + `model`），它们会各占一个「领导平台」格；
展示名用插件配置 `leaders` 覆盖：

```yaml
- id: dsh-lead-panel
  config:
    leaders:
      codex: Codex · GPT（原生配置）
      codex-gpt54: Codex · GPT-5.4
      claude-code: Claude Code
```

## 安装

```powershell
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-lead-panel

# 从 GitHub 安装（想跟 main 分支最新代码走就用这条）
dsh plugin --profile web add github:mutoharohfiqhiabcd-source/dsh-lead-panel

# 从本地目录安装
dsh plugin --profile web add D:\1231\dsh-lead-panel

# 或者手工：把本目录复制到 <DSH_HOME>\profiles\web\node_modules\dsh-lead-panel，
# 再往 <DSH_HOME>\profiles\web\cordis.patch.yml 追加：
#
#    - insert:
#        - id: dsh-lead-panel
#          name: dsh-lead-panel
```

npm 包：<https://www.npmjs.com/package/dsh-lead-panel>（MIT）—— 几种装法装的是同一份
代码，装完都要**重启 DSH** 才会加载 Host 半边。

> 想用 `Codex` / `Claude Code`（无论当工人还是当领导），还要按「把活派给 Codex / Claude Code」
> 一节把官方 subagent 提供方挂进 profile；没装时面板会把它们置灰，其它功能不受影响。

`patchReload: live` 的 profile 会在 patch 变化时热重载；否则重启 DSH。
（注意：改 Host 代码后 DSH 会复用已缓存的模块，见文末「改代码时的两个坑」。）

## 配置（profile 的 cordis.patch.yml 里覆盖该行 config）

```yaml
- id: dsh-lead-panel
  config:
    title: 领导                 # 领导会话标题
    cwd: D:\1231                # 领导会话的工作目录
    leadPreset: standard        # 领导会话用哪个 agent preset
    leadModel: { provider: deepseek-official, model: deepseek-flash }
    currency: '¥'
    leaders:                    # 领导平台展示名（可选，见上一节）
      codex: Codex · GPT
    prices:                     # 元 / 百万 token，覆盖内置牌价
      deepseek-flash: { input: 2, cacheRead: 0.2, output: 3 }
```

## 接口（Host 半边，只允许本机访问）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/lead-panel/api/state` | 面板轮询：消息 / 计划 / 工人 / 用量 / 模型清单 / 领导平台（`leaders`、`leader`、`leaderKind`、`leaderRun`）/ 工人来源（`harnesses`、`dispatchHarness`） |
| GET | `/lead-panel/api/health` | 自检：Host 服务可用性（含 `subagents` 提供方列表）、领导平台列表、状态文件位置、build 标记 |
| GET | `/lead-panel/api/debug-session?id=<会话id>` | 排查：直接读某个会话的持久日志，看能不能算出用量 |
| POST | `/lead-panel/api/ensure` | 确保领导会话存在（`{reset:true}` 重开；外部 harness 模式下同时清空面板对话记录） |
| POST | `/lead-panel/api/leader` | `{leader}` 切换领导平台，取 `dsh` 或 `harness:<provider>` |
| POST | `/lead-panel/api/send` | `{text}` 给领导发消息 |
| POST | `/lead-panel/api/dispatch` | `{text, harness}` 总结并派活；`harness` 取 `team` / `codex` / `claude-code` / `auto`，省略则用上次的选择。领导是外部 harness 时忽略该字段，直接让它动手 |
| POST | `/lead-panel/api/model` | `{provider, model}` 切换领导模型（仅 DSH 官方领导可用） |
| POST | `/lead-panel/api/cancel` | 打断领导当前回合 |

领导会话的 id 存在 `<DSH_HOME>\lead-panel\state.json`，重启 DSH 后复用同一个会话。

## 自检

```powershell
npm test                  # 两个套件一起跑
node test/self-check.mjs  # 64 项：纯逻辑 + 浏览器半边
node test/host-smoke.mjs  # 64 项：假 ctx 把 Host 的 HTTP 链路整条跑一遍
```

- `self-check`：用量折叠、金额折算、计划抽取、消息过滤、价目表覆盖、**四种工人来源的派活指令**、
  **从 `tool/call` + `tool/result` 还原外部 harness 工人**、**领导平台列表与外部 harness 的 prompt
  拼装**；以及在假 `window.__ModuleLoader__` + 假 `react` 下求值 `lib/client.js`，确认它注册到
  `conversation.input.left`、组件可构造、防翻译标记在位。
- `host-smoke`：用假 ctx / 假服务驱动真实处理器，验证 `POST /send`、`/dispatch`
  会给 `sessionController.prompt` 传 `AbortSignal`（曾经漏传，面板点了报
  `throwIfAborted`）、`/dispatch` 按 `harness` 生成不同指令且拒绝未知来源、
  **`/leader` 切换后 `/send`、`/dispatch` 走官方 subagent 提供方并写回对话记录**、
  `/state` 能抽出计划卡片与工人用量（含已卸载工人读持久日志、外部 harness 工人）、
  金额按牌价折算、异常以 JSON 返回。

两套都不依赖 DSH，改完先跑。

## 说明与边界

- **团队能力来自官方，不是本插件**：成员名册、共享任务看板、`spawn_teammate` 等工具都由
  官方 Agent Teams（实验性）提供；本插件只读它们、并把过程显示出来 + 提供模型切换与派活入口。
  官方开关关掉时，插件只剩「和领导的对话」与用量显示。
- **Codex / Claude Code 能力也来自官方**：`subagent_codex` / `subagent_claude_code` 是 DSH 官方
  subagent 提供方包暴露的工具，本插件不实现任何 harness 逻辑，只负责生成派活指令、并把
  `tool/call` + `tool/result` 还原成「外部工人」显示出来。官方包一次运行只回传最终答案，
  **不回传 token**，所以金额 / 速度只统计领导自己。
- **外部 harness 当领导是「重放式」的**：官方 subagent 提供方是一次性运行、没有真正的会话
  记忆。面板每轮把「角色说明 + 历史 + 新消息」重新拼成一条 prompt 发过去，所以历史越长 prompt
  越大，它也看不到自己上一轮的工具调用细节（只有正文）；要多人协作仍得切回 `DSH 官方`。
- **Claude Code 需要本机先登录**：官方包调用的是它自己的 CLI；没登录时每次运行都会以
  `product: Claude Code; stage: query-run; invalid-result` 失败，先在终端跑一次 `claude`
  完成登录即可（Codex 同理，需要 `~/.codex/auth.json`）。
- **金额是估算**：DSH 本身只有 token 计数、没有金额模型，所以插件内置一张 DeepSeek
  牌价表（元/百万 token），按 `未命中输入 / 命中输入 / 输出` 三个桶折算；牌价变了改配置即可。
- **预计剩余时间也是估算**：没有历史时长库，用「已完成工人数 × 已用时长」外推；
  工人还没跑完一个时显示「估算中…」。领导在计划里自己给的预计时间会出现在对话正文里。
- 面板依赖 Host 服务 `sessionController`（建会话/发消息/切模型）、`sessionProjections`
  （实时用量）、`agentTeams`（工人名册）与可选的 `subagents`（外部 harness 可用性）；缺哪个
  就在面板上显示对应的错误，不会影响 DSH 其它功能。工人干完活会被卸载，插件改读它的
  **持久日志**折叠 token，所以 settle 之后仍然能看到它花了多少。

## 改代码时的两个坑（实测）

1. **Host 模块按 package.json 的 `name` 缓存。** 改了 `index.js` 后，即使把 profile 的
   `cordis.patch.yml` 里那一行删掉再加回来，DSH 仍然跑旧代码。要么换一个没用过的包名
   （目录名 + `package.json` 的 `name` 一起改），要么重启 DSH。
2. **不要用脚本（PowerShell 等）去改写 profile 的 `cordis.patch.yml`。** 实测一次
   `Get-Content -Raw | Set-Content` 往返会把中文注释行拼成一行，把后面的
   `- id:` / `- insert:` 吞进注释里，于是整段配置静默失效；更糟的是，反复替换这个文件
   会让 DSH 的文件监听器失效，之后**任何** patch 改动（连最小 canary 插件）都不再热加载，
   只能重启 DSH。改这个文件请用编辑器逐行改。


