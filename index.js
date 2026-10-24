// ============================================================================
// dsh-lead-panel —— DSH「领导面板」插件（Host 半边）
// ----------------------------------------------------------------------------
// 给浏览器半边提供接口，核心是三种能力：
//
//   1) 一个专职的「领导」会话：用户和它对话、由它把需求变成计划，再用
//      Agent Teams 的 spawn_teammate 把活派给工人 AI。
//   2) 模型切换：列出本机所有 provider/模型，随时改「领导」用哪个。
//   3) 实时用量：领导 + 所有工人的 token、估算金额、用时、预计剩余时间。
//
// 路由（都挂在本机 loopback，非本机请求一律 403）：
//   GET  /lead-panel/api/state      面板轮询：消息/工人/用量/模型清单
//   GET  /lead-panel/api/health     自检：哪些 Host 服务可用
//   POST /lead-panel/api/ensure     确保「领导」会话存在（reset=1 则重开）
//   POST /lead-panel/api/send       { text }            给领导发一条消息
//   POST /lead-panel/api/dispatch   { text }            让它总结+派活
//   POST /lead-panel/api/model      { provider, model } 切换领导的模型（DSH 领导）
//   POST /lead-panel/api/harness-model { platform, model } 换外部 harness 领导的原生模型
//   POST /lead-panel/api/open       { platform, what }   打开对应平台 / 它的配置文件
//   POST /lead-panel/api/cancel                        打断领导当前回合
//
// 只用 ctx 上的服务（sessionController / agents / sessions / llm /
// sessionProjections / agentTeams），不直接 import DSH 内部包，避免版本漂移。
// ============================================================================

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export const name = 'dsh-lead-panel'
/** 没有必需服务：缺哪个就降级哪个，headless profile 下也不会报错。 */
export const inject = []

const ROUTE = '/lead-panel/api'
const STATE_VERSION = 1
const MAX_MESSAGES = 40
const WORKER_TEXT_LIMIT = 240

/**
 * 外部 harness：官方 subagent 提供方（Codex / Claude Code）暴露给模型的工具名。
 * 它们由 DSH 官方包实现，本插件只负责「把活派过去 + 把过程显示出来」。
 */
const EXTERNAL_HARNESSES = [
  { id: 'codex', label: 'Codex', tool: 'subagent_codex', provider: 'codex' },
  { id: 'claude-code', label: 'Claude Code', tool: 'subagent_claude_code', provider: 'claude-code' },
]
const EXTERNAL_BY_TOOL = new Map(EXTERNAL_HARNESSES.map(item => [item.tool, item]))
/** 面板可选的全部「工人来源」。team = 官方 Agent Teams；auto = 让领导自己挑。 */
const HARNESS_MODES = [
  { id: 'team', label: '官方团队' },
  ...EXTERNAL_HARNESSES.map(({ id, label }) => ({ id, label })),
  { id: 'auto', label: '自动选' },
]

/** 四段式回答的统一约束（抽出问题、效果、分工与时间，面板才能渲染计划卡）。 */
const PLAN_SPEC = `你现在是指挥层的「领导」。请先严格按下面四段用中文回答（只写这四段），然后在同一回合里把工作派出去：

【需求】用户到底要什么（一句话）
【效果】做完之后用户能看到什么
【分工】谁去干 + 它负责什么 + 预计耗时，一行一个
【预计时间】整件事大概要多久
`

/** 派活方式说明：不同「工人来源」对应不同的官方能力。 */
const HARNESS_RULES = {
  team: `
派活要求：用 spawn_teammate 给每个工人起名字（lower-kebab-case），prompt 写清验收标准；每个工人只做一件边界清晰的事；能并行就并行；工人之间不要重叠改同一个文件。`,
  codex: `
派活要求：这段工作只有一个执行者——官方 Codex（工具名 \`subagent_codex\`）。四段写完立刻调用一次 \`subagent_codex\`，用它的 prompt 把任务写全：目标、要改的文件/目录、验收标准、做完怎么验证。Codex 是单次任务、不会反问，所以它需要的信息必须一次给全。工具返回后，用一两句话向用户汇报它的最终结果；不要调用 spawn_teammate，也不要再把同样的活派给别人。`,
  'claude-code': `
派活要求：这段工作只有一个执行者——官方 Claude Code（工具名 \`subagent_claude_code\`）。四段写完立刻调用一次 \`subagent_claude_code\`，用它的 prompt 把任务写全：目标、要改的文件/目录、验收标准、做完怎么验证。Claude Code 是单次任务、不会反问，所以它需要的信息必须一次给全。工具返回后，用一两句话向用户汇报它的最终结果；不要调用 spawn_teammate，也不要再把同样的活派给别人。`,
  auto: `
派活要求：你自己判断用哪种官方执行方式，只选一种：① 代码改动、命令行、跑构建/测试 → \`subagent_codex\`；② 大段文本重构、审阅、写文档、需要长上下文 → \`subagent_claude_code\`；③ 任务能拆成多个人并行 → 用 spawn_teammate 组队。外部 harness 是单次任务、不会反问，prompt 要一次写全目标/文件/验收标准；工具返回后向用户汇报最终结果。`,
}

/**
 * 生成一版派活指令。
 * @param {string} harness 工人来源：team / codex / claude-code / auto
 */
function dispatchInstruction(harness) {
  const mode = HARNESS_MODES.find(item => item.id === harness) ?? HARNESS_MODES[0]
  return `${PLAN_SPEC}${HARNESS_RULES[mode.id]}\n\n用户的原始需求如下：\n`
}

// ── 跨平台协作（0.8.0）：分工 / 会诊 / 流水线 ────────────────────────────────
//
// 统一的一套「平台」概念：DSH 官方（Agent Teams / spawn 子代理）、Codex、Claude Code。
//   · 分工   —— 领导（DSH）把同一任务拆给勾选的多个平台里的工人，最后汇总；
//   · 会诊   —— 同一任务同时发给勾选的每个平台各做一遍，结果并排展示；
//   · 流水线 —— 按勾选顺序依次执行，上一步结果作为下一步的输入。
// 外部平台都走官方 subagent 提供方的一次性运行；面板只负责编排与展示。

const COLLAB_MODES = [
  { id: 'single', label: '单平台', hint: '原来的用法：领导（任意平台）聊天；DSH 领导还能派给一个工人来源。' },
  { id: 'split', label: '分工', hint: '领导（DSH 官方）把同一个任务拆给勾选的多个平台，各干一部分，最后汇总。' },
  { id: 'consult', label: '会诊', hint: '同一个任务同时发给勾选的每个平台，各答一遍，并排对比结果。' },
  { id: 'pipeline', label: '流水线', hint: '按勾选顺序依次执行：上一步的结果会作为下一步的输入。' },
]

const COLLAB_PLATFORMS = [
  { id: 'dsh', label: 'DSH 官方', provider: 'spawn' },
  { id: 'codex', label: 'Codex', provider: 'codex' },
  { id: 'claude-code', label: 'Claude Code', provider: 'claude-code' },
]

/** 分工模式里每个平台该干什么（拼进派活指令）。 */
const SPLIT_RULES = {
  dsh: '用 spawn_teammate 组队，负责需要多步骤/可并行的部分',
  codex: '用 subagent_codex 跑一次单点硬活（代码改动、命令、构建测试）',
  'claude-code': '用 subagent_claude_code 跑一次审阅/长文本/重构这类任务',
}

/** 当前正在跑的会诊 / 流水线（进程内状态）。 */
let activeCollabRun = null

function collabModeOf(state) {
  return COLLAB_MODES.some(mode => mode.id === state.mode) ? state.mode : 'single'
}

/** 规范勾选：去重、只留已知平台、保持给定顺序。 */
function normalizePicks(picks) {
  const out = []
  for (const id of Array.isArray(picks) ? picks : []) {
    if (typeof id !== 'string') continue
    if (!COLLAB_PLATFORMS.some(platform => platform.id === id)) continue
    if (!out.includes(id)) out.push(id)
  }
  return out
}

function picksOf(state) {
  const picks = normalizePicks(state.picks)
  return picks.length > 0 ? picks : ['dsh']
}

