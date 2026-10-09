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
  normalizeConfig, priceOf,
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

// ── 6) 浏览器半边：假 loader + 假 react 下能否注册槽位 ─────────────────────
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

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
