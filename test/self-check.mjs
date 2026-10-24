// ============================================================================
// dsh-lead-panel 自检脚本（不依赖 DSH，直接 node 跑）
// ----------------------------------------------------------------------------
//   node test/self-check.mjs
//
// 覆盖两块最容易出错、又没法靠肉眼确认的逻辑：
//   1) Host 半边的纯函数：用量折叠、计划抽取、金额折算、消息过滤
//   2) 浏览器半边：在假的 window.__ModuleLoader__ / react 下能否正常注册槽位
// ============================================================================

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.log(`✗ ${name}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`)
  } else {
    console.log(`✓ ${name}`)
  }
}
function checkTrue(name, value) {
  check(name, Boolean(value), true)
}

const { internals } = await import(`file://${join(root, 'index.js').replace(/\\/g, '/')}`)
const {
  foldUsage, usageIsEmpty, extractPlan, costOf, addUsage, readMessagesFromEvents,
  normalizeConfig, priceOf, dispatchInstruction, externalWorkersFromEvents, parseToolArguments,
  HARNESS_MODES, leaderOptions, buildLeaderPrompt, LEADER_DSH, DEFAULT_LEADER_LABELS,
  COLLAB_MODES, normalizePicks, picksOf, dispatchInstructionFor, buildConsultPrompt, buildPipelinePrompt,
} = internals

// ── 1) 用量折叠：四个桶互不重叠，按事件累加 ─────────────────────────────────
const events = [
  { type: 'turn/start', data: {} },
  { type: 'assistant/message', data: { usage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 50 } } },
  { type: 'assistant/message', data: {} },
  { type: 'assistant/message', data: { usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5 } } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
]
check('foldUsage 累加三个辅助桶', foldUsage(events), {
  uncachedInputTokens: 110, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 55,
})
check('foldUsage 无用量事件返回 null', foldUsage([{ type: 'turn/start', data: {} }]), null)
checkTrue('usageIsEmpty 判定全零', usageIsEmpty({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }))
check('usageIsEmpty 判定非零', usageIsEmpty({ outputTokens: 1 }), false)

// ── 2) 金额折算：未命中输入 / 命中输入 / 输出 三档 ──────────────────────────
check('costOf 三档折算（元/百万）', costOf(
  { uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 },
  { input: 2, cacheRead: 0.2, output: 3 },
), 5.2)
check('costOf 空用量为 0', costOf(null, { input: 2, cacheRead: 0.2, output: 3 }), 0)
check('addUsage 合并', addUsage(
  { uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 },
  { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 40 },
), { uncachedInputTokens: 11, cacheReadTokens: 22, cacheWriteTokens: 3, outputTokens: 44 })

// ── 3) 计划抽取：领导的四段式回复 ──────────────────────────────────────────
const planText = `已经派活。

【需求】把 README 的安装步骤写清楚
【效果】新人照着三步能装好
【分工】
- readme-writer：改 README 安装节，预计 5 分钟
- link-checker：跑一遍链接检查，预计 2 分钟
【预计时间】10 分钟`
const messages = [
  { role: 'user', text: '帮我把 README 弄好' },
  { role: 'lead', text: '收到', calls: ['spawn_teammate'] },
  { role: 'lead', text: planText, calls: ['spawn_teammate'] },
]
const plan = extractPlan(messages)
check('extractPlan 需求', plan.need, '把 README 的安装步骤写清楚')
check('extractPlan 效果', plan.effect, '新人照着三步能装好')
checkTrue('extractPlan 分工含两个工人', plan.split.includes('readme-writer') && plan.split.includes('link-checker'))
check('extractPlan 预计时间', plan.eta, '10 分钟')
check('extractPlan 无计划返回 null', extractPlan([{ role: 'lead', text: '随便聊聊' }]), null)