/** 分工模式：勾选平台 → 一条多平台派活指令。 */
function dispatchInstructionFor(picks) {
  const list = normalizePicks(picks)
  if (list.length === 0) return dispatchInstruction('team')
  if (list.length === 1) {
    const one = list[0]
    if (one === 'dsh') return dispatchInstruction('team')
    return dispatchInstruction(one)
  }
  const lines = list.map(id => `- ${COLLAB_PLATFORMS.find(platform => platform.id === id)?.label ?? id}：${SPLIT_RULES[id] ?? ''}`).join('\n')
  return `${PLAN_SPEC}
这次是「跨平台分工」：同一件事必须同时用到下面这些平台，各负责一部分：

${lines}

派活要求：先把分工写清楚（谁做什么、边界在哪、验收标准是什么），然后同一回合内真的把活派出去——DSH 部分用 spawn_teammate，Codex 用 subagent_codex，Claude Code 用 subagent_claude_code；能并行的并行；最后汇总各平台的结果一起汇报。

用户的原始需求如下：
`
}

/** 会诊：每个平台独立回答同一个任务。 */
function buildConsultPrompt(label, task) {
  return `你是参与「同题会诊」的独立专家之一（平台：${label}）。所有平台拿到的是同一个任务，请独立给出你的方案/结论。
要求：中文；先给结论，再给关键步骤或代码要点；控制在 400 字以内；不要提及其它平台。

===== 任务 =====
${task}`
}

/** 流水线：上一步的输出成为下一步的输入。 */
function buildPipelinePrompt(label, step, total, task, previous) {
  const head = `你是「跨平台流水线」的第 ${step}/${total} 步（平台：${label}）。\n用户的总任务：\n${task}\n`
  if (!previous) {
    return `${head}\n你是第一步：先拆解任务并完成你能做的部分，给下一步留一段清晰的交接说明（做了什么、还剩什么、下一步该干嘛）。`
  }
  return `${head}\n上一步的输出：\n${previous}\n\n请接着做你这一步：验证/补全上一步的结果，能收尾就收尾；最后给出这一步的交接说明或最终结果。`
}

/** 跑一个平台的一次性任务（官方 subagent 提供方）。 */
async function runOneShotPlatform(ctx, options, platformId, prompt, signal) {
  const s = services(ctx)
  const platform = COLLAB_PLATFORMS.find(item => item.id === platformId)
  if (!platform) throw new Error(`未知平台：${platformId}`)
  if (!s.subagents) throw new Error('subagents 服务不可用（需要官方 subagent 提供方）')
  const parent = await parentAgentForLeader(ctx, options)
  const run = await s.subagents.start(platform.provider, {
    label: `${platform.label} · 跨平台`,
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal,
  })
  try {
    const result = await run.result
    const text = textOf(result.output).trim()
    return {
      ok: result.stopReason === 'completed',
      text: text || '',
      diagnostic: result.diagnostic,
      stopReason: result.stopReason,
    }
  } finally {
    try { await run.dispose() } catch { /* 结束后的 dispose 是幂等的 */ }
  }
}

/** 把某次跨平台运行写进状态文件（面板刷新 / 重启后还能看到结果）。 */
function persistCollabRun(mode, task, startedAt, entries, finished) {
  writeState({
    lastRun: {
      mode,
      task,
      startedAt,
      finishedAt: finished ? Date.now() : null,
      entries: entries.map(entry => ({
        platform: entry.platform,
        label: entry.label,
        status: entry.status,
        elapsedMs: entry.elapsedMs ?? 0,
        text: String(entry.text ?? '').slice(0, 4000),
        diagnostic: entry.diagnostic ? String(entry.diagnostic).slice(0, 500) : undefined,
      })),
    },
  })
}

/** 启动一次会诊 / 流水线（后台跑，面板轮询状态）。 */
async function startCollabRun(ctx, options, mode, task, picks) {
  const list = normalizePicks(picks)
  if (list.length === 0) throw new Error('至少勾选一个平台')
  const entries = list.map(id => ({
    platform: id,
    label: COLLAB_PLATFORMS.find(platform => platform.id === id)?.label ?? id,
    status: 'queued',
    elapsedMs: 0,
    text: '',
  }))
  const startedAt = Date.now()
  const controllers = entries.map(() => new AbortController())
  activeCollabRun = { mode, task, startedAt, entries, controllers }
  persistCollabRun(mode, task, startedAt, entries, false)
  const runOne = async (entry, index, prompt) => {
    entry.status = 'running'
    persistCollabRun(mode, task, startedAt, entries, false)
    try {
      const out = await runOneShotPlatform(ctx, options, entry.platform, prompt, controllers[index].signal)
      entry.text = out.text || (out.ok ? '（没有输出）' : '（运行未正常结束）')
      entry.status = out.ok ? 'done' : 'failed'
      if (!out.ok && out.diagnostic) entry.diagnostic = out.diagnostic
    } catch (error) {
      entry.status = 'failed'
      entry.text = describeError(error)
    }
    entry.elapsedMs = Date.now() - startedAt
    persistCollabRun(mode, task, startedAt, entries, false)
  }
  try {
    if (mode === 'consult') {
      await Promise.all(entries.map((entry, index) => runOne(entry, index, buildConsultPrompt(entry.label, task))))
    } else {
      let previous = ''
      for (const [index, entry] of entries.entries()) {
        await runOne(entry, index, buildPipelinePrompt(entry.label, index + 1, entries.length, task, previous))
        if (entry.status === 'done') previous = entry.text
      }
    }
  } finally {
    activeCollabRun = null
    persistCollabRun(mode, task, startedAt, entries, true)
  }
}

// ── 领导平台：DSH 官方会话，或外部 harness（Codex / Claude Code）────────────────
//
// DSH 的会话只能跑 DSH 自己的 LLM；Codex / Claude Code 是通过官方 subagent
// 提供方暴露的**一次性运行**。所以「外部 harness 当领导」的实现方式是：
// 面板保留一段对话记录，每轮把「角色说明 + 历史 + 新消息」拼成一个 prompt 交给
// 官方 provider 跑一次，把它的最终答复记回对话记录。派活 = 直接让它把活干完
// （它本来就是完整 agent，有自己的工具）。

const LEADER_DSH = 'dsh'
/** 内置的提供方展示名（可用 profile 配置 leaders 覆盖）。 */
const DEFAULT_LEADER_LABELS = { codex: 'Codex（GPT）', 'claude-code': 'Claude Code' }
/** 不算「领导平台」的进程内提供方。 */
const INTERNAL_SUBAGENT_PROVIDERS = new Set(['spawn', 'fork', 'acp', 'dsh-sdk'])
const TRANSCRIPT_LIMIT = 60
const TRANSCRIPT_ENTRY_LIMIT = 4000

const LEADER_PERSONA = `你是「领导面板」里的「领导」：一个中文软件工程的指挥者，用户是「老板」。
你运行在外部 harness 里，拥有自己的工具（读写文件、跑命令、搜索等），可以直接把活干完。
回答要简洁、直接、中文；不要输出内部推理过程，也不要说教。`

const LEADER_DISPATCH_SPEC = `现在用户要你「总结并派活」。请先按下面四段格式简短回答（只写这四段）：

【需求】用户到底要什么（一句话）
【效果】做完之后用户能看到什么
【分工】谁去干 + 它负责什么 + 预计耗时
【预计时间】整件事大概要多久

然后直接动手把这件事做完（该读文件就读、该改代码就改、该跑命令就跑）。
重要：面板只读取你的**最后一条回复**，所以请把四段和最终结果放进同一条回复里（先四段，再用一两句话写结果）。`

/** 当前正在跑的外部 harness（进程内状态，不落盘）。 */
let activeLeaderRun = null

/** 可选的领导平台：DSH 官方 + 所有已注册的外部 harness 提供方。 */
function leaderOptions(s, options) {
  const labels = options.leaders ?? {}
  let providers = []
  try { providers = s.subagents?.list?.() ?? [] } catch { providers = [] }
  const out = [{
    id: LEADER_DSH,
    kind: 'dsh',
    provider: null,
    label: labels[LEADER_DSH] || 'DSH 官方',
    available: Boolean(s.controller),
  }]
  for (const provider of providers) {
    if (INTERNAL_SUBAGENT_PROVIDERS.has(provider)) continue
    out.push({
      id: `harness:${provider}`,
      kind: 'harness',
      provider,
      label: labels[provider] || DEFAULT_LEADER_LABELS[provider] || provider,
      available: true,
    })
  }
  return out
}

/** 当前领导（默认 DSH 官方）。 */
function resolveLeader(s, options) {
  const leaders = leaderOptions(s, options)
  const saved = readState().leader
  return leaders.find(item => item.id === saved) ?? leaders[0]
}

