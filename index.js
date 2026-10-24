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
//   POST /lead-panel/api/model      { provider, model } 切换领导的模型
//   POST /lead-panel/api/cancel                        打断领导当前回合
//
// 只用 ctx 上的服务（sessionController / agents / sessions / llm /
// sessionProjections / agentTeams），不直接 import DSH 内部包，避免版本漂移。
// ============================================================================

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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
      leaders: leaders.map(({ id, kind, provider, label, available }) => ({ id, kind, provider, label, available })),
      leaderRun: running && activeLeaderRun
        ? { label: activeLeaderRun.label, dispatch: activeLeaderRun.dispatch, elapsedMs: Date.now() - activeLeaderRun.startedAt }
        : null,
      running,
      model: null,
      harnesses: harnessModeList(s, providerNames),
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
    leaders: leaders.map(({ id, kind, provider, label, available }) => ({ id, kind, provider, label, available })),
    leaderRun: null,
    running,
    model: modelSelectionOf(s.projections, session),
    harnesses: harnessModeList(s, providerNames),
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
    const postOnly = new Set(['ensure', 'send', 'dispatch', 'model', 'cancel', 'leader'])
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
              build: '2026-10-24T16:10',
              route: options.route,
              statePath: statePath(),
              state: readState(),
              harnesses: HARNESS_MODES.map(mode => mode.id),
              leaders: leaderOptions(s, options).map(item => item.id),
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
        case 'model': {
          const s = services(ctx)
          if (!s.controller) throw new Error('sessionController 服务不可用')
          if (resolveLeader(s, options).kind === 'harness') {
            throw new Error('当前领导是外部 harness，模型由它自己的配置决定；要换领导请用「领导平台」')
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
        case 'cancel': {
          const s = services(ctx)
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
