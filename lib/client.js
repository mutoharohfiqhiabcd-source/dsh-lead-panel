// ============================================================================
// dsh-lead-panel —— DSH「领导面板」插件（浏览器半边）
// ----------------------------------------------------------------------------
// 在「完全权限」右边（conversation.input.left 槽）加一个「领导」按钮：
//   按下 → 弹出面板：
//     · 顶部：状态 + 模型下拉（本机全部 provider/模型，选一下即切）
//     · 计划卡：领导总结的【需求】【效果】【分工】【预计时间】
//     · 对话：你和领导的来回（运行时上下文那种注入已在 Host 侧过滤）
//     · 工人：领导派出去的每个 AI —— 干什么、状态、自己的 token/金额、最后结论
//     · 指标条：token / 估算金额 / 用时 / 预计剩余 / 速度
//     · 输入框 +「总结并派活」「发送」
//
// 数据来自 Host 半边的 /lead-panel/api/*（impl.js）。
// 整个面板带 translate="no"：否则 Chrome 会自动把 deepseek-flash 翻成
// 「深度寻道闪避」、把 token 翻成「令牌」，界面没法看。
// ============================================================================

window.__ModuleLoader__.load({
  id: 'dsh-lead-panel',
  factory: function (require) {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    let LOCALE = null
    const API = '/lead-panel/api'
    const STYLE_ID = 'dsh-lead-panel/client.css'
    const POLL_MS = 2500

    function isZh() {
      try {
        const active = LOCALE?.getSnapshot?.()?.active
        if (typeof active === 'string' && active) return active.toLowerCase().startsWith('zh')
      } catch { /* 服务不可用就看 DOM */ }
      return (document.documentElement.lang || '').toLowerCase().startsWith('zh')
    }

    const TEXT = {
      zh: {
        chip: '领导', title: '领导面板', close: '关闭', reset: '重开',
        model: '模型', idle: '空闲', running: '运行中', unloaded: '未加载',
        placeholder: '说说你要什么…（Enter 发送，Shift+Enter 换行）',
        send: '发送', dispatch: '总结并派活', cancel: '打断',
        pickModel: '选择模型', noModels: '没有可用模型',
        plan: '计划', need: '需求', effect: '效果', split: '分工', eta: '预计时间',
        workers: '工人', noWorkers: '还没有工人：先和领导聊清楚，再点「总结并派活」',
        mTokens: 'token', mCost: '估算金额', mElapsed: '用时', mEta: '预计剩余', mSpeed: '速度',
        etaSoon: '估算中', done: '已完成', perWorker: '本工人',
        empty: '还没有对话。直接说需求，或点「总结并派活」。',
        you: '你', lead: '领导', thinking: '思考中…',
        priceNote: '金额按内置牌价估算（元/百万 token），可在 profile 配置里改',
        errNoService: 'Host 半边不可用：确认插件已在 profile 里加载。',
      },
      en: {
        chip: 'Lead', title: 'Lead panel', close: 'Close', reset: 'Restart',
        model: 'Model', idle: 'Idle', running: 'Running', unloaded: 'Not loaded',
        placeholder: 'What do you want? (Enter to send, Shift+Enter for newline)',
        send: 'Send', dispatch: 'Summarize & dispatch', cancel: 'Interrupt',
        pickModel: 'Pick a model', noModels: 'No model available',
        plan: 'Plan', need: 'Need', effect: 'Outcome', split: 'Work split', eta: 'ETA',
        workers: 'Workers', noWorkers: 'No workers yet: talk it through first, then hit “Summarize & dispatch”.',
        mTokens: 'tokens', mCost: 'est. cost', mElapsed: 'elapsed', mEta: 'ETA', mSpeed: 'speed',
        etaSoon: 'estimating', done: 'done', perWorker: 'worker',
        empty: 'No conversation yet. State the need, or hit “Summarize & dispatch”.',
        you: 'You', lead: 'Lead', thinking: 'Thinking…',
        priceNote: 'Cost is estimated from the built-in price table (per 1M tokens); override it in the profile config.',
        errNoService: 'Host half unavailable: check that the plugin is loaded in the profile.',
      },
    }
    const t = key => (isZh() ? TEXT.zh : TEXT.en)[key] ?? key

    const CSS = `
.lp-chip { display:inline-flex; align-items:center; gap:6px; height:26px; padding:0 9px;
  border:0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; cursor:pointer;
  color: var(--dsw-alias-label-secondary, #8b8f98); font: inherit; font-size:12px; white-space:nowrap; }
.lp-chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary, #e6e6e6); }
.lp-chip[data-open="1"] { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.18)); color: var(--dsw-alias-label-primary, #e6e6e6); }
.lp-dot { width:6px; height:6px; border-radius:50%; background: var(--dsw-alias-border-l2, #6b7280); flex:none; }
.lp-chip[data-state="running"] .lp-dot { background: var(--dsw-alias-state-success-primary, #22c55e); }
.lp-chip[data-state="failed"] .lp-dot { background: var(--dsw-alias-state-error-primary, #ef4444); }
.lp-count { font-size:10px; padding:0 5px; border-radius:6px; background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.2)); }

.lp-panel { position: fixed; right: 16px; bottom: 128px; width: 468px; max-width: calc(100vw - 24px);
  height: min(74vh, 700px); display:flex; flex-direction:column; z-index: 60; overflow:hidden;
  background: var(--dsw-alias-bg-base, #17181c); color: var(--dsw-alias-label-primary, #e6e6e6);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  border-radius: 14px; box-shadow: 0 18px 44px rgba(0,0,0,.38); font-size:12px; line-height:18px; }

.lp-head { position:relative; display:flex; flex-direction:column; gap:8px; padding:10px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); }
.lp-headrow { display:flex; align-items:center; gap:8px; min-width:0; }
.lp-title { font-weight:600; font-size:13px; white-space:nowrap; }
.lp-pill { display:inline-flex; align-items:center; gap:5px; padding:1px 7px; border-radius:999px;
  background: var(--dsw-alias-bg-l2, rgba(127,127,127,.14)); color: var(--dsw-alias-label-secondary, #9aa0aa); font-size:11px; }
.lp-pill i { width:6px; height:6px; border-radius:50%; background: currentColor; display:block; }
.lp-pill[data-state="running"] { color: var(--dsw-alias-state-success-primary, #22c55e); }
.lp-pill[data-state="failed"] { color: var(--dsw-alias-state-error-primary, #ef4444); }
.lp-grow { flex:1 1 auto; min-width:0; }
.lp-btn { height:26px; padding:0 10px; font: inherit; font-size:11px; cursor:pointer; white-space:nowrap;
  color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-l2, rgba(127,127,127,.12));
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); border-radius: var(--dsw-radius-xs, 6px); }
.lp-btn:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.2)); }
.lp-btn[disabled] { opacity:.45; cursor:default; }
.lp-btn-primary { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.22)); font-weight:600; }

/* 模型选择：不用原生 select —— 深色主题下选项看不清，而且两个 provider 有同名模型 */
.lp-model { flex:1 1 auto; min-width:0; display:flex; align-items:center; gap:8px; height:34px; padding:0 10px;
  cursor:pointer; text-align:left; font: inherit; color: var(--dsw-alias-label-primary, #e6e6e6);
  background: var(--dsw-alias-bg-l2, rgba(127,127,127,.12));
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); border-radius:8px; }
.lp-model:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.2)); }
.lp-model[disabled] { opacity:.55; cursor:default; }
.lp-model-main { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:0; }
.lp-model-label { font-size:10px; color: var(--dsw-alias-label-caption, #8b8f98); white-space:nowrap; }
.lp-model-value { font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.lp-model-provider { flex:none; font-size:10px; padding:1px 6px; border-radius:999px; max-width:120px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.2)); color: var(--dsw-alias-label-secondary, #9aa0aa); }
.lp-model-effort { flex:none; font-size:10px; padding:1px 6px; border-radius:999px;
  background: var(--dsw-alias-state-info-tertiary, rgba(96,165,250,.16)); color: var(--dsw-alias-state-info-primary, #60a5fa); }
.lp-caret { flex:none; color: var(--dsw-alias-label-caption, #8b8f98); font-size:10px; }

.lp-menu { position:absolute; left:12px; right:12px; top:calc(100% - 6px); z-index:5; max-height:300px; overflow:auto;
  background: var(--dsw-alias-bg-base, #17181c);
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius:10px;
  box-shadow: 0 14px 32px rgba(0,0,0,.45); padding:6px; }
.lp-menu-group { font-size:10px; color: var(--dsw-alias-label-caption, #8b8f98); padding:6px 8px 3px; }
.lp-menu-item { display:flex; align-items:center; gap:8px; width:100%; padding:7px 8px; cursor:pointer;
  border:0; border-radius:8px; background:transparent; color: var(--dsw-alias-label-primary, #e6e6e6);
  font: inherit; text-align:left; }
.lp-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.2)); }
.lp-menu-item[data-current="1"] { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.24)); font-weight:600; }
.lp-menu-name { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.lp-menu-id { flex:none; font-size:10px; color: var(--dsw-alias-label-caption, #8b8f98); }
.lp-menu-check { flex:none; width:12px; color: var(--dsw-alias-state-success-primary, #22c55e); }

.lp-body { flex:1 1 auto; overflow:auto; padding:12px; display:flex; flex-direction:column; gap:10px; }
.lp-body::-webkit-scrollbar { width:8px; }
.lp-body::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius:4px; }

.lp-card { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); border-radius:10px;
  background: var(--dsw-alias-bg-l2, rgba(127,127,127,.07)); padding:9px 10px; display:flex; flex-direction:column; gap:6px; }
.lp-card-title { font-size:11px; font-weight:600; color: var(--dsw-alias-label-secondary, #9aa0aa); }
.lp-kv { display:grid; grid-template-columns: 62px 1fr; gap:4px 8px; align-items:start; }
.lp-k { color: var(--dsw-alias-label-caption, #8b8f98); font-size:11px; }
.lp-v { white-space:pre-wrap; word-break:break-word; }
.lp-lines { display:flex; flex-direction:column; gap:2px; }

.lp-msg { max-width:88%; padding:7px 10px; border-radius:10px; white-space:pre-wrap; word-break:break-word; }
.lp-msg-user { align-self:flex-end; background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.22)); }
.lp-msg-lead { align-self:flex-start; background: var(--dsw-alias-bg-overlay, rgba(127,127,127,.1));
  border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16)); }
.lp-role { font-size:10px; color: var(--dsw-alias-label-caption, #8b8f98); margin-bottom:3px; }
.lp-calls { display:flex; flex-wrap:wrap; gap:4px; margin-top:5px; }
.lp-call { font-size:10px; padding:1px 6px; border-radius:6px; color: var(--dsw-alias-state-info-primary, #60a5fa);
  background: var(--dsw-alias-state-info-tertiary, rgba(96,165,250,.16)); }

.lp-sec { display:flex; align-items:center; gap:6px; margin-top:2px; font-size:11px;
  color: var(--dsw-alias-label-caption, #8b8f98); }
.lp-sec b { color: var(--dsw-alias-label-secondary, #9aa0aa); font-weight:600; }
.lp-worker { display:flex; gap:8px; padding:8px 10px; border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); background: var(--dsw-alias-bg-l2, rgba(127,127,127,.06)); }
.lp-wdot { width:7px; height:7px; border-radius:50%; margin-top:6px; flex:none; background: var(--dsw-alias-border-l2, #6b7280); }
.lp-wdot[data-s="running"] { background: var(--dsw-alias-state-success-primary, #22c55e); }
.lp-wdot[data-s="provisioning"] { background: var(--dsw-alias-state-warn-label, #f59e0b); }
.lp-wdot[data-s="failed"] { background: var(--dsw-alias-state-error-primary, #ef4444); }
.lp-wname { font-weight:600; }
.lp-wmeta { color: var(--dsw-alias-label-caption, #8b8f98); font-size:11px; }
.lp-wtext { color: var(--dsw-alias-label-secondary, #9aa0aa); font-size:11px; margin-top:3px;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; white-space:pre-wrap; }

.lp-foot { border-top:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); padding:9px 12px 10px;
  display:flex; flex-direction:column; gap:8px; background: var(--dsw-alias-bg-base, #17181c); }
.lp-metrics { display:grid; grid-template-columns: repeat(5, 1fr); gap:6px; }
.lp-metric { display:flex; flex-direction:column; gap:1px; padding:5px 7px; border-radius:8px;
  background: var(--dsw-alias-bg-l2, rgba(127,127,127,.08)); min-width:0; }
.lp-metric span { font-size:10px; color: var(--dsw-alias-label-caption, #8b8f98); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.lp-metric b { font-size:12px; font-variant-numeric: tabular-nums; }
.lp-compose { display:flex; gap:8px; align-items:stretch; }
.lp-input { flex:1 1 auto; min-height:52px; max-height:130px; resize:vertical; padding:7px 9px; font: inherit;
  color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-l2, rgba(127,127,127,.08));
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); border-radius:8px; }
.lp-actions { display:flex; flex-direction:column; gap:6px; justify-content:flex-end; }
.lp-err { color: var(--dsw-alias-state-error-primary, #ef4444); font-size:11px; word-break:break-word;
  background: var(--dsw-alias-state-error-tertiary, rgba(239,68,68,.12)); padding:6px 8px; border-radius:8px; }
.lp-hint { color: var(--dsw-alias-label-caption, #8b8f98); font-size:10px; }
`

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    async function call(path, init) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        ...init,
      })
      let body = null
      try { body = await response.json() } catch { /* 非 JSON 即协议错 */ }
      if (!body) throw new Error(`HTTP ${response.status}`)
      if (!body.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body.data
    }

    const post = (path, payload) => call(path, { method: 'POST', body: JSON.stringify(payload ?? {}) })

    function formatTokens(value) {
      if (!Number.isFinite(value)) return '—'
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
      return String(Math.round(value))
    }

    function formatCost(value, currency) {
      if (!Number.isFinite(value)) return '—'
      if (value >= 1) return `${currency}${value.toFixed(2)}`
      if (value >= 0.01) return `${currency}${value.toFixed(3)}`
      return `${currency}${value.toFixed(4)}`
    }

    function formatDuration(ms) {
      if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
      const total = Math.max(0, Math.round(ms / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`
      return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`
    }

    function workerTokens(usage) {
      if (!usage) return null
      return (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
        + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0)
    }

    function PlanCard({ plan }) {
      if (!plan) return null
      const rows = [
        [t('need'), plan.need],
        [t('effect'), plan.effect],
        [t('split'), plan.split],
        [t('eta'), plan.eta],
      ].filter(([, value]) => typeof value === 'string' && value.trim() !== '')
      if (rows.length === 0) return null
      return h('div', { className: 'lp-card' },
        h('div', { className: 'lp-card-title' }, t('plan')),
        h('div', { className: 'lp-kv' }, rows.flatMap(([label, value], index) => [
          h('div', { key: `k${index}`, className: 'lp-k' }, label),
          value.includes('\n')
            ? h('div', { key: `v${index}`, className: 'lp-v lp-lines' },
              value.split('\n').filter(line => line.trim() !== '')
                .map((line, lineIndex) => h('div', { key: lineIndex }, line)))
            : h('div', { key: `v${index}`, className: 'lp-v' }, value),
        ])),
      )
    }

    function LeadPanel() {
      const [open, setOpen] = useState(false)
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [draft, setDraft] = useState('')
      const [modelOpen, setModelOpen] = useState(false)
      const bodyRef = useRef(null)
      const stickRef = useRef(true)

      const refresh = useCallback(async () => {
        try {
          const next = await call('/state')
          setData(next)
          setError(next.services?.controller === false ? t('errNoService') : null)
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }, [])

      useEffect(() => {
        if (!open) return undefined
        let live = true
        const tick = async () => { if (live) await refresh() }
        void tick()
        const timer = setInterval(tick, POLL_MS)
        return () => { live = false; clearInterval(timer) }
      }, [open, refresh])

      useEffect(() => {
        if (!open) return
        void post('/ensure').then(refresh).catch(caught => {
          setError(caught instanceof Error ? caught.message : String(caught))
        })
      }, [open, refresh])

      const messages = data?.messages ?? []
      const workers = data?.workers ?? []
      useEffect(() => {
        const node = bodyRef.current
        if (!node || !stickRef.current) return
        node.scrollTop = node.scrollHeight
      }, [messages.length, workers.length, data?.plan])

      const onScroll = useCallback(() => {
        const node = bodyRef.current
        if (!node) return
        stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60
      }, [])

      const run = useCallback(async (operation) => {
        setBusy(true)
        setError(null)
        try {
          await operation()
          await refresh()
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
          setBusy(false)
        }
      }, [refresh])

      const send = useCallback(() => {
        const text = draft.trim()
        if (!text) return
        setDraft('')
        void run(() => post('/send', { text }))
      }, [draft, run])

      const dispatch = useCallback(() => {
        const text = draft.trim()
        setDraft('')
        void run(() => post('/dispatch', { text }))
      }, [draft, run])

      const chooseModel = useCallback((value) => {
        const [provider, model] = value.split('::')
        if (!provider || !model) return
        void run(() => post('/model', { provider, model }))
      }, [run])

      const usage = data?.usage
      const running = Boolean(data?.running)
      const state = running ? 'running' : 'idle'
      const currentModel = data?.model?.pending ?? data?.model?.lastUsed ?? null
      const currentValue = currentModel ? `${currentModel.provider}::${currentModel.model}` : ''
      const groups = data?.models?.groups ?? []

      /** provider id → 展示名（下拉里用它区分同名模型）。 */
      const providerName = useCallback(id => groups.find(group => group.id === id)?.name ?? id, [data])
      /** 模型 id → 展示名，取不到就退回 id。 */
      const modelName = useCallback(selection => {
        const group = groups.find(candidate => candidate.id === selection?.provider)
        return group?.models.find(model => model.id === selection?.model)?.name ?? selection?.model ?? ''
      }, [data])

      const options = useMemo(() => {
        const out = []
        for (const group of groups) {
          group.models.forEach((model, index) => {
            out.push({
              value: `${group.id}::${model.id}`,
              modelName: model.name,
              modelId: model.id,
              groupName: group.name,
              groupLabel: group.name,
              firstInGroup: index === 0,
            })
          })
        }
        return out
      }, [data])

      const chip = h('button', {
        type: 'button',
        className: 'lp-chip notranslate',
        translate: 'no',
        'data-open': open ? '1' : '0',
        'data-state': state,
        title: t('title'),
        onClick: () => setOpen(value => { if (value) setModelOpen(false); return !value }),
      },
      h('span', { className: 'lp-dot' }),
      t('chip'),
      workers.length > 0 ? h('span', { className: 'lp-count' }, String(workers.length)) : null)

      if (!open) return chip

      return h(React.Fragment, null, chip, h('div', {
        className: 'lp-panel notranslate',
        translate: 'no',
      },
      h('div', { className: 'lp-head' },
        h('div', { className: 'lp-headrow' },
          h('span', { className: 'lp-title' }, t('title')),
          h('span', { className: 'lp-pill', 'data-state': state },
            h('i', null), running ? t('thinking') : t('idle')),
          data?.progress?.total
            ? h('span', { className: 'lp-pill' }, `${data.progress.done}/${data.progress.total} ${t('done')}`)
            : null,
          h('span', { className: 'lp-grow' }),
          h('button', { className: 'lp-btn', type: 'button', onClick: () => { setModelOpen(false); setOpen(false) } }, t('close')),
        ),
        h('div', { className: 'lp-headrow' },
          // 自定义下拉：原生 select 在深色主题里选项看不清，而且两个 provider 有同名模型，
          // 所以这里把 provider 与模型名分开显示，当前项打勾。
          h('button', {
            className: 'lp-model',
            type: 'button',
            disabled: busy || options.length === 0,
            title: currentModel
              ? `${t('model')}：${providerName(currentModel.provider)} / ${modelName(currentModel)}`
              : t('model'),
            'aria-haspopup': 'listbox',
            'aria-expanded': modelOpen ? 'true' : 'false',
            onClick: () => setModelOpen(value => !value),
          },
          h('span', { className: 'lp-model-main' },
            h('span', { className: 'lp-model-label' }, t('model')),
            h('span', { className: 'lp-model-value' },
              currentModel ? modelName(currentModel) : (options.length === 0 ? t('noModels') : t('pickModel')))),
          currentModel ? h('span', { className: 'lp-model-provider' }, providerName(currentModel.provider)) : null,
          currentModel?.reasoningEffort ? h('span', { className: 'lp-model-effort' }, currentModel.reasoningEffort) : null,
          h('span', { className: 'lp-caret' }, modelOpen ? '▲' : '▼'),
          ),
          running
            ? h('button', { className: 'lp-btn', type: 'button', disabled: busy, onClick: () => void run(() => post('/cancel')) }, t('cancel'))
            : null,
          h('button', {
            className: 'lp-btn', type: 'button', disabled: busy, title: t('reset'),
            onClick: () => void run(() => post('/ensure', { reset: true })),
          }, t('reset')),
        ),
        modelOpen
          ? h('div', { className: 'lp-menu', role: 'listbox' },
            options.map(option => h(React.Fragment, { key: option.value },
              option.firstInGroup
                ? h('div', { className: 'lp-menu-group' }, option.groupLabel)
                : null,
              h('button', {
                className: 'lp-menu-item',
                type: 'button',
                role: 'option',
                'data-current': option.value === currentValue ? '1' : '0',
                'aria-selected': option.value === currentValue ? 'true' : 'false',
                onClick: () => { setModelOpen(false); chooseModel(option.value) },
              },
              h('span', { className: 'lp-menu-check' }, option.value === currentValue ? '✓' : ''),
              h('span', { className: 'lp-menu-name' }, option.modelName),
              h('span', { className: 'lp-menu-id' }, `${option.groupName} · ${option.modelId}`),
              ))))
          : null,
      ),
      h('div', { className: 'lp-body', ref: bodyRef, onScroll },
        error ? h('div', { className: 'lp-err' }, error) : null,
        h(PlanCard, { plan: data?.plan }),
        messages.length === 0
          ? h('div', { className: 'lp-hint' }, t('empty'))
          : messages.map((message, index) => h('div', {
            key: `${message.time ?? index}-${index}`,
            className: `lp-msg lp-msg-${message.role === 'user' ? 'user' : 'lead'}`,
          },
          h('div', { className: 'lp-role' }, message.role === 'user' ? t('you') : t('lead')),
          message.text,
          message.calls?.length
            ? h('div', { className: 'lp-calls' }, message.calls.map((name, callIndex) =>
              h('span', { key: `${name}-${callIndex}`, className: 'lp-call' }, name)))
            : null,
          )),
        h('div', { className: 'lp-sec' },
          h('b', null, t('workers')),
          h('span', null, workers.length > 0 ? `· ${workers.length}` : '')),
        workers.length === 0
          ? h('div', { className: 'lp-hint' }, t('noWorkers'))
          : workers.map(worker => h('div', { key: worker.id ?? worker.name, className: 'lp-worker' },
            h('span', { className: 'lp-wdot', 'data-s': worker.status }),
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
              h('div', null,
                h('span', { className: 'lp-wname' }, worker.name),
                h('span', { className: 'lp-wmeta' }, ` · ${worker.status}`
                  + (worker.model ? ` · ${worker.model}` : '')
                  + (workerTokens(worker.usage) !== null
                    ? ` · ${formatTokens(workerTokens(worker.usage))} ${t('mTokens')} · ${formatCost(worker.cost, usage?.currency ?? '¥')}`
                    : '')),
              ),
              worker.description ? h('div', { className: 'lp-wmeta' }, worker.description) : null,
              worker.lastText ? h('div', { className: 'lp-wtext' }, worker.lastText) : null,
            ),
          )),
      ),
      h('div', { className: 'lp-foot' },
        h('div', { className: 'lp-metrics' },
          h('div', { className: 'lp-metric' },
            h('span', null, t('mTokens')), h('b', null, formatTokens(usage?.tokens ?? 0))),
          h('div', { className: 'lp-metric' },
            h('span', null, t('mCost')), h('b', null, formatCost(usage?.cost ?? 0, usage?.currency ?? '¥'))),
          h('div', { className: 'lp-metric' },
            h('span', null, t('mElapsed')), h('b', null, formatDuration(usage?.elapsedMs))),
          h('div', { className: 'lp-metric' },
            h('span', null, t('mEta')),
            h('b', null, usage?.etaMs === null || usage?.etaMs === undefined
              ? t('etaSoon')
              : formatDuration(usage.etaMs))),
          h('div', { className: 'lp-metric' },
            h('span', null, t('mSpeed')),
            h('b', null, usage?.tokensPerSecond ? `${usage.tokensPerSecond.toFixed(0)} tok/s` : '—')),
        ),
        h('div', { className: 'lp-compose' },
          h('textarea', {
            className: 'lp-input',
            value: draft,
            placeholder: t('placeholder'),
            onChange: event => setDraft(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            },
          }),
          h('div', { className: 'lp-actions' },
            h('button', {
              className: 'lp-btn lp-btn-primary', type: 'button',
              disabled: busy, onClick: dispatch,
            }, t('dispatch')),
            h('button', {
              className: 'lp-btn', type: 'button',
              disabled: busy || draft.trim() === '', onClick: send,
            }, t('send')),
          ),
        ),
        h('div', { className: 'lp-hint' }, t('priceNote')),
      )))
    }

    module.exports = {
      name: 'dsh-lead-panel',
      inject: ['slots', 'locale'],
      apply(ctx) {
        LOCALE = ctx.locale ?? null
        injectStyle()
        // 排在「完全权限」后面：同一个左侧控件区（conversation.input.left）。
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-lead-panel',
          order: 40,
        }, LeadPanel))
      },
    }

    return module.exports
  },
})