/** 外部 harness 没有会话记忆，每轮都要把对话记录拼进 prompt。 */
function buildLeaderPrompt(leaderLabel, transcript, userText, dispatch) {
  const history = (Array.isArray(transcript) ? transcript : [])
    .filter(message => message && typeof message.text === 'string' && message.text.trim())
    .slice(-20)
    .map(message => `${message.role === 'user' ? '用户' : '领导'}：${message.text.slice(0, TRANSCRIPT_ENTRY_LIMIT)}`)
    .join('\n\n')
  return [
    `${LEADER_PERSONA}\n\n你正在「${leaderLabel}」里运行。`,
    history ? `\n\n===== 之前的对话（从旧到新）=====\n${history}` : '',
    dispatch
      ? `\n\n===== 用户这次的要求 =====\n${userText}\n\n${LEADER_DISPATCH_SPEC}`
      : `\n\n===== 用户的新消息 =====\n${userText}`,
  ].join('')
}

/** 读某个领导平台保存的对话记录。 */
function transcriptOf(leaderId) {
  const all = readState().transcripts
  const list = all && Array.isArray(all[leaderId]) ? all[leaderId] : []
  return list.slice(-TRANSCRIPT_LIMIT)
}

/** 追加一条对话记录（外部 harness 模式下面板自己维护历史）。 */
function appendTranscript(leaderId, message) {
  const state = readState()
  const all = state.transcripts && typeof state.transcripts === 'object' ? { ...state.transcripts } : {}
  const list = Array.isArray(all[leaderId]) ? all[leaderId].slice(-(TRANSCRIPT_LIMIT - 1)) : []
  list.push({
    role: message.role === 'user' ? 'user' : 'lead',
    text: String(message.text ?? ''),
    time: message.time ?? Date.now(),
    calls: Array.isArray(message.calls) ? message.calls : [],
    ...(message.failed ? { failed: true } : {}),
  })
  all[leaderId] = list
  writeState({ transcripts: all })
}

/** 外部 harness 的 parent agent：借领导会话（只提供 cwd / 谱系）。 */
async function parentAgentForLeader(ctx, options) {
  const s = services(ctx)
  const { sessionId } = await ensureLead(ctx, options, false)
  const live = s.agents?.get?.(sessionId)
  if (!live) throw new Error('领导会话还没就绪：外部 harness 需要一个 DSH 会话作为 parent（打开面板后再试）')
  return live
}

/** 跑一轮外部 harness（聊天或派活），结果写回对话记录。 */
async function runHarnessLeaderTurn(ctx, options, leader, userText, dispatch) {
  const s = services(ctx)
  if (!s.subagents) {
    appendTranscript(leader.id, { role: 'lead', text: '【外部 harness 不可用】subagents 服务没加载起来', failed: true })
    return
  }
  const controller = new AbortController()
  activeLeaderRun = {
    leaderId: leader.id, provider: leader.provider, label: leader.label,
    startedAt: Date.now(), dispatch, controller,
  }
  try {
    const parent = await parentAgentForLeader(ctx, options)
    const prompt = buildLeaderPrompt(leader.label, transcriptOf(leader.id), userText, dispatch)
    const run = await s.subagents.start(leader.provider, {
      label: dispatch ? '领导：派活' : '领导',
      prompt: [{ type: 'text', text: prompt }],
      parent,
      signal: controller.signal,
    })
    let text = ''
    let failed = false
    try {
      const result = await run.result
      text = textOf(result.output).trim()
      if (result.stopReason !== 'completed') {
        failed = true
        const reason = result.diagnostic ? `${result.stopReason}: ${result.diagnostic}` : String(result.stopReason)
        text = `${text ? `${text}\n\n` : ''}【运行未正常结束：${reason}】`
      }
      if (!text) text = '（没有返回内容）'
    } finally {
      try { await run.dispose() } catch { /* 已经结束的 run 再 dispose 是幂等的 */ }
    }
    appendTranscript(leader.id, { role: 'lead', text, time: Date.now(), calls: [], failed })
  } catch (error) {
    appendTranscript(leader.id, {
      role: 'lead',
      text: `【${leader.label} 启动失败】${describeError(error)}`,
      time: Date.now(), calls: [], failed: true,
    })
  } finally {
    activeLeaderRun = null
  }
}

// ── 外部 harness 的原生配置：换模型 / 打开平台（0.9.0）──────────────────────────
//
// 外部 harness 当「领导」时，模型的真正来源是它自己的配置文件，不是 DSH 的模型列表：
//   · Codex       → $CODEX_HOME/config.toml（默认 ~/.codex/config.toml）里的 `model`
//   · Claude Code → ~/.claude/settings.json 里的 `model`（没有 = 用它自己的默认）
// 所以面板只做三件事：把当前模型读出来、改这一个字段（写前留 .bak）、
// 新开一个终端跑它的 CLI 或者用记事本打开它的配置。其它配置一概不碰。

const HARNESS_APPS = [
  {
    id: 'codex',
    label: 'Codex',
    kind: 'toml',
    configPath: () => join(codexHome(), 'config.toml'),
    fallbackModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    note: '改的是 Codex 自己的 config.toml，下一条领导回复就生效',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    kind: 'json',
    configPath: () => join(homedir(), '.claude', 'settings.json'),
    fallbackModels: ['sonnet', 'opus', 'haiku'],
    note: '改的是 Claude Code 自己的 settings.json（model 字段），下一条领导回复就生效；留空 = 用它自己的默认',
  },
]

/** Codex 的配置目录（尊重 CODEX_HOME）。 */
function codexHome() {
  const env = typeof process.env.CODEX_HOME === 'string' ? process.env.CODEX_HOME.trim() : ''
  return env || join(homedir(), '.codex')
}

function readTextFile(path) {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

/** 模型 id 的合法字符集：够覆盖 deepseek-v4-pro / gpt-5-codex / claude-sonnet-4-5 这些。 */
function normalizeModelId(value) {
  if (typeof value !== 'string') return null
  const model = value.trim()
  if (!model || model.length > 120) return null
  return /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/u.test(model) ? model : null
}

/** 从 Codex config.toml 文本里读 model / model_provider / base_url（纯函数）。 */
function parseCodexConfig(raw) {
  if (typeof raw !== 'string') return { model: null, provider: null, baseUrl: null, catalogPath: null }
  const readKey = key => {
    const match = raw.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*"([^"]*)"`, 'mu'))
    return match ? match[1] : null
  }
  const provider = readKey('model_provider')
  // 只按「段头 + 键=值字符串」逐行扫，避免用跨行正则去猜段的边界。
  const sections = {}
  let current = null
  for (const line of raw.split(/\r?\n/u)) {
    const header = line.match(/^\[([^\]]+)\][ \t]*$/u)
    if (header) {
      current = header[1].trim()
      if (!sections[current]) sections[current] = {}
      continue
    }
    if (current === null) continue
    const pair = line.match(/^[ \t]*([A-Za-z0-9_.-]+)[ \t]*=[ \t]*"([^"]*)"/u)
    if (pair) sections[current][pair[1]] = pair[2]
  }
  const baseUrl = provider ? (sections[`model_providers.${provider}`]?.base_url ?? null) : null
  return { model: readKey('model'), provider, baseUrl, catalogPath: readKey('model_catalog_json') }
}

/** 把 model 写进 Codex config.toml 文本（纯函数）：有 `model =` 就替换，没有就插在 model_provider 后面。 */
function applyCodexModel(raw, model) {
  const text = typeof raw === 'string' ? raw : ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/u)
  const modelIndex = lines.findIndex(line => /^[ \t]*model[ \t]*=[ \t]*"[^"]*"[ \t]*$/u.test(line))
  if (modelIndex >= 0) {
    lines[modelIndex] = `model = "${model}"`
  } else {
    const providerIndex = lines.findIndex(line => /^[ \t]*model_provider[ \t]*=[ \t]*"[^"]*"[ \t]*$/u.test(line))
    lines.splice(providerIndex >= 0 ? providerIndex + 1 : 0, 0, `model = "${model}"`)
  }
  return lines.join(eol)
}

/** 把 model 写进 Claude Code settings.json 文本（纯函数）；空字符串 = 删掉该字段用它自己的默认。 */
function applyClaudeModel(raw, model) {
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json 顶层不是对象')
  if (typeof model === 'string' && model) parsed.model = model
  else delete parsed.model
  return `${JSON.stringify(parsed, null, 2)}\n`
}

const catalogCache = { path: null, mtimeMs: 0, models: [] }