// ── 4) 消息过滤：只保留真正的用户消息，丢掉运行时注入 ──────────────────────
const filtered = readMessagesFromEvents([
  { type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我要什么' }] } },
  { type: 'user/message', time: 2, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context…' }] } },
  { type: 'user/message', time: 3, data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS.md…' }] } },
  { type: 'assistant/message', time: 4, data: { message: { content: [{ type: 'text', text: '好的' }, { type: 'tool-call', name: 'spawn_teammate' }] } } },
], 40)
check('readMessagesFromEvents 只留用户与助手', filtered.map(m => m.role), ['user', 'lead'])
check('readMessagesFromEvents 工具名带上', filtered[1].calls, ['spawn_teammate'])

// ── 5) 配置与价目表 ────────────────────────────────────────────────────────
const options = normalizeConfig({ prices: { 'my-model': { input: 9, cacheRead: 1, output: 9 } }, currency: '$' })
check('价目表可覆盖', priceOf(options, 'my-model'), { input: 9, cacheRead: 1, output: 9 })
checkTrue('未知模型走默认牌价', priceOf(options, '未知模型').input === 2)
check('默认 route', options.route, '/lead-panel/api')

// ── 6) 工人来源与外部 harness（Codex / Claude Code）───────────────────────
check('工人来源四种模式', HARNESS_MODES.map(item => item.id), ['team', 'codex', 'claude-code', 'auto'])
checkTrue('团队指令用 spawn_teammate', dispatchInstruction('team').includes('spawn_teammate'))
checkTrue('codex 指令点名 subagent_codex', dispatchInstruction('codex').includes('subagent_codex'))
checkTrue('codex 指令明确不组队', dispatchInstruction('codex').includes('不要调用 spawn_teammate'))
checkTrue('claude 指令点名 subagent_claude_code', dispatchInstruction('claude-code').includes('subagent_claude_code'))
checkTrue('未知来源回退官方团队', dispatchInstruction('nope').includes('spawn_teammate'))
check('四种来源都带四段格式', HARNESS_MODES.every(mode =>
  dispatchInstruction(mode.id).includes('【需求】') && dispatchInstruction(mode.id).includes('【预计时间】')), true)

const harnessEvents = [
  { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'subagent_codex', arguments: JSON.stringify({ description: '改 README', prompt: '把安装节改成三步' }) } },
  { type: 'tool/call', seq: 2, data: { callId: 'c2', name: 'subagent_claude_code', arguments: '{"description":"审阅","prompt":"帮我审阅 README 的语气"}' } },
  { type: 'tool/result', seq: 3, data: { message: { source: { callId: 'c2' }, content: [{ type: 'text', text: '语气已更口语化' }] } } },
  { type: 'tool/call', seq: 4, data: { callId: 'c3', name: 'read', arguments: '{}' } },
]
const externalWorkers = externalWorkersFromEvents(harnessEvents)
check('外部 harness 只认官方两种工具', externalWorkers.map(item => item.harness), ['codex', 'claude-code'])
check('未返回 = 运行中', externalWorkers[0].status, 'running')
check('已返回 = 完成', externalWorkers[1].status, 'done')
checkTrue('运行中显示这一步做什么', externalWorkers[0].lastText.includes('改 README'))
checkTrue('完成后显示最终答案', externalWorkers[1].lastText.startsWith('语气已更口语化'))
check('外部 harness 不占 token', externalWorkers.map(item => item.usage), [null, null])
check('坏 arguments 当空对象', parseToolArguments('{oops'), {})

// ── 7) 领导平台：DSH 官方 或 外部 harness ──────────────────────────────────
const fakeServices = {
  controller: {},
  subagents: { list: () => ['spawn', 'fork', 'acp', 'codex', 'claude-code', 'codex-gpt'] },
}
const leaderOpts = normalizeConfig({ leaders: { codex: 'Codex · GPT', 'codex-gpt': 'Codex · GPT-5' } })
const leaders = leaderOptions(fakeServices, leaderOpts)
check('领导平台列表', leaders.map(item => item.id), [LEADER_DSH, 'harness:codex', 'harness:claude-code', 'harness:codex-gpt'])
check('进程内提供方不算领导平台', leaders.some(item => item.id.includes('spawn') || item.id.includes('fork') || item.id.includes('acp')), false)
check('DSH 是默认领导', leaders[0].kind, 'dsh')
check('Codex 领导是可用的外部 harness', [leaders[1].kind, leaders[1].provider, leaders[1].available], ['harness', 'codex', true])
check('领导展示名可配置', leaders[1].label, 'Codex · GPT')
checkTrue('内置展示名', DEFAULT_LEADER_LABELS.codex.includes('Codex'))

const leaderPrompt = buildLeaderPrompt('Codex · GPT', [
  { role: 'user', text: '先聊聊需求' },
  { role: 'lead', text: '好，说说看' },
], '把 README 改一下', true)
checkTrue('领导 prompt 带角色说明', leaderPrompt.includes('「领导」'))
checkTrue('领导 prompt 带对话历史', leaderPrompt.includes('用户：先聊聊需求') && leaderPrompt.includes('领导：好，说说看'))
checkTrue('派活 prompt 要求四段格式', leaderPrompt.includes('【需求】') && leaderPrompt.includes('【预计时间】'))
checkTrue('派活 prompt 要求直接动手', leaderPrompt.includes('直接动手'))
check('闲聊 prompt 不带派活要求', buildLeaderPrompt('Codex', [], '你好', false).includes('【需求】'), false)

// ── 8) 跨平台协作：分工 / 会诊 / 流水线 ────────────────────────────────────
check('勾选去重/过滤', normalizePicks(['codex', 'nope', 'codex', 'dsh', 1]), ['codex', 'dsh'])
check('默认勾选 DSH', picksOf({}), ['dsh'])
const splitInstruction = dispatchInstructionFor(['dsh', 'codex', 'claude-code'])
checkTrue('分工指令点名三个平台', splitInstruction.includes('spawn_teammate') && splitInstruction.includes('subagent_codex') && splitInstruction.includes('subagent_claude_code'))
checkTrue('分工指令带四段格式', splitInstruction.includes('【需求】'))
checkTrue('会诊 prompt 带任务', buildConsultPrompt('Codex', '写个 README').includes('写个 README'))
checkTrue('流水线第一步要交接', buildPipelinePrompt('Codex', 1, 2, '任务', '').includes('交接'))
checkTrue('流水线后续步带上一步输出', buildPipelinePrompt('Claude Code', 2, 2, '任务', '上一步做了 X').includes('上一步做了 X'))
check('协作模式四种', COLLAB_MODES.map(mode => mode.id), ['single', 'split', 'consult', 'pipeline'])

// ── 9) 浏览器半边：假 loader + 假 react 下能否注册槽位 ─────────────────────
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
let registration = null
const fakeWindow = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useCallback: fn => fn,
  useEffect: () => {},
  useMemo: fn => fn(),
  useRef: value => ({ current: value }),
  useState: value => [value, () => {}],
}
const requireShim = specifier => {
  if (specifier === 'react') return fakeReact
  throw new Error(`client bundle 请求了未知模块: ${specifier}`)
}
// 在假 window 里求值：等价于浏览器里的 classic script。
new Function('window', 'document', 'fetch', clientSource)(fakeWindow, { getElementById: () => null, head: { appendChild: () => {} }, createElement: () => ({}) }, () => {})
checkTrue('client 注册了模块', registration !== null && registration.id === 'dsh-lead-panel')
const plugin = registration.factory(requireShim)
check('client 插件名', plugin.name, 'dsh-lead-panel')
check('client inject 覆盖 slots', plugin.inject.includes('slots'), true)
let slotName = null
let slotOptions = null
let component = null
plugin.apply({
  locale: { getSnapshot: () => ({ active: 'zh-CN' }) },
  slots: {
    inject: (name, register) => { slotName = name; register() },
    register: (opts, Comp) => { slotOptions = opts; component = Comp },
  },
})
check('注册到「完全权限」右边的槽位', slotName, 'conversation.input.left')
check('槽位 id', slotOptions.id, 'dsh-lead-panel')
checkTrue('槽位 order 是数字', typeof slotOptions.order === 'number')
checkTrue('拿到组件', typeof component === 'function')
checkTrue('组件带 notranslate（防 Chrome 翻译）', clientSource.includes('notranslate'))

// ── 8) 模型下拉：不再用原生 select，且能区分同名模型 ───────────────────────
checkTrue('模型选择器是自定义下拉', clientSource.includes('lp-model') && clientSource.includes('lp-menu-item'))
checkTrue('下拉里有分组标题与当前项打勾', clientSource.includes('lp-menu-group') && clientSource.includes('lp-menu-check'))
checkTrue('不再使用原生 select（深色主题下看不清）', !/<select/.test(clientSource))
checkTrue('provider 展示名与模型名分开渲染', clientSource.includes('lp-model-provider') && clientSource.includes('lp-model-value'))
checkTrue('显示推理强度（reasoningEffort）', clientSource.includes('lp-model-effort') && clientSource.includes('reasoningEffort'))

// ── 10) 领导平台选择器 ─────────────────────────────────────────────────────
checkTrue('领导平台选择器', clientSource.includes("post('/leader'") && clientSource.includes("'leader'"))
checkTrue('外部 harness 的派活按钮文案', clientSource.includes('letItWork'))
checkTrue('外部 harness 领导不显示工人来源', clientSource.includes('!harnessLeader'))
checkTrue('外部 harness 领导隐藏模型下拉', clientSource.includes('leaderModelNative'))
// ── 9) 工人来源选择器与外部工人样式 ────────────────────────────────────────
checkTrue('工人来源选择器', clientSource.includes('lp-harness') && clientSource.includes('lp-seg'))
checkTrue('派活时把来源发给 Host', clientSource.includes('harness: selectedHarness'))
checkTrue('外部工人带「外部」标记', clientSource.includes('externalTag') && clientSource.includes('lp-tag'))
checkTrue('来源不可用时给提示', clientSource.includes('harnessNoProvider'))

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
