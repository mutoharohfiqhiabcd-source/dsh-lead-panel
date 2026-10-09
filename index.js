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

/** 派活指令：约束领导按四段回答，并真的把活派下去。 */
const DISPATCH_INSTRUCTION = `你现在是指挥层的「领导」。请严格按下面四段用中文回答，不要写第四段之外的内容，回答完立刻用 spawn_teammate 把工作派给工人 AI（名字用 lower-kebab-case，prompt 写清验收标准）：

【需求】用户到底要什么（一句话）
【效果】做完之后用户能看到什么
【分工】每个工人 AI 的名字 + 它负责什么 + 预计耗时，一行一个
【预计时间】整件事大概要多久

派活要求：每个工人只做一件边界清晰的事；能并行就并行；工人之间不要重叠改同一个文件。

用户的原始需求如下：
`

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

function totalsOf(projections, session) {
  if (!projections || !session) return null
  try {
    const state = projections.stateOf(session, 'tokenUsage')
    const totals = state?.totals
    if (!totals) return null
    return {
      uncachedInputTokens: totals.uncachedInputTokens ?? 0,
      cacheReadTokens: totals.cacheReadTokens ?? 0,
      cacheWriteTokens: totals.cacheWriteTokens ?? 0,
      outputTokens: totals.outputTokens ?? 0,
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
    total.uncachedInputTokens += usage.inputTokens ?? 0
    total.cacheReadTokens += usage.cacheReadTokens ?? 0
    total.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    total.outputTokens += usage.outputTokens ?? 0
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
  if (!sessionId) return { live: false, usage: null, messages: [] }
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
    }
  }
  const persistence = service(ctx, 'sessionPersistence')
  if (!persistence) return { live: false, usage: null, messages: [] }
  try {
    const handle = await persistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read(0, undefined)
      return { live: false, usage: foldUsage(events), messages: readMessagesFromEvents(events, 200) }
    } finally {
      await handle.close()
    }
  } catch {
    return { live: false, usage: null, messages: [] }
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
    uncachedInputTokens: base.uncachedInputTokens + (right.uncachedInputTokens ?? 0),
    cacheReadTokens: base.cacheReadTokens + (right.cacheReadTokens ?? 0),
    cacheWriteTokens: base.cacheWriteTokens + (right.cacheWriteTokens ?? 0),
    outputTokens: base.outputTokens + (right.outputTokens ?? 0),
  }
}

function costOf(usage, price) {
  if (!usage) return 0
  const cached = usage.cacheReadTokens + usage.cacheWriteTokens
  return (usage.uncachedInputTokens * price.input + cached * price.cacheRead + usage.outputTokens * price.output) / 1_000_000
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
 * 领导的工人们：Agent Teams 名册 + 每人自己的用量、最后一句结论。
 * worker 干完活会被卸载，所以这里对每个工人走一遍「活会话优先、否则读持久日志」，
 * 这样它 settle 之后面板仍然能看到它花了多少 token、做了什么。
 */
async function collectWorkers(ctx, s, leadAgent, options) {
  if (!s.teams || !leadAgent) return []
  let members = []
  try { members = s.teams.listMembers(leadAgent) ?? [] } catch { return [] }
  const workers = []
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
  return workers
}

/** 面板要的全部状态。 */
async function collectState(ctx, options) {
  const s = services(ctx)
  const state = readState()
  const sessionId = state.leadSessionId ?? null
  const session = sessionId ? (s.sessions?.get?.(sessionId) ?? null) : null
  const leadAgent = sessionId ? (s.agents?.get?.(sessionId) ?? null) : null
  const running = leadAgent?.status === 'running' || Boolean(session?.status === 'running')

  const messages = session ? readMessages(session, MAX_MESSAGES) : []
  const workers = await collectWorkers(ctx, s, leadAgent, options)
  const models = await listModels(s)

  const leadRead = await readSessionUsage(ctx, s, sessionId)
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
    running,
    model: modelSelectionOf(s.projections, session),
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
    services: {
      controller: Boolean(s.controller),
      llm: Boolean(s.llm),
      projections: Boolean(s.projections),
      sessions: Boolean(s.sessions),
      agents: Boolean(s.agents),
      teams: Boolean(s.teams),
    },
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
    const postOnly = new Set(['ensure', 'send', 'dispatch', 'model', 'cancel'])
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
              build: '2026-10-09T19:40',
              route: options.route,
              statePath: statePath(),
              state: readState(),
              services: {
                sessionController: Boolean(s.controller),
                llm: Boolean(s.llm),
                sessionProjections: Boolean(s.projections),
                sessions: Boolean(s.sessions),
                agents: Boolean(s.agents),
                agentTeams: Boolean(s.teams),
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
          const result = await ensureLead(ctx, options, body.reset === true || body.reset === 1)
          sendJson(res, 200, { ok: true, data: result })
          return
        }
        case 'send': {
          const body = await readJsonBody(req)
          const result = await sendToLead(ctx, options, String(body.text ?? ''))
          sendJson(res, 200, { ok: true, data: result })
          return
        }
        case 'dispatch': {
          const body = await readJsonBody(req)
          const need = String(body.text ?? '').trim()
          const text = `${DISPATCH_INSTRUCTION}${need || '(见上文)'}`
          const result = await sendToLead(ctx, options, text)
          writeState({ jobStartedAt: Date.now() })
          sendJson(res, 200, { ok: true, data: result })
          return
        }
        case 'model': {
          const s = services(ctx)
          if (!s.controller) throw new Error('sessionController 服务不可用')
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
  foldUsage,
  usageIsEmpty,
  extractPlan,
  costOf,
  addUsage,
  readMessagesFromEvents,
  textOf,
  callsOf,
  priceOf,
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