/** Codex 的模型目录（config.toml 里 model_catalog_json 指向的文件）：给「换模型」当快捷选项。 */
function codexCatalogModels() {
  const home = codexHome()
  const config = parseCodexConfig(readTextFile(join(home, 'config.toml')) ?? '')
  if (!config.catalogPath) return []
  const file = isAbsolute(config.catalogPath) ? config.catalogPath : join(home, config.catalogPath)
  try {
    const stat = statSync(file)
    if (catalogCache.path === file && catalogCache.mtimeMs === stat.mtimeMs) return catalogCache.models
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(parsed?.models) ? parsed.models : []
    const models = list
      .map(item => ({
        id: typeof item?.slug === 'string' ? item.slug : (typeof item?.id === 'string' ? item.id : ''),
        name: typeof item?.display_name === 'string' && item.display_name
          ? item.display_name
          : String(item?.slug ?? item?.id ?? ''),
      }))
      .filter(item => item.id)
    catalogCache.path = file
    catalogCache.mtimeMs = stat.mtimeMs
    catalogCache.models = models
    return models
  } catch {
    return []
  }
}

/** 在 PATH / 已知安装目录里找一个可执行文件（只判断存在，不执行）。 */
function findExecutable(names, extra = []) {
  const found = []
  for (const candidate of extra) if (candidate && existsSync(candidate)) found.push(candidate)
  for (const dir of String(process.env.PATH ?? '').split(';')) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) { found.push(candidate); break }
    }
  }
  return found[0] ?? null
}

/** Codex 的 CLI：优先桌面版自带的 codex.exe，其次 PATH 里的。 */
function findCodexBin() {
  const extra = []
  try {
    const base = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin')
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(base, entry.name, 'codex.exe')
      if (existsSync(candidate)) extra.push(candidate)
    }
  } catch { /* 没装桌面版 */ }
  return findExecutable(['codex.exe', 'codex.cmd', 'codex.bat', 'codex'], extra)
}

/** Claude Code 的 CLI：npm 全局装的 claude.cmd 或 PATH 里的。 */
function findClaudeBin() {
  const appData = process.env.APPDATA ?? ''
  return findExecutable(['claude.cmd', 'claude.exe', 'claude'], [
    appData ? join(appData, 'npm', 'claude.cmd') : '',
  ])
}

function hostOf(url) {
  try { return new URL(url).host } catch { return url }
}

/** 一个外部 harness 的「当前模型 + 配置位置 + 可执行文件」快照。 */
function harnessAppInfo(app) {
  const configPath = app.configPath()
  const raw = readTextFile(configPath)
  const info = {
    id: app.id,
    label: app.label,
    kind: app.kind,
    configPath,
    configExists: raw !== null,
    note: app.note,
    model: null,
    provider: null,
    providerLabel: null,
    baseUrl: null,
    models: [],
  }
  if (app.kind === 'toml') {
    const config = parseCodexConfig(raw ?? '')
    info.model = config.model
    info.provider = config.provider
    info.baseUrl = config.baseUrl
    info.providerLabel = config.provider
      ? (config.baseUrl ? `${config.provider} · ${hostOf(config.baseUrl)}` : config.provider)
      : null
    info.models = [...codexCatalogModels()]
  } else {
    try {
      const parsed = raw === null ? {} : JSON.parse(raw)
      info.model = typeof parsed?.model === 'string' ? parsed.model : null
    } catch {
      info.configError = 'settings.json 不是合法 JSON，改模型前先修好它'
    }
  }
  for (const model of app.fallbackModels ?? []) {
    if (!info.models.some(item => item.id === model)) info.models.push({ id: model, name: model })
  }
  if (info.model && !info.models.some(item => item.id === info.model)) {
    info.models.unshift({ id: info.model, name: info.model })
  }
  const bin = app.id === 'codex' ? findCodexBin() : app.id === 'claude-code' ? findClaudeBin() : null
  info.bin = bin
  info.canOpen = Boolean(bin)
  return info
}

/** 可编辑模型的外部 harness 快照；提供方没注册就不出现。 */
function harnessAppsOf(providerNames) {
  const out = {}
  for (const app of HARNESS_APPS) {
    if (!providerNames.has(app.id)) continue
    try {
      out[app.id] = harnessAppInfo(app)
    } catch (error) {
      out[app.id] = { id: app.id, label: app.label, error: describeError(error), canOpen: false, models: [] }
    }
  }
  return out
}

/** 写外部 harness 的原生模型字段（先备份原文件，只改这一个字段）。 */
function writeHarnessModel(platform, model) {
  const app = HARNESS_APPS.find(item => item.id === platform)
  if (!app) throw new Error(`未知平台：${platform}`)
  const wanted = typeof model === 'string' ? model.trim() : ''
  const allowEmpty = app.kind === 'json'
  const id = normalizeModelId(wanted)
  if (!id && !(allowEmpty && wanted === '')) {
    throw new Error('模型 id 不合法：只允许字母、数字和 . _ : / -')
  }
  const configPath = app.configPath()
  const raw = readTextFile(configPath)
  if (raw === null) throw new Error(`找不到 ${app.label} 的配置文件：${configPath}（先手动启动一次 ${app.label}）`)
  const next = app.kind === 'toml' ? applyCodexModel(raw, id) : applyClaudeModel(raw, id ?? '')
  if (next !== raw) {
    try { writeFileSync(`${configPath}.lead-panel.bak`, raw, 'utf8') } catch { /* 备份失败也照写，别把人卡住 */ }
    writeFileSync(configPath, next, 'utf8')
  }
  return {
    platform: app.id,
    model: id,
    changed: next !== raw,
    configPath,
    info: harnessAppInfo(app),
  }
}

/** 打开外部 harness：新终端跑它的 CLI，或用记事本打开它的配置文件。 */
function planOpen(platform, what) {
  const app = HARNESS_APPS.find(item => item.id === platform)
  if (!app) throw new Error(`未知平台：${platform}`)
  const info = harnessAppInfo(app)
  if (what === 'config') {
    if (!info.configExists) throw new Error(`配置文件还不存在：${info.configPath}（先手动启动一次 ${app.label}）`)
    return { kind: 'config', program: 'notepad.exe', args: [info.configPath], target: info.configPath, label: `${app.label} 配置` }
  }
  if (!info.bin) {
    throw new Error(`没找到 ${app.label} 的可执行文件：先在终端里手动运行一次 ${app.id === 'codex' ? 'codex' : 'claude'}`)
  }
  return { kind: 'app', program: info.bin, args: [], target: info.bin, label: app.label }
}

