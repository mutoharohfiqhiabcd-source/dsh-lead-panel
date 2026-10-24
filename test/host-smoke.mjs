// ============================================================================
// dsh-lead-panel Host 半边冒烟测试（不依赖 DSH）
// ----------------------------------------------------------------------------
//   node test/host-smoke.mjs
//
// 用假的 ctx / 假服务把 index.js 的 HTTP 处理器整条链路跑一遍，重点验证
// 「面板为什么点不动」这类问题：
//   · POST /send、/dispatch 必须给 sessionController.prompt 传 AbortSignal
//   · GET  /state 要返回计划卡片、工人用量（含已卸载工人读持久日志）
//   · 金额按牌价折算、错误以 JSON 返回而不是抛出去
// ============================================================================

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 别把测试会话写进真实的 ~/.dsh/lead-panel/state.json（否则会把正在用的面板切走）；
// 每次重跑前清空临时 home，避免上一次的「领导平台」选择污染下一次。
const smokeHome = join(tmpdir(), 'dsh-lead-panel-smoke-home')
rmSync(smokeHome, { recursive: true, force: true })
process.env.DSH_HOME = smokeHome

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.log(`✗ ${name}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`)
  } else console.log(`✓ ${name}`)
}
function checkTrue(name, value) { check(name, Boolean(value), true) }

// ── 假世界：一个领导会话 + 两个工人（一个活着、一个已卸载但有持久日志）──────
const LEAD = 'session-lead'
const WORKER_LIVE = 'session-worker-live'
const WORKER_COLD = 'session-worker-cold'

const assistant = (input, cache, output) => ({
  type: 'assistant/message',
  time: 1,
  data: { message: { content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: input, cacheReadTokens: cache, outputTokens: output } },
})
const userEvent = text => ({ type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })

const leadEvents = [
  userEvent('把 README 安装步骤写清楚'),
  { type: 'user/message', time: 2, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context…' }] } },
  assistant('1000', '9000', '500'),
  {
    type: 'assistant/message',
    time: 3,
    data: {
      message: {
        content: [
          { type: 'text', text: '【需求】写清安装步骤\n【效果】新人三步装好\n【分工】\n- readme-writer：改安装节\n- link-checker：查链接\n【预计时间】10 分钟' },
          { type: 'tool-call', name: 'spawn_teammate' },
        ],
      },
      usage: { inputTokens: '2000', cacheReadTokens: 0, outputTokens: 300 },
    },
  },
  // 外部 harness：Codex 的一次运行（tool/call + tool/result）
  {
    type: 'tool/call',
    time: 4,
    data: { turn: 1, step: 1, callId: 'call-codex-1', name: 'subagent_codex', arguments: JSON.stringify({ description: '重写安装节', prompt: '把 README 安装节改成三步' }) },
  },
  {
    type: 'tool/result',
    time: 5,
    data: { message: { source: { callId: 'call-codex-1' }, content: [{ type: 'text', text: 'README 安装节已重写为三步' }] } },
  },
]

const sessions = new Map([
  [LEAD, {
    header: { createdAt: Date.now() - 60_000 },
    status: 'idle',
    snapshotEvents: () => leadEvents,
  }],
  [WORKER_LIVE, { header: {}, status: 'running', snapshotEvents: () => [assistant('300', '0', '120')] }],
])

const prompts = []
const selected = []
const subagentRuns = []
let subagentReply = '（默认外部 harness 回复）'
const persisted = {
  [WORKER_COLD]: [
    { type: 'assistant/message', time: 1, data: { message: { content: [{ type: 'text', text: '链接检查完成，0 个坏链' }] }, usage: { inputTokens: '400', cacheReadTokens: '100', outputTokens: '80' } } },
  ],
}

const ctx = {
  logger: { info: () => {}, warn: () => {} },
  inject: (deps, callback) => { callback({ effect: fn => fn(), webServer: { register: options => { ctx.route = options } } }) },
  get: name => ({
    sessionController: {
      create: async () => ({ sessionId: LEAD, agentPreset: 'standard' }),
      resolveAgent: async id => (sessions.has(id) ? { agent: { session: sessions.get(id) } } : { error: new Error('not found') }),
      rename: async () => ({ title: '领导', seq: 1 }),
      selectModel: async request => { selected.push(request); return { selected: { provider: request.provider, model: request.model } } },
      prompt: async (request, signal) => { prompts.push({ request, signal }); return { accepted: true } },
      cancel: () => ({ cancelled: true }),
    },
    llm: {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }],
    },
    sessions: { get: id => sessions.get(id) ?? null },
    agents: { get: id => (id === LEAD ? { id: LEAD, session: sessions.get(LEAD), status: 'idle' } : undefined) },
    sessionProjections: {
      stateOf: (session, key) => {
        if (key === 'modelSelection') return { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' }, pending: null }
        if (key === 'tokenUsage') return session === sessions.get(LEAD) ? { totals: { uncachedInputTokens: 3000, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 800 } } : undefined
        if (key === 'sessionStats') return session === sessions.get(LEAD) ? { decodeMs: 4000, decodeTokens: 800, turns: 1, steps: 2 } : undefined
        return undefined
      },
    },
    agentTeams: {
      listMembers: () => [
        { id: LEAD, name: 'lead', role: 'lead', status: 'idle' },
        { id: WORKER_LIVE, name: 'readme-writer', role: 'teammate', status: 'running', description: '改 README 安装节', provider: 'spawn', model: 'deepseek-flash', diagnostics: [] },
        { id: WORKER_COLD, name: 'link-checker', role: 'teammate', status: 'inactive', description: '查链接', provider: 'spawn', model: 'deepseek-flash', diagnostics: [] },
      ],
    },
    sessionPersistence: {
      open: async id => ({
        header: {}, inheritedEventCount: 0,
        read: async () => ({ events: persisted[id] ?? [] }),
        close: async () => {},
      }),
    },
    // 官方 Codex / Claude Code 提供方已注册（面板据此点亮「工人来源」/「领导平台」）
    subagents: {
      list: () => ['spawn', 'fork', 'codex', 'claude-code'],
      start: async (provider, request) => {
        subagentRuns.push({ provider, ...request })
        return {
          id: 'run-1',
          result: Promise.resolve({ output: [{ type: 'text', text: subagentReply }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
  })[name] ?? null,
}

const { apply, internals } = await import(`file://${join(root, 'index.js').replace(/\\/g, '/')}`)
const { normalizeConfig } = internals
apply(ctx, { route: '/lead-panel/api' })
checkTrue('注册了 HTTP 路由', Boolean(ctx.route) && ctx.route.path === '/lead-panel/api')

// 最小 req/res 桩：把处理器当纯函数驱动
function request(method, action, body, query = '') {
  const req = {
    method, url: `/lead-panel/api/${action}${query}`, socket: { remoteAddress: '127.0.0.1' },
    on: (event, handler) => {
      if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body)))
      if (event === 'end') handler()
    },
  }
  let status = 0
  let payload = ''
  const res = {
    writeHead: code => { status = code },
    end: text => { payload = text },
  }
  return ctx.route.handler(req, res).then(() => ({ status, body: JSON.parse(payload || '{}') }))
}

const health = await request('GET', 'health')
check('health 状态码 200', health.status, 200)
check('health 带 build 标记', health.body.data.build, '2026-10-24T16:10')
checkTrue('health 报出领导平台', health.body.data.leaders.includes('dsh') && health.body.data.leaders.includes('harness:codex'))
checkTrue('health 报出 subagents 提供方', health.body.data.services.subagentsProviders.includes('codex'))
checkTrue('health 报出持久化服务可用', health.body.data.services.sessionPersistence)

// /send 必须把 signal 传给 prompt（旧代码就是漏了这个才报 throwIfAborted）
const sent = await request('POST', 'send', { text: '你好' })
check('send 200', sent.status, 200)
checkTrue('send 传了 AbortSignal', prompts.at(-1)?.signal !== undefined && typeof prompts.at(-1).signal.throwIfAborted === 'function')
check('send 文本进了会话', prompts.at(-1).request.content[0].text, '你好')
check('send 带 client 校验字段 requestId', typeof prompts.at(-1).request.requestId, 'string')

const dispatched = await request('POST', 'dispatch', { text: '把 README 弄好' })
check('dispatch 200', dispatched.status, 200)
checkTrue('dispatch 用的是固定四段指令', prompts.at(-1).request.content[0].text.includes('【需求】'))
checkTrue('dispatch 带上用户需求', prompts.at(-1).request.content[0].text.includes('把 README 弄好'))
checkTrue('dispatch 默认用官方团队', prompts.at(-1).request.content[0].text.includes('spawn_teammate'))

// 派给外部 harness：指令里必须点名官方工具，并且不再让领导 spawn_teammate
const codexDispatch = await request('POST', 'dispatch', { text: '重写安装节', harness: 'codex' })
check('dispatch 指定 codex 200', codexDispatch.status, 200)
check('dispatch 回显来源', codexDispatch.body.data.harness, 'codex')
checkTrue('codex 指令点名 subagent_codex', prompts.at(-1).request.content[0].text.includes('subagent_codex'))
checkTrue('codex 指令明确不组队', prompts.at(-1).request.content[0].text.includes('不要调用 spawn_teammate'))

const badDispatch = await request('POST', 'dispatch', { text: 'x', harness: 'nope' })
check('未知工人来源 500', badDispatch.status, 500)
checkTrue('未知工人来源报错', String(badDispatch.body.error).includes('未知的工人来源'))

const modeled = await request('POST', 'model', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
check('model 200', modeled.status, 200)
check('model 透传给 sessionController', selected.at(-1), { sessionId: LEAD, provider: 'deepseek-official', model: 'deepseek-v4-pro' })

const state = await request('GET', 'state')
check('state 200', state.status, 200)
const data = state.body.data
check('state 消息只留对话（过滤运行时注入）', data.messages.map(m => m.role), ['user', 'lead', 'lead'])
check('state 抓到计划卡片', [data.plan.need, data.plan.effect, data.plan.eta], ['写清安装步骤', '新人三步装好', '10 分钟'])
checkTrue('state 计划分工含两个工人', data.plan.split.includes('readme-writer') && data.plan.split.includes('link-checker'))
check('state 工人数', data.workers.length, 3)
check('state 活工人用量来自投影', data.workers[0].usage.outputTokens, 120)
check('state 卸载工人用量来自持久日志', data.workers[1].usage, { uncachedInputTokens: 400, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 80 })
checkTrue('字符串计数被强制转成数字（不是拼接）', data.workers[1].usage.uncachedInputTokens === 400 && typeof data.workers[1].usage.uncachedInputTokens === 'number')
check('state 卸载工人最后一句结论', data.workers[1].lastText.startsWith('链接检查完成'), true)
check('state 工人标记完成', data.workers[1].done, true)
// 外部 harness：从 tool/call + tool/result 还原，不计 token
check('state 外部工人来自 Codex', [data.workers[2].external, data.workers[2].harness], [true, 'codex'])
check('state 外部工人状态', data.workers[2].status, 'done')
check('state 外部工人最终答案', data.workers[2].lastText.startsWith('README 安装节已重写'), true)
check('state 外部工人不算 token', data.workers[2].usage, null)
check('state 外部工人标记完成', data.workers[2].done, true)
// 工人来源：四种模式，官方提供方已注册 → Codex / Claude Code 可用
check('state 工人来源列表', data.harnesses.map(item => item.id), ['team', 'codex', 'claude-code', 'auto'])
check('state Codex 可用', data.harnesses.find(item => item.id === 'codex').available, true)
check('state Claude Code 可用', data.harnesses.find(item => item.id === 'claude-code').available, true)
check('state 记住上次派活来源', data.dispatchHarness, 'codex')
// 领导 3000/9000/0/800 + 活工人 300/0/0/120 + 冷工人 400/100/0/80 = 13800
check('state token 合计', data.tokens ?? data.usage.tokens, 13800)
// 牌价 deepseek-flash: 未命中 2 / 命中 0.2 / 输出 3（元每百万）
const expectedCost = (3700 * 2 + 9100 * 0.2 + 1000 * 3) / 1_000_000
check('state 金额估算', Math.abs(data.usage.cost - expectedCost) < 1e-9, true)
check('state 速度（tok/s）', Math.round(data.usage.tokensPerSecond), 200)
check('state 进度', data.progress, { done: 2, total: 3 })

const debug = await request('GET', 'debug-session', undefined, `?id=${WORKER_COLD}`)
check('debug-session 读到冷会话事件数', debug.body.data.assistantMessages, 1)

// ── 外部 harness 当领导：Codex 直接聊天 / 派活 ──────────────────────────────
check('state 领导平台列表', data.leaders.map(item => item.id), ['dsh', 'harness:codex', 'harness:claude-code'])
check('默认领导是 DSH', data.leader, 'dsh')
const switched = await request('POST', 'leader', { leader: 'harness:codex' })
check('切换领导平台 200', switched.status, 200)
check('切换后领导是 Codex', switched.body.data.leader, 'harness:codex')
const badLeader = await request('POST', 'leader', { leader: 'nope' })
check('未知领导平台 500', badLeader.status, 500)

subagentReply = '收到，我是 GPT，正在看你的需求。'
await request('POST', 'send', { text: '你好，你是谁？' })
await new Promise(resolve => setTimeout(resolve, 30))
const harnessState = (await request('GET', 'state')).body.data
check('Codex 领导类型', harnessState.leaderKind, 'harness')
check('Codex 领导对话记录', harnessState.messages.map(message => message.role), ['user', 'lead'])
checkTrue('Codex 领导回复进了面板', harnessState.messages[1].text.includes('我是 GPT'))
check('Codex 领导没有工人列表', harnessState.workers.length, 0)
check('Codex 领导 token 未知', harnessState.usage.tokens, null)
check('Codex 领导模型下拉为空', harnessState.models.groups.length, 0)
checkTrue('外部 run 用的是 codex 提供方', subagentRuns.at(-1).provider === 'codex')
checkTrue('第二轮 prompt 带上了上一轮对话', subagentRuns.at(-1).prompt[0].text.includes('你好，你是谁'))

subagentReply = '【需求】改 README\n【效果】新人能看懂\n【分工】Codex 直接改\n【预计时间】2 分钟\n已经改好了'
await request('POST', 'dispatch', { text: '把 README 改好' })
await new Promise(resolve => setTimeout(resolve, 30))
const harnessAfterDispatch = (await request('GET', 'state')).body.data
check('Codex 领导派活出了计划卡', [harnessAfterDispatch.plan.need, harnessAfterDispatch.plan.effect], ['改 README', '新人能看懂'])
checkTrue('派活 prompt 带四段格式要求', subagentRuns.at(-1).prompt[0].text.includes('【预计时间】'))
const modelBlocked = await request('POST', 'model', { provider: 'deepseek-official', model: 'deepseek-flash' })
check('Codex 领导不能切模型', modelBlocked.status, 500)

const missing = await request('GET', 'nope')
check('未知接口 404', missing.status, 404)

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