/** 新开一个窗口跑外部 harness（Windows 用 start，其它系统只给提示）。 */
function launchDetached(plan) {
  if (process.platform !== 'win32') {
    throw new Error('一键打开目前只支持 Windows；请手动在终端里启动它')
  }
  const child = spawn('cmd.exe', ['/c', 'start', '', plan.program, ...plan.args], {
    cwd: homedir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.on('error', () => { /* 新窗口起不来不影响面板 */ })
  child.unref()
}

/**
 * 默认价目表：元 / 百万 token。
 * DSH 本身没有金额模型（只有 token），所以这里内置 DeepSeek 公开牌价，
 * 可在 profile 的 cordis.patch.yml 里用 config.prices 覆盖。
 *   input     输入（缓存未命中）
 *   cacheRead 输入（缓存命中）
 *   output    输出
 */
const DEFAULT_PRICE = { input: 2, cacheRead: 0.2, output: 3 }
const DEFAULT_PRICES = {
  'deepseek-flash': { input: 2, cacheRead: 0.2, output: 3 },
  'deepseek-v4-pro': { input: 4, cacheRead: 0.5, output: 12 },
  'deepseek-chat': { input: 2, cacheRead: 0.2, output: 3 },
  'deepseek-reasoner': { input: 4, cacheRead: 0.5, output: 12 },
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function statePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'lead-panel', 'state.json')
}

function readState() {
  try {
    const raw = readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeState(patch) {
  try {
    const next = { version: STATE_VERSION, ...readState(), ...patch }
    mkdirSync(dirname(statePath()), { recursive: true })
    writeFileSync(statePath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return next
  } catch {
    return readState()
  }
}

function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  return {
    route: typeof raw.route === 'string' && raw.route.trim() ? raw.route.trim() : ROUTE,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : '领导',
    cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : undefined,
    leadPreset: typeof raw.leadPreset === 'string' && raw.leadPreset.trim() ? raw.leadPreset.trim() : undefined,
    leadModel: raw.leadModel && typeof raw.leadModel === 'object' ? raw.leadModel : undefined,
    prices: { ...DEFAULT_PRICES, ...(raw.prices && typeof raw.prices === 'object' ? raw.prices : {}) },
    currency: typeof raw.currency === 'string' && raw.currency.trim() ? raw.currency.trim() : '¥',
    /** 领导平台展示名覆盖：{ codex: 'Codex · GPT', 'claude-code': 'Claude Code' } */
    leaders: raw.leaders && typeof raw.leaders === 'object' && !Array.isArray(raw.leaders) ? raw.leaders : {},
  }
}

function priceOf(options, modelId) {
  return options.prices[modelId] ?? DEFAULT_PRICE
}

function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function isLocalRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
      if (raw.length > 1_000_000) reject(new Error('请求体过大'))
    })
    req.on('end', () => {
      if (!raw.trim()) { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', error => { reject(error) })
  })
}

/** 拿一个可选服务；取不到就返回 null，让调用方降级。 */
function service(ctx, key) {
  try {
    const value = ctx.get(key)
    return value === undefined ? null : value
  } catch {
    return null
  }
}

function services(ctx) {
  return {
    controller: service(ctx, 'sessionController'),
    llm: service(ctx, 'llm'),
    projections: service(ctx, 'sessionProjections'),
    sessions: service(ctx, 'sessions'),
    agents: service(ctx, 'agents'),
    teams: service(ctx, 'agentTeams'),
    subagents: service(ctx, 'subagents'),
  }
}

// ── 会话与消息 ──────────────────────────────────────────────────────────────

/**
 * 确保「领导」会话存在。
 * 记录在 $DSH_HOME/lead-panel/state.json，重启 DSH 后仍复用同一个会话
 * （冷恢复由 sessionController 负责）；reset=1 时丢弃记录重新建一个。
 */
async function ensureLead(ctx, options, reset) {
  const s = services(ctx)
  if (!s.controller) throw new Error('sessionController 服务不可用（这个 profile 没有 Host 会话 API）')
  const state = reset ? writeState({ leadSessionId: null }) : readState()

  if (state.leadSessionId) {
    if (s.agents?.get?.(state.leadSessionId)) {
      return { sessionId: state.leadSessionId, created: false }
    }
    try {
      const resolved = await s.controller.resolveAgent(state.leadSessionId)
      if (resolved && !('error' in resolved)) return { sessionId: state.leadSessionId, created: false }
    } catch { /* 会话已被删除，下面重建 */ }
  }

  const created = await s.controller.create({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.leadPreset === undefined ? {} : { agentPreset: options.leadPreset }),
  })
  const sessionId = created.sessionId
  writeState({ leadSessionId: sessionId, jobStartedAt: null })
  try { await s.controller.rename({ sessionId, title: options.title }) } catch { /* 标题只是好看 */ }

  const stored = readState().model ?? options.leadModel
  if (stored?.provider && stored?.model) {
    try {
      await s.controller.selectModel({ sessionId, provider: stored.provider, model: stored.model })
    } catch { /* 模型不可用就退回默认 */ }
  }
  return { sessionId, created: true }
}

/** 给领导发一条消息（不存在就先建）。 */
async function sendToLead(ctx, options, text, mode = 'queue') {
  const s = services(ctx)
  if (typeof text !== 'string' || !text.trim()) throw new Error('消息内容为空')
  const { sessionId } = await ensureLead(ctx, options, false)
  await s.controller.prompt({
    requestId: randomUUID(),
    sessionId,
    mode,
    content: [{ type: 'text', text: text.trim() }],
  }, new AbortController().signal)
  return { sessionId }
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

function callsOf(blocks) {
  if (!Array.isArray(blocks)) return []
  return blocks
    .filter(block => block && block.type === 'tool-call' && typeof block.name === 'string')
    .map(block => block.name)
}

/** 从会话事件里读最近的对话（面板自己发的用户消息 + 助手的文本与工具调用）。 */
function readMessagesFromEvents(events, limit) {
  const out = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'user/message') {
      const data = event.data ?? {}
      // 只认真正的用户消息（source.kind === 'user'，面板自己发的那条）。
      // 运行时上下文（runtime-context）、AGENTS.md、技能清单同样是 user/message，
      // 但 kind 各不相同，放进面板只会刷屏。
      if (data.source?.kind !== 'user') continue
      const text = textOf(data.content)
      if (!text.trim()) continue
      out.push({
        role: 'user',
        text,
        time: event.time ?? null,
        calls: [],
      })
    } else if (event.type === 'assistant/message') {
      const content = event.data?.message?.content
      const text = textOf(content)
      const calls = callsOf(content)
      if (!text.trim() && calls.length === 0) continue
      out.push({ role: 'lead', text, time: event.time ?? null, calls })
    }
  }
  return out.slice(-limit)
}

/** 活会话的对话读取。 */
function readMessages(session, limit) {
  let events = []
  try { events = session.snapshotEvents() } catch { return [] }
  return readMessagesFromEvents(events, limit)
}

/** 解析工具调用的 arguments（模型给的是 JSON 字符串）；坏数据当空对象，绝不让面板崩。 */
function parseToolArguments(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 从领导会话事件里还原「外部 harness」的运行记录。
 *
 * DSH 把每次工具调用写成 `tool/call`（含 callId、name、arguments），
 * 结果写成 `tool/result`（同一 callId）；Codex / Claude Code 由官方 subagent
 * 提供方执行，最终答案就在 tool/result 的文本块里。
 * 于是面板不依赖额外服务，就能显示「派给了谁、干完没有、最终说了什么」。
 *
 * @param events 会话事件
 * @param limit 最多显示最近几次
 */
function externalWorkersFromEvents(events, limit = 8) {
  if (!Array.isArray(events)) return []
  const results = new Map()
  for (const event of events) {
    if (!event || event.type !== 'tool/result') continue
    const callId = event.data?.message?.source?.callId
    if (callId === undefined || callId === null) continue
    results.set(String(callId), event)
  }
  const workers = []
  for (const event of events) {
    if (!event || event.type !== 'tool/call') continue
    const named = EXTERNAL_BY_TOOL.get(event.data?.name)
    if (!named) continue
    const callId = String(event.data?.callId ?? `${named.id}-${workers.length}`)
    const args = parseToolArguments(event.data?.arguments)
    const result = results.get(callId)
    const isError = Boolean(result?.data?.message?.isError ?? result?.data?.isError)
    const answer = result ? textOf(result.data?.message?.content) : ''
    const description = typeof args.description === 'string' ? args.description : ''
    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    workers.push({
      name: named.label,
      id: callId,
      external: true,
      harness: named.id,
      status: result ? (isError ? 'failed' : 'done') : 'running',
      description,
      prompt: prompt.slice(0, WORKER_TEXT_LIMIT),
      provider: null,
      model: null,
      parent: null,
      diagnostics: [],
      usage: null,
      cost: 0,
      // 跑完显示 Codex / Claude Code 的最终答案；还在跑就显示这一步在做什么。
      lastText: (result ? answer : description || prompt).slice(0, WORKER_TEXT_LIMIT),
      done: Boolean(result),
    })
  }
  return workers.slice(-limit)
}

/**
 * 从最后一条「四段式」回复里抽出计划：需求 / 效果 / 分工 / 预计时间。
 * 领导按派活指令回答时会带这四个方括号小标题，抽出来面板就能用卡片渲染。
 */
function extractPlan(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'lead' || !message.text.includes('【需求】')) continue
    const sections = {}
    const matches = [...message.text.matchAll(/【([^】]+)】/gu)]
    for (const [position, match] of matches.entries()) {
      const start = match.index + match[0].length
      const end = position + 1 < matches.length ? matches[position + 1].index : message.text.length
      sections[match[1].trim()] = message.text.slice(start, end).trim()
    }
    return {
      need: sections['需求'] ?? '',
      effect: sections['效果'] ?? '',
      split: sections['分工'] ?? '',
      eta: sections['预计时间'] ?? '',
      at: message.time ?? null,
    }
  }
  return null
}

/**
 * 把任何来路不明的计数变成数字。
 * token 计数理论上都是 number，但持久日志来自不同版本、也可能被别的插件写坏；
 * 一旦混进字符串，`+=` 会变成**拼接**（"0" + "120" → "0120"）而不是相加，
 * 金额随后全错。宁可把不可解析的值当 0，也不要算出个看着像数字的垃圾。
 */
function num(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function totalsOf(projections, session) {
  if (!projections || !session) return null
  try {
    const state = projections.stateOf(session, 'tokenUsage')
    const totals = state?.totals
    if (!totals) return null
    return {
      uncachedInputTokens: num(totals.uncachedInputTokens),
      cacheReadTokens: num(totals.cacheReadTokens),
      cacheWriteTokens: num(totals.cacheWriteTokens),
      outputTokens: num(totals.outputTokens),
    }
  } catch {
    return null
  }
}

/**
 * 从事件流里折叠 token 用量。
 * 每条 `assistant/message` 都带自己那一步的 `usage`（四个桶互不重叠），所以
 * 把整条日志加起来就是这一轮的权威用量。它同时是**冷会话**唯一的取数方式：
 * worker 干完活会被卸载，tokenUsage 投影读不到，但持久日志还在。
 */
function foldUsage(events) {
  const total = {
    uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
  }
  let seen = 0
  for (const event of events ?? []) {
    if (!event || event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (!usage) continue
    seen += 1
    total.uncachedInputTokens += num(usage.inputTokens)
    total.cacheReadTokens += num(usage.cacheReadTokens)
    total.cacheWriteTokens += num(usage.cacheWriteTokens)
    total.outputTokens += num(usage.outputTokens)
  }
  return seen === 0 ? null : total
}

function usageIsEmpty(usage) {
  if (!usage) return true
  return (usage.uncachedInputTokens ?? 0) === 0
    && (usage.cacheReadTokens ?? 0) === 0
    && (usage.cacheWriteTokens ?? 0) === 0
    && (usage.outputTokens ?? 0) === 0
}

/**
 * 一个会话的用量：先看实时投影；投影还没跟上（首次读取前是空的）或会话已卸载时，
 * 退回持久日志折叠。
 * @returns `{ usage, messages, live }`；读不到就是 `usage: null`。
 */
async function readSessionUsage(ctx, s, sessionId) {
  if (!sessionId) return { live: false, usage: null, messages: [], events: [] }
  const live = s.sessions?.get?.(sessionId) ?? null
  if (live) {
    let events = []
    try { events = live.snapshotEvents() } catch { events = [] }
    const projected = totalsOf(s.projections, live)
    const folded = foldUsage(events)
    return {
      live: true,
      usage: usageIsEmpty(projected) ? folded : projected,
      messages: readMessages(live, 200),
      events,
    }
  }
  const persistence = service(ctx, 'sessionPersistence')
  if (!persistence) return { live: false, usage: null, messages: [], events: [] }
  try {
    const handle = await persistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read(0, undefined)
      return {
        live: false,
        usage: foldUsage(events),
        messages: readMessagesFromEvents(events, 200),
        events: events ?? [],
      }
    } finally {
      await handle.close()
    }
  } catch {
    return { live: false, usage: null, messages: [], events: [] }
  }
}

function statsOf(projections, session) {
  if (!projections || !session) return null
  try { return projections.stateOf(session, 'sessionStats') ?? null } catch { return null }
}

function addUsage(left, right) {
  const base = left ?? {
    uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
  }
  if (!right) return base
  return {
    uncachedInputTokens: base.uncachedInputTokens + num(right.uncachedInputTokens),
    cacheReadTokens: base.cacheReadTokens + num(right.cacheReadTokens),
    cacheWriteTokens: base.cacheWriteTokens + num(right.cacheWriteTokens),
    outputTokens: base.outputTokens + num(right.outputTokens),
  }
}

function costOf(usage, price) {
  if (!usage) return 0
  const cached = num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)
  return (num(usage.uncachedInputTokens) * price.input
    + cached * price.cacheRead
    + num(usage.outputTokens) * price.output) / 1_000_000
}

/** 领导 + 工人的模型清单（provider 分组），供面板下拉框用。 */
async function listModels(s) {
  if (!s.llm) return { groups: [], default: null }
  const groups = []
  const failures = []
  let providers = []
  try { providers = s.llm.listProviders() ?? [] } catch { providers = [] }
  for (const provider of providers) {
    try {
      const models = await s.llm.listModels(provider.id)
      if (!models || models.length === 0) continue
      groups.push({
        id: provider.id,
        name: provider.name ?? provider.id,
        models: models.map(model => ({ id: model.id, name: model.name ?? model.id })),
      })
    } catch (error) {
      failures.push({ id: provider.id, message: describeError(error) })
    }
  }
  return { groups, failures }
}

function modelSelectionOf(projections, session) {
  if (!projections || !session) return null
  try {
    const state = projections.stateOf(session, 'modelSelection')
    if (!state) return null
    return { lastUsed: state.lastUsed ?? null, pending: state.pending ?? null }
  } catch {
    return null
  }
}

/**
 * 领导的工人们：Agent Teams 名册 + 外部 harness 运行记录，各带自己的用量和最后一句结论。
 * worker 干完活会被卸载，所以这里对每个工人走一遍「活会话优先、否则读持久日志」，
 * 这样它 settle 之后面板仍然能看到它花了多少 token、做了什么。
 * 外部 harness（Codex / Claude Code）不返回用量，只给「过程 + 最终答案」。
 */
async function collectWorkers(ctx, s, leadAgent, options, leadRead) {
  const workers = []
  if (s.teams && leadAgent) {
    let members = []
    try { members = s.teams.listMembers(leadAgent) ?? [] } catch { members = [] }
    for (const member of members) {
      if (member.role !== 'teammate') continue
      const read = await readSessionUsage(ctx, s, member.id)
      const lastLead = [...read.messages].reverse().find(message => message.role === 'lead' && message.text.trim())
      const model = member.model ?? null
      workers.push({
        name: member.name,
        id: member.id,
        status: member.status,
        description: member.description ?? '',
        provider: member.provider ?? null,
        model,
        parent: member.parent ?? null,
        diagnostics: member.diagnostics ?? [],
        usage: read.usage,
        cost: costOf(read.usage, priceOf(options, model ?? '')),
        lastText: lastLead ? lastLead.text.slice(0, WORKER_TEXT_LIMIT) : '',
        done: member.status !== 'running' && Boolean(lastLead),
      })
    }
  }
  workers.push(...externalWorkersFromEvents(leadRead?.events))
  return workers
}

/** 工人来源列表（可不可用取决于官方提供方是否注册）。 */
function harnessModeList(s, providerNames) {
  return HARNESS_MODES.map(mode => {
    const external = EXTERNAL_HARNESSES.find(item => item.id === mode.id)
    return {
      id: mode.id,
      label: mode.label,
      tool: external?.tool ?? null,
      available: mode.id === 'team'
        ? Boolean(s.teams)
        : mode.id === 'auto'
          ? Boolean(s.teams) || EXTERNAL_HARNESSES.some(item => providerNames.has(item.provider))
          : providerNames.has(external?.provider ?? ''),
    }
  })
}

const PANEL_SERVICES = s => ({
  controller: Boolean(s.controller),
  llm: Boolean(s.llm),
  projections: Boolean(s.projections),
  sessions: Boolean(s.sessions),
  agents: Boolean(s.agents),
  teams: Boolean(s.teams),
  subagents: Boolean(s.subagents),
})

/** 跨平台运行状态：正在跑的优先，否则读上次结果。 */
function collabRunState(state) {
  if (activeCollabRun) {
    return {
      mode: activeCollabRun.mode,
      task: activeCollabRun.task,
      startedAt: activeCollabRun.startedAt,
      finishedAt: null,
      running: true,
      entries: activeCollabRun.entries,
    }
  }
  const last = state.lastRun
  if (!last || !Array.isArray(last.entries) || last.entries.length === 0) return null
  return { ...last, running: false }
}

/** 跨平台面板共有的字段。 */
function collabStateOf(s, state, providerNames) {
  return {
    mode: collabModeOf(state),
    modes: COLLAB_MODES.map(({ id, label, hint }) => ({ id, label, hint })),
    picks: picksOf(state),
    platforms: COLLAB_PLATFORMS.map(platform => ({
      id: platform.id,
      label: platform.label,
      available: platform.id === 'dsh' ? Boolean(s.controller) : providerNames.has(platform.provider),
    })),
    lastRun: collabRunState(state),
  }
}

/** 面板要的全部状态。 */
async function collectState(ctx, options) {
  const s = services(ctx)
  const state = readState()
  const leaders = leaderOptions(s, options)
  const leader = leaders.find(item => item.id === state.leader) ?? leaders[0]
  const harnessLeader = leader.kind === 'harness'
  /** 已注册的外部 harness 提供方（Codex / Claude Code 由官方包注册到 ctx.subagents）。 */
  const providerNames = new Set((() => {
    try { return s.subagents?.list?.() ?? [] } catch { return [] }
  })())
  /** 外部 harness 的原生配置快照（当前模型 / 配置文件 / 可执行文件）。 */
  const harnessApps = harnessAppsOf(providerNames)
  const savedHarness = typeof state.harness === 'string' && HARNESS_MODES.some(item => item.id === state.harness)
    ? state.harness
    : 'team'
  const sessionId = state.leadSessionId ?? null

  // 外部 harness 当领导：对话记录由插件自己维护，用量拿不到。
  if (harnessLeader) {
    const messages = transcriptOf(leader.id)
    const running = Boolean(activeLeaderRun && activeLeaderRun.leaderId === leader.id)
    return {
      sessionId,
      sessionTitle: state.title ?? options.title,
      leader: leader.id,
      leaderKind: 'harness',
      ...collabStateOf(s, state, providerNames),
      leaders: leaders.map(({ id, kind, provider, label, available }) => ({ id, kind, provider, label, available })),
      leaderRun: running && activeLeaderRun
        ? { label: activeLeaderRun.label, dispatch: activeLeaderRun.dispatch, elapsedMs: Date.now() - activeLeaderRun.startedAt }
        : null,
      running,
      model: null,
      harnesses: harnessModeList(s, providerNames),
      harnessApps,
      dispatchHarness: savedHarness,
      models: { groups: [], failures: [] },
      messages,
      plan: extractPlan(messages),
      workers: [],
      progress: { done: 0, total: 0 },
      usage: {
        tokens: null, cost: null, currency: options.currency,
        elapsedMs: running && activeLeaderRun ? Date.now() - activeLeaderRun.startedAt : null,
        tokensPerSecond: null, etaMs: null, priced: false,
      },
      priceNote: '外部 harness 不回传 token，金额 / 速度只对 DSH 领导有效',
      services: PANEL_SERVICES(s),
    }
  }

  const session = sessionId ? (s.sessions?.get?.(sessionId) ?? null) : null
  const leadAgent = sessionId ? (s.agents?.get?.(sessionId) ?? null) : null
  const running = leadAgent?.status === 'running' || Boolean(session?.status === 'running')

  const messages = session ? readMessages(session, MAX_MESSAGES) : []
  const models = await listModels(s)

  const leadRead = await readSessionUsage(ctx, s, sessionId)
  const workers = await collectWorkers(ctx, s, leadAgent, options, leadRead)
  const leadUsage = leadRead.usage
  const leadStats = statsOf(s.projections, session)
  let usage = addUsage(null, leadUsage)
  const leadModel = modelSelectionOf(s.projections, session)?.pending?.model
    ?? modelSelectionOf(s.projections, session)?.lastUsed?.model
    ?? null
  let cost = costOf(leadUsage, priceOf(options, leadModel ?? ''))
  for (const worker of workers) {
    usage = addUsage(usage, worker.usage)
    cost += costOf(worker.usage, priceOf(options, worker.model ?? ''))
  }

  const tokens = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
  const decodeMs = leadStats?.decodeMs ?? 0
  const decodeTokens = leadStats?.decodeTokens ?? 0
  const tokensPerSecond = decodeMs > 0 ? decodeTokens / (decodeMs / 1000) : null

  const startedAt = state.jobStartedAt ?? session?.header?.createdAt ?? null
  const elapsedMs = startedAt ? Math.max(0, Date.now() - startedAt) : null
  const done = workers.filter(worker => worker.done).length
  const total = workers.length
  let etaMs = null
  if (total > 0 && done >= total) etaMs = 0
  else if (done > 0 && elapsedMs !== null) etaMs = Math.round(elapsedMs * (total - done) / done)
  else if (running && elapsedMs !== null) etaMs = null

  return {
    sessionId,
    sessionTitle: state.title ?? options.title,
    leader: leader.id,
    leaderKind: 'dsh',
    ...collabStateOf(s, state, providerNames),
    leaders: leaders.map(({ id, kind, provider, label, available }) => ({ id, kind, provider, label, available })),
    leaderRun: null,
    running,
    model: modelSelectionOf(s.projections, session),
    harnesses: harnessModeList(s, providerNames),
    harnessApps,
    dispatchHarness: savedHarness,
    models,
    messages,
    plan: extractPlan(messages),
    workers,
    progress: { done, total },
    usage: {
      ...usage,
      tokens,
      cost,
      currency: options.currency,
      elapsedMs,
      tokensPerSecond,
      etaMs,
      priced: true,
    },
    priceNote: '金额按内置牌价估算（元/百万 token），可在 profile 配置里覆盖',
    services: PANEL_SERVICES(s),
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function createApiHandler(ctx, options) {
  return async (req, res) => {
    if (!isLocalRequest(req)) { sendJson(res, 403, { ok: false, error: '仅允许本机访问' }); return }
    let url
    try { url = new URL(String(req.url), 'http://localhost') } catch { sendJson(res, 400, { ok: false, error: '非法 URL' }); return }
    const action = url.pathname.slice(options.route.length).replace(/^\//, '')
    const method = String(req.method ?? 'GET').toUpperCase()
    const postOnly = new Set(['ensure', 'send', 'dispatch', 'model', 'harness-model', 'open', 'cancel', 'leader', 'mode', 'picks', 'run'])
    if (postOnly.has(action) ? method !== 'POST' : method !== 'GET') {
      sendJson(res, 405, { ok: false, error: `不支持的方法 ${method}` })
      return
    }

    try {
      switch (action) {
        case 'state': {
          sendJson(res, 200, { ok: true, data: await collectState(ctx, options) })
          return
        }
        case 'health': {
          const s = services(ctx)
          sendJson(res, 200, {
            ok: true,
            data: {
              plugin: 'dsh-lead-panel',
              build: '2026-10-24T16:25',
              route: options.route,
              statePath: statePath(),
              state: readState(),
              harnesses: HARNESS_MODES.map(mode => mode.id),
              leaders: leaderOptions(s, options).map(item => item.id),
              modes: COLLAB_MODES.map(mode => mode.id),
              platforms: COLLAB_PLATFORMS.map(platform => platform.id),
              harnessApps: (() => {
                const names = new Set((() => {
                  try { return s.subagents?.list?.() ?? [] } catch { return [] }
                })())
                const apps = harnessAppsOf(names)
                return Object.fromEntries(Object.entries(apps).map(([id, info]) => [id, {
                  label: info.label,
                  model: info.model,
                  provider: info.provider,
                  bin: info.bin,
                  configPath: info.configPath,
                  configExists: info.configExists,
                }]))
              })(),
              services: {
                sessionController: Boolean(s.controller),
                llm: Boolean(s.llm),
                sessionProjections: Boolean(s.projections),
                sessions: Boolean(s.sessions),
                agents: Boolean(s.agents),
                agentTeams: Boolean(s.teams),
                subagents: Boolean(s.subagents),
                subagentsProviders: (() => { try { return s.subagents?.list?.() ?? [] } catch { return [] } })(),
                sessionPersistence: Boolean(service(ctx, 'sessionPersistence')),
              },
            },
          })
          return
        }
        case 'debug-session': {
          // 排查用：读一个会话 id 的持久日志，看能不能拿到用量。
          const id = url.searchParams.get('id') ?? readState().leadSessionId ?? ''
          const persistence = service(ctx, 'sessionPersistence')
          if (!persistence) { sendJson(res, 200, { ok: true, data: { error: 'sessionPersistence 不可用' } }); return }
          try {
            const handle = await persistence.open(id, 'read')
            try {
              const result = await handle.read(0, undefined)
              const usage = foldUsage(result.events)
              sendJson(res, 200, {
                ok: true,
                data: {
                  id,
                  inheritedEventCount: handle.inheritedEventCount ?? null,
                  events: result.events?.length ?? 0,
                  assistantMessages: (result.events ?? []).filter(event => event.type === 'assistant/message').length,
                  usage,
                },
              })
            } finally {
              await handle.close()
            }
          } catch (error) {
            sendJson(res, 200, { ok: true, data: { id, error: describeError(error) } })
          }
          return
        }
        case 'ensure': {
          const body = await readJsonBody(req)
          const reset = body.reset === true || body.reset === 1
          if (reset) {
            // 外部 harness 当领导时，「重开」= 清空面板里的对话记录
            const leader = resolveLeader(services(ctx), options)
            if (leader.kind === 'harness') {
              const all = { ...(readState().transcripts ?? {}) }
              delete all[leader.id]
              writeState({ transcripts: all })
            }
            writeState({ lastRun: null })
          }
          const result = await ensureLead(ctx, options, reset)
          sendJson(res, 200, { ok: true, data: result })
          return
        }
        case 'send': {
          const body = await readJsonBody(req)
          const text = String(body.text ?? '').trim()
          if (!text) throw new Error('消息内容为空')
          const s = services(ctx)
          const leader = resolveLeader(s, options)
          if (leader.kind === 'harness') {
            appendTranscript(leader.id, { role: 'user', text })
            void runHarnessLeaderTurn(ctx, options, leader, text, false)
            sendJson(res, 200, { ok: true, data: { sessionId: readState().leadSessionId ?? null, leader: leader.id, queued: true } })
            return
          }
          const result = await sendToLead(ctx, options, text)
          sendJson(res, 200, { ok: true, data: result })
          return
        }
        case 'dispatch': {
          const body = await readJsonBody(req)
          const need = String(body.text ?? '').trim()
          const s = services(ctx)
          const leader = resolveLeader(s, options)
          if (leader.kind === 'harness') {
            appendTranscript(leader.id, { role: 'user', text: `【总结并派活】${need || '(见上文)'}` })
            void runHarnessLeaderTurn(ctx, options, leader, need || '(见上文)', true)
            writeState({ jobStartedAt: Date.now() })
            sendJson(res, 200, { ok: true, data: { sessionId: readState().leadSessionId ?? null, leader: leader.id, dispatch: true } })
            return
          }
          const requested = String(body.harness ?? '').trim()
          const harness = requested || readState().harness || 'team'
          if (!HARNESS_MODES.some(item => item.id === harness)) throw new Error(`未知的工人来源：${harness}`)
          const text = `${dispatchInstruction(harness)}${need || '(见上文)'}`
          const result = await sendToLead(ctx, options, text)
          writeState({ jobStartedAt: Date.now(), harness })
          sendJson(res, 200, { ok: true, data: { ...result, harness } })
          return
        }
        case 'leader': {
          const s = services(ctx)
          const body = await readJsonBody(req)
          const id = String(body.leader ?? '').trim()
          const leaders = leaderOptions(s, options)
          const picked = leaders.find(item => item.id === id)
          if (!picked) throw new Error(`未知的领导平台：${id}`)
          if (!picked.available) throw new Error(`领导平台不可用：${picked.label}`)
          writeState({ leader: picked.id })
          sendJson(res, 200, { ok: true, data: { leader: picked.id, label: picked.label } })
          return
        }
        case 'mode': {
          const body = await readJsonBody(req)
          const mode = String(body.mode ?? '').trim()
          if (!COLLAB_MODES.some(item => item.id === mode)) throw new Error(`未知的协作模式：${mode}`)
          writeState({ mode })
          sendJson(res, 200, { ok: true, data: { mode } })
          return
        }
        case 'picks': {
          const body = await readJsonBody(req)
          const picks = normalizePicks(body.picks)
          if (picks.length === 0) throw new Error('至少勾选一个平台')
          writeState({ picks })
          sendJson(res, 200, { ok: true, data: { picks } })
          return
        }
        case 'run': {
          const s = services(ctx)
          const body = await readJsonBody(req)
          const stateNow = readState()
          const mode = String(body.mode ?? '').trim() || collabModeOf(stateNow)
          const asked = normalizePicks(body.picks)
          const picks = asked.length > 0 ? asked : picksOf(stateNow)
          const task = String(body.text ?? '').trim()
          if (!task) throw new Error('任务内容为空')
          if (mode === 'single' || !COLLAB_MODES.some(item => item.id === mode)) {
            throw new Error('「单平台」模式请直接用「总结并派活」或「发送」')
          }
          writeState({ mode, picks })
          if (mode === 'split') {
            const leader = resolveLeader(s, options)
            if (leader.kind !== 'dsh') throw new Error('分工模式需要 DSH 官方当领导（先把「领导平台」切回 DSH 官方）')
            const result = await sendToLead(ctx, options, `${dispatchInstructionFor(picks)}${task}`)
            writeState({ jobStartedAt: Date.now() })
            sendJson(res, 200, { ok: true, data: { sessionId: result.sessionId, mode, picks } })
            return
          }
          if (activeCollabRun) throw new Error('已经有一次会诊 / 流水线在跑：等它结束，或点「打断」')
          void startCollabRun(ctx, options, mode, task, picks)
          sendJson(res, 200, { ok: true, data: { mode, picks, queued: true } })
          return
        }
        case 'model': {
          const s = services(ctx)
          if (!s.controller) throw new Error('sessionController 服务不可用')
          if (resolveLeader(s, options).kind === 'harness') {
            throw new Error('当前领导是外部 harness：请在「领导模型」里换（写它自己的配置），或换「领导平台」')
          }
          const body = await readJsonBody(req)
          const provider = String(body.provider ?? '').trim()
          const model = String(body.model ?? '').trim()
          if (!provider || !model) throw new Error('缺少 provider 或 model')
          const { sessionId } = await ensureLead(ctx, options, false)
          const selected = await s.controller.selectModel({ sessionId, provider, model })
          writeState({ model: { provider, model } })
          sendJson(res, 200, { ok: true, data: { sessionId, selected: selected?.selected ?? { provider, model } } })
          return
        }
        case 'harness-model': {
          const body = await readJsonBody(req)
          const platform = String(body.platform ?? '').trim()
          const model = typeof body.model === 'string' ? body.model : ''
          const result = writeHarnessModel(platform, model)
          sendJson(res, 200, { ok: true, data: result })
          return
        }
        case 'open': {
          // 只认白名单里的平台与动作，不接受任意命令。
          const body = await readJsonBody(req)
          const platform = String(body.platform ?? '').trim()
          const what = body.what === 'config' ? 'config' : 'app'
          const plan = planOpen(platform, what)
          launchDetached(plan)
          sendJson(res, 200, {
            ok: true,
            data: { platform, what, target: plan.target, label: plan.label },
          })
          return
        }
        case 'cancel': {
          const s = services(ctx)
          if (activeCollabRun) {
            for (const controller of activeCollabRun.controllers) controller.abort()
            sendJson(res, 200, { ok: true, data: { cancelled: true, mode: activeCollabRun.mode } })
            return
          }
          const leader = resolveLeader(s, options)
          if (leader.kind === 'harness') {
            if (activeLeaderRun && activeLeaderRun.leaderId === leader.id) {
              activeLeaderRun.controller.abort()
              sendJson(res, 200, { ok: true, data: { cancelled: true, leader: leader.id } })
              return
            }
            sendJson(res, 200, { ok: true, data: { cancelled: false } })
            return
          }
          if (!s.controller) throw new Error('sessionController 服务不可用')
          const state = readState()
          if (!state.leadSessionId) { sendJson(res, 200, { ok: true, data: { cancelled: false } }); return }
          s.controller.cancel({ sessionId: state.leadSessionId })
          sendJson(res, 200, { ok: true, data: { cancelled: true } })
          return
        }
        default:
          sendJson(res, 404, { ok: false, error: `未知接口 ${action || '(空)'}` })
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: describeError(error) })
    }
  }
}

/**
 * 纯函数出口，只给自检脚本用（`node test/self-check.mjs`）。
 * 它们不碰 ctx，所以在 DSH 之外也能跑，改完算法先在这里验一遍。
 */
export const internals = {
  normalizeConfig,
  num,
  foldUsage,
  usageIsEmpty,
  extractPlan,
  costOf,
  addUsage,
  readMessagesFromEvents,
  textOf,
  callsOf,
  priceOf,
  dispatchInstruction,
  externalWorkersFromEvents,
  parseToolArguments,
  HARNESS_MODES,
  EXTERNAL_HARNESSES,
  leaderOptions,
  buildLeaderPrompt,
  transcriptOf,
  appendTranscript,
  LEADER_DSH,
  DEFAULT_LEADER_LABELS,
  COLLAB_MODES,
  COLLAB_PLATFORMS,
  normalizePicks,
  picksOf,
  dispatchInstructionFor,
  buildConsultPrompt,
  buildPipelinePrompt,
  parseCodexConfig,
  applyCodexModel,
  applyClaudeModel,
  normalizeModelId,
  harnessAppInfo,
  harnessAppsOf,
  writeHarnessModel,
  planOpen,
  HARNESS_APPS,
}

export function apply(ctx, config) {
  const options = normalizeConfig(config)
  const log = message => {
    try { ctx.logger?.info?.(`[dsh-lead-panel] ${message}`) } catch { /* 日志失败不影响功能 */ }
  }
  log(`已加载（route=${options.route}）`)

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: options.route,
        handler: createApiHandler(ctx, options),
      }),
      `dsh-lead-panel: ${options.route}`,
    )
    log(`已注册界面接口 ${options.route}`)
  })
}
