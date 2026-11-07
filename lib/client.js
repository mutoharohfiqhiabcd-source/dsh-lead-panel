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
    /** 客户端会话服务：拿「当前页面所处会话」，团队浮窗据此判断看哪个会话。 */
    let UI_SESSION = null
    const API = '/lead-panel/api'
    const STYLE_ID = 'dsh-lead-panel/client.css'
    /** 轮询节奏：有人正在跑就快一点，闲着就慢一点（省 CPU / 请求）。 */
    const POLL_ACTIVE_MS = 2500
    const POLL_IDLE_MS = 6000

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
        team: '团队', task: '当前任务', stage: '阶段', members: '创造的成员',
        noMembers: '还没有成员：先和领导聊清楚，再点「总结并派活」',
        externalNoMembers: '外部 harness 自己就是执行者，不产生成员',
        memberIdle: '未运行 / 已结束', memberRunning: '运行中 / 等领导回应', memberDone: '已完成该任务',
        showMembers: '展开成员名字', hideMembers: '收起成员名字',
        stageStart: '待开始', stageIdle: '空闲', stageRunning: '运行中', stageWaiting: '等待成员', stageDone: '已完成', stageLeader: '领导运行中',
        hudTitle: '团队任务', hudMembers: '名成员', hudClose: '收起浮窗（下次有新动静再出现）',
        hudFrom: '任何会话触发都会显示',
        placeholder: '说说你要什么…（Enter 发送，Shift+Enter 换行）',
        send: '发送', dispatch: '总结并派活', cancel: '打断',
        dispatchCodex: '总结并派给 Codex', dispatchClaude: '总结并派给 Claude Code',
        dispatchAuto: '总结并自动派活',
        harness: '工人来源', harnessNoProvider: '未安装官方提供方',
        leader: '领导平台', leaderNote: '外部 harness 当领导：每轮它会带着对话历史跑一次；「派活」= 直接让它把活干完。它的模型在下面「领导模型」里换，或点「打开」直接进它自己的界面。',
        harnessModel: '领导模型', workerModel: '工人模型',
        switchModel: '换模型', openApp: '打开', openConfig: '打开配置',
        openAppMissing: '没找到它的命令行；先在终端里手动运行一次',
        splitLeaderLocked: '分工模式需要 DSH 官方当领导',
        noModelSet: '未设置（用它自己的默认）', saveModel: '保存', cancelEdit: '取消',
        modelInput: '模型 id，例如 deepseek-v4-pro',
        leaderRunning: '领导正在跑', letItWork: '让它直接干活', leaderModelNative: '模型由它自己定',
        mode: '协作模式', picksPlatforms: '参与平台', resultTitle: '跨平台结果',
        runSplit: '跨平台分工派活', runConsult: '开始会诊', runPipeline: '开始流水线',
        placeholderTask: '写下这次要跨平台处理的任务…',
        resultRunning: '运行中…', platformUnavailable: '不可用',
        externalTag: '外部',
        externalNote: '外部 harness（Codex / Claude Code）由官方 subagent 提供方执行，不回传 token，所以上面的金额/速度只算领导自己。',
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
        team: 'Team', task: 'Current task', stage: 'Stage', members: 'Members created',
        noMembers: 'No members yet: talk it through first, then hit “Summarize & dispatch”.',
        externalNoMembers: 'The external harness is the executor itself, so it creates no members.',
        memberIdle: 'created, not running / ended', memberRunning: 'running / waiting for lead', memberDone: 'task completed',
        showMembers: 'Show member names', hideMembers: 'Hide member names',
        stageStart: 'not started', stageIdle: 'idle', stageRunning: 'running', stageWaiting: 'waiting for members', stageDone: 'done', stageLeader: 'lead running',
        hudTitle: 'Team task', hudMembers: 'members', hudClose: 'Hide the floating card (comes back on new activity)',
        hudFrom: 'shown for any Session',
        placeholder: 'What do you want? (Enter to send, Shift+Enter for newline)',
        send: 'Send', dispatch: 'Summarize & dispatch', cancel: 'Interrupt',
        dispatchCodex: 'Summarize & hand to Codex', dispatchClaude: 'Summarize & hand to Claude Code',
        dispatchAuto: 'Summarize & auto-dispatch',
        harness: 'Workers from', harnessNoProvider: 'provider not installed',
        leader: 'Lead from', leaderNote: 'External harness as lead: each turn replays the conversation history; “dispatch” means just do the work. Switch its model in “Lead model”, or hit “Open” to enter its own UI.',
        harnessModel: 'Lead model', workerModel: 'Worker model',
        switchModel: 'Switch', openApp: 'Open', openConfig: 'Open config',
        openAppMissing: 'CLI not found; run it once in a terminal first',
        splitLeaderLocked: 'Split mode requires DSH official as lead',
        noModelSet: 'not set (its own default)', saveModel: 'Save', cancelEdit: 'Cancel',
        modelInput: 'model id, e.g. deepseek-v4-pro',
        leaderRunning: 'Lead running', letItWork: 'Let it do the work', leaderModelNative: 'native model',
        mode: 'Mode', picksPlatforms: 'Platforms', resultTitle: 'Cross-platform results',
        runSplit: 'Cross-platform split', runConsult: 'Start consult', runPipeline: 'Start pipeline',
        placeholderTask: 'Describe the task to process across platforms…',
        resultRunning: 'running…', platformUnavailable: 'unavailable',
        externalTag: 'external',
        externalNote: 'External harnesses (Codex / Claude Code) run through the official subagent providers and do not report tokens, so cost/speed above cover the lead only.',
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
.lp-wdot { width:11px; height:11px; border-radius:50%; margin-top:3px; flex:none; box-sizing:border-box;
  border:1.5px solid var(--hc, var(--dsw-alias-border-l2, #6b7280)); background:transparent; }
.lp-wdot[data-s="running"] { border-width:3px; }
.lp-wdot[data-s="done"] { background: var(--hc, var(--dsw-alias-state-success-primary, #22c55e)); border-color: var(--hc, var(--dsw-alias-state-success-primary, #22c55e)); opacity:.78; }
.lp-wdot[data-s="provisioning"] { border-color: var(--dsw-alias-state-warn-label, #f59e0b); border-width:3px; }
.lp-wdot[data-s="failed"] { background: var(--dsw-alias-state-error-primary, #ef4444); border-color: var(--dsw-alias-state-error-primary, #ef4444); border-width:1px; }
.lp-wname { font-weight:600; }
.lp-wharness { display:inline-block; margin-left:6px; padding:0 6px; border-radius:999px; border:1px solid;
  font-size:9px; line-height:14px; vertical-align:1px; white-space:nowrap; }
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

/* 工人来源：官方团队 / Codex / Claude Code / 自动选 */
.lp-harness { gap:6px; }
.lp-harness-label { font-size:10px; color: var(--dsw-alias-label-caption, #8b8f98); white-space:nowrap; }
.lp-seg { display:inline-flex; gap:2px; padding:2px; min-width:0; overflow:auto;
  border-radius:8px; background: var(--dsw-alias-bg-l2, rgba(127,127,127,.1));
  border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); }
.lp-seg-btn { height:22px; padding:0 8px; border:0; border-radius:6px; background:transparent;
  cursor:pointer; font:inherit; font-size:11px; white-space:nowrap;
  color: var(--dsw-alias-label-secondary, #9aa0aa); }
.lp-seg-btn:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.2)); }
.lp-seg-btn[data-active="1"] { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.24));
  color: var(--dsw-alias-label-primary, #e6e6e6); font-weight:600; }
.lp-seg-btn[disabled] { opacity:.4; cursor:default; }
.lp-tag { margin-left:6px; font-size:9px; padding:0 5px; border-radius:5px; font-weight:400;
  background: var(--dsw-alias-state-info-tertiary, rgba(96,165,250,.16));
  color: var(--dsw-alias-state-info-primary, #60a5fa); }

/* 外部 harness 的原生模型 + 打开平台 */
.lp-hmodel { flex:1 1 auto; min-width:0; display:inline-flex; align-items:center; gap:6px; height:26px; padding:0 8px;
  cursor:pointer; font: inherit; font-size:11px; color: var(--dsw-alias-label-primary, #e6e6e6);
  background: var(--dsw-alias-bg-l2, rgba(127,127,127,.12));
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  border-radius: var(--dsw-radius-xs, 6px); }
.lp-hmodel:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.2)); }
.lp-hmodel[disabled] { opacity:.55; cursor:default; }
.lp-hmodel[data-active="1"] { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.24)); }
.lp-hmodel-value { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
.lp-hmodel-tag { flex:none; font-size:9px; padding:0 5px; border-radius:999px; max-width:110px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.2)); color: var(--dsw-alias-label-secondary, #9aa0aa); }
.lp-editrow { display:flex; gap:6px; align-items:center; width:100%; }
.lp-app-actions { gap:6px; }
.lp-editinput { flex:1 1 auto; min-width:0; height:26px; padding:0 8px; font: inherit; font-size:11px;
  color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-l2, rgba(127,127,127,.08));
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); border-radius:6px; }
.lp-menu-note { font-size:10px; color: var(--dsw-alias-label-caption, #8b8f98); padding:5px 8px 2px;
  word-break:break-all; }

/* 团队总览卡（0.9.3）：每个 harness 一个底色，成员用圆点表示状态 */
.lp-team { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); border-left-width:3px;
  border-radius:10px; padding:9px 10px; display:flex; flex-direction:column; gap:5px; min-width:0; }
.lp-team-head { display:flex; align-items:center; gap:8px; min-width:0; }
.lp-team-name { flex:1 1 auto; min-width:0; font-weight:600; font-size:12px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.lp-team-harness { flex:none; font-size:9px; padding:1px 7px; border-radius:999px; border:1px solid; white-space:nowrap; }
.lp-team-line { display:flex; align-items:baseline; gap:6px; min-width:0; font-size:11px; }
.lp-team-k { flex:none; color: var(--dsw-alias-label-caption, #8b8f98); font-size:10px; }
.lp-team-v { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color: var(--dsw-alias-label-secondary, #9aa0aa); }
.lp-members { display:flex; align-items:center; gap:6px; flex-wrap:wrap; min-width:0; }
.lp-mdot { flex:none; width:11px; height:11px; border-radius:50%; box-sizing:border-box;
  border:1.5px solid var(--hc, #8b8f98); background:transparent; }
.lp-mdot[data-status="running"] { border-width:3px; }
.lp-mdot[data-status="done"] { background: var(--hc, #8b8f98); border-color: var(--hc, #8b8f98); opacity:.78; }
.lp-mdot[data-status="failed"] { background: var(--dsw-alias-state-error-primary, #ef4444);
  border-color: var(--dsw-alias-state-error-primary, #ef4444); border-width:1px; }
.lp-mcount { font-size:10px; color: var(--dsw-alias-label-caption, #8b8f98); }
.lp-mexpand { flex:none; height:20px; min-width:22px; padding:0 6px; cursor:pointer; font:inherit; font-size:11px; line-height:1;
  color: var(--dsw-alias-label-secondary, #9aa0aa); background: var(--dsw-alias-bg-l2, rgba(127,127,127,.14));
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius:6px; }
.lp-mexpand:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.22)); }
.lp-mnames { display:flex; flex-wrap:wrap; gap:4px 10px; align-items:center; }
.lp-mname { display:inline-flex; align-items:center; gap:5px; font-size:11px; color: var(--dsw-alias-label-secondary, #9aa0aa); }
.lp-mlegend { display:flex; flex-wrap:wrap; gap:4px 10px; align-items:center; font-size:9px;
  color: var(--dsw-alias-label-caption, #8b8f98); }
.lp-mlegend-item { display:inline-flex; align-items:center; gap:4px; }
.lp-mlegend .lp-mdot { width:9px; height:9px; }

/* 团队任务浮窗（0.9.4）：右上角 fixed 卡片，任意会话触发团队任务时出现 */
.lp-hud { position: fixed; top: 60px; right: 16px; width: 320px; max-width: calc(100vw - 32px);
  z-index: 45; display:flex; flex-direction:column; gap:7px; padding:8px 8px 9px;
  border-radius:12px; background: var(--dsw-alias-bg-base, #17181c);
  border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
  box-shadow: 0 14px 36px rgba(0,0,0,.42); font-size:12px; line-height:18px;
  color: var(--dsw-alias-label-primary, #e6e6e6); }
.lp-hud-head { display:flex; align-items:center; gap:7px; padding:0 2px; }
.lp-hud-dot { width:8px; height:8px; border-radius:50%; flex:none;
  background: var(--dsw-alias-label-caption, #8b8f98); }
.lp-hud-dot[data-active="1"] { background: var(--dsw-alias-state-success-primary, #22c55e);
  box-shadow: 0 0 0 3px rgba(34,197,94,.18); }
.lp-hud-title { font-weight:600; font-size:12px; }
.lp-hud-sub { color: var(--dsw-alias-label-caption, #8b8f98); font-size:10px; }
.lp-hud-btn { margin-left:auto; width:20px; height:20px; padding:0; border:0; border-radius:6px;
  cursor:pointer; background:transparent; color: var(--dsw-alias-label-secondary, #9aa0aa);
  font: inherit; font-size:13px; line-height:1; }
.lp-hud-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.2)); }
.lp-hud .lp-team { border-width:0; padding:2px 0 0; }
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

    /**
     * 每个 harness 一套配色（0.9.3，按需求图）：AI 卡片 / 成员圆点都用它。
     * DSH 官方（DeepSeek）→ 深蓝；Codex（GPT）→ 象牙白；Claude Code → 深橙。
     */
    const HARNESS_STYLE = {
      dsh: { label: 'DSH 官方', accent: '#60a5fa', bg: 'rgba(96, 165, 250, 0.10)' },
      codex: { label: 'Codex', accent: '#e8dcc0', bg: 'rgba(232, 220, 192, 0.10)' },
      'claude-code': { label: 'Claude Code', accent: '#fb923c', bg: 'rgba(251, 146, 60, 0.11)' },
    }
    const harnessStyle = id => HARNESS_STYLE[id] ?? HARNESS_STYLE.dsh
    const dotStyle = harness => ({ '--hc': harnessStyle(harness).accent })
    const memberHarnessOf = worker => (worker.external ? (worker.harness || 'dsh') : 'dsh')

    /** 成员状态 → 圆点样式：空心 = 未运行/已结束，粗圈 = 运行中/等领导，实心偏暗 = 已完成。 */
    function memberStatusOf(worker) {
      if (worker.done) return 'done'
      if (worker.status === 'running') return 'running'
      if (worker.status === 'failed') return 'failed'
      return 'idle'
    }

    function MemberDot({ harness, status, title }) {
      return h('span', { className: 'lp-mdot', 'data-status': status, title, style: dotStyle(harness) })
    }

    /**
     * 团队总览卡（0.9.3）：AI 名字 + 对应 harness（按 harness 上色），当前任务 / 阶段，
     * 以及它创造的成员。成员 ≥4 个先显示 4 个圆点 + 展开按钮；<4 个直接显示名字。
     */
    function TeamCard({ data, leaderName, leaderHarness, leaderLabel, isHarnessLeader, stageText }) {
      const [namesOpen, setNamesOpen] = useState(false)
      useEffect(() => { setNamesOpen(false) }, [data?.leader, data?.mode])
      if (!data) return null
      const style = harnessStyle(leaderHarness)
      const workers = data.workers ?? []
      const messages = data.messages ?? []
      const running = Boolean(data.running)
      const members = workers.map(worker => ({
        key: worker.id ?? worker.name,
        name: worker.name,
        harness: memberHarnessOf(worker),
        status: memberStatusOf(worker),
      }))
      let task = data.plan?.need ?? ''
      if (!task) {
        const lastUser = [...messages].reverse().find(message => message.role === 'user')
        if (lastUser) task = String(lastUser.text).replace(/\s+/gu, ' ').slice(0, 80)
      }
      if (!task && data.lastRun?.task) task = String(data.lastRun.task).slice(0, 80)
      let stage = typeof stageText === 'string' && stageText ? stageText : t('stageStart')
      if (!(typeof stageText === 'string' && stageText)) {
        if (isHarnessLeader) {
          stage = running ? t('stageLeader') : (messages.length > 0 ? t('stageIdle') : t('stageStart'))
        } else if (running) {
          stage = t('stageRunning')
        } else if (workers.some(worker => worker.status === 'running')) {
          stage = t('stageWaiting')
        } else if (workers.length > 0 && workers.every(worker => worker.done)) {
          stage = t('stageDone')
        } else if (messages.length > 0) {
          stage = t('stageIdle')
        }
      }
      const many = members.length >= 4
      const dots = many ? members.slice(0, 4) : members
      const namesRow = h('div', { className: 'lp-mnames' }, members.map(member => h('span', { key: member.key, className: 'lp-mname' },
        h(MemberDot, { harness: member.harness, status: member.status, title: harnessStyle(member.harness).label }),
        member.name)))
      const legend = ['idle', 'running', 'done'].map(status => h('span', { key: status, className: 'lp-mlegend-item' },
        h('span', { className: 'lp-mdot', 'data-status': status, style: dotStyle(leaderHarness) }),
        status === 'idle' ? t('memberIdle') : status === 'running' ? t('memberRunning') : t('memberDone')))
      return h('div', {
        className: 'lp-team',
        style: { '--hc': style.accent, borderLeft: `3px solid ${style.accent}`, background: style.bg },
      },
      h('div', { className: 'lp-team-head' },
        h('span', { className: 'lp-team-name', title: leaderName }, leaderName),
        h('span', { className: 'lp-team-harness', style: { color: style.accent, borderColor: style.accent } }, leaderLabel || style.label)),
      h('div', { className: 'lp-team-line' },
        h('span', { className: 'lp-team-k' }, t('task')),
        h('span', { className: 'lp-team-v' }, task || '—')),
      h('div', { className: 'lp-team-line' },
        h('span', { className: 'lp-team-k' }, t('stage')),
        h('span', { className: 'lp-team-v' }, stage)),
      h('div', { className: 'lp-team-line' },
        h('span', { className: 'lp-team-k' }, t('members')),
        isHarnessLeader
          ? h('span', { className: 'lp-team-v' }, t('externalNoMembers'))
          : members.length === 0
            ? h('span', { className: 'lp-team-v' }, t('noMembers'))
            : h('div', { className: 'lp-members' },
              dots.map(member => h(MemberDot, { key: `${member.key}-dot`, harness: member.harness, status: member.status, title: member.name })),
              many ? h('span', { className: 'lp-mcount' }, String(members.length)) : null,
              many
                ? h('button', {
                  className: 'lp-mexpand', type: 'button',
                  title: namesOpen ? t('hideMembers') : t('showMembers'),
                  onClick: () => setNamesOpen(value => !value),
                }, namesOpen ? '−' : '+')
                : namesRow)),
      many && namesOpen ? namesRow : null,
      members.length > 0 ? h('div', { className: 'lp-mlegend' }, legend) : null,
      )
    }

    /**
     * 外部 harness 的一行：当前原生模型 + 换模型 + 打开平台 + 打开配置。
     * 模型不是 DSH 的模型列表，而是它自己配置文件里的那一个字段（Host 侧读写）。
     */
    function HarnessAppRow({ app, label, busy, collapsed, onModel, onOpen, onMenuOpened }) {
      const [menuOpen, setMenuOpen] = useState(false)
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      useEffect(() => { if (collapsed) setMenuOpen(false) }, [collapsed])
      useEffect(() => { setMenuOpen(false); setEditing(false) }, [app?.id])
      if (!app) return null
      const models = app.models ?? []
      const current = app.model ?? ''
      const openMenu = () => {
        if (typeof onMenuOpened === 'function') onMenuOpened()
        if (models.length > 0) setMenuOpen(value => !value)
        else startEdit()
      }
      const startEdit = () => {
        setMenuOpen(false)
        setDraft(current)
        setEditing(true)
      }
      const save = () => {
        setEditing(false)
        onModel(app.id, draft)
      }
      return h(React.Fragment, null,
        h('div', { className: 'lp-headrow lp-harness' },
          h('span', { className: 'lp-harness-label' }, label),
          h('button', {
            type: 'button',
            className: 'lp-hmodel',
            disabled: busy || Boolean(app.configError),
            'data-active': menuOpen || editing ? '1' : '0',
            title: `${app.configPath}${app.note ? `\n${app.note}` : ''}`,
            'aria-haspopup': 'listbox',
            onClick: openMenu,
          },
          h('span', { className: 'lp-hmodel-value' }, current || t('noModelSet')),
          app.providerLabel ? h('span', { className: 'lp-hmodel-tag' }, app.providerLabel) : null,
          h('span', { className: 'lp-caret' }, models.length > 0 ? (menuOpen ? '▲' : '▼') : '✎')),
        ),
        h('div', { className: 'lp-headrow lp-harness lp-app-actions' },
          h('button', {
            className: 'lp-btn', type: 'button', disabled: busy || Boolean(app.configError),
            title: t('switchModel'), onClick: startEdit,
          }, t('switchModel')),
          h('button', {
            className: 'lp-btn', type: 'button', disabled: busy || !app.canOpen,
            title: app.canOpen
              ? `新开一个终端窗口运行 ${app.label}（${app.bin}）`
              : t('openAppMissing'),
            onClick: () => onOpen(app.id, 'app'),
          }, `${t('openApp')} ${app.label}`),
          h('button', {
            className: 'lp-btn', type: 'button', disabled: busy || !app.configExists,
            title: app.configPath, onClick: () => onOpen(app.id, 'config'),
          }, t('openConfig')),
        ),
        editing
          ? h('div', { className: 'lp-headrow lp-harness' },
            h('input', {
              className: 'lp-editinput',
              value: draft,
              placeholder: t('modelInput'),
              onChange: event => setDraft(event.target.value),
              onKeyDown: event => {
                if (event.key === 'Enter') { event.preventDefault(); save() }
                if (event.key === 'Escape') setEditing(false)
              },
            }),
            h('button', { className: 'lp-btn lp-btn-primary', type: 'button', disabled: busy, onClick: save }, t('saveModel')),
            h('button', { className: 'lp-btn', type: 'button', disabled: busy, onClick: () => setEditing(false) }, t('cancelEdit')),
          )
          : null,
        menuOpen
          ? h('div', { className: 'lp-menu', role: 'listbox' },
            models.map(model => h('button', {
              key: model.id,
              className: 'lp-menu-item',
              type: 'button',
              role: 'option',
              'data-current': model.id === current ? '1' : '0',
              onClick: () => { setMenuOpen(false); onModel(app.id, model.id) },
            },
            h('span', { className: 'lp-menu-check' }, model.id === current ? '✓' : ''),
            h('span', { className: 'lp-menu-name' }, model.name && model.name !== model.id ? model.name : model.id),
            model.name && model.name !== model.id ? h('span', { className: 'lp-menu-id' }, model.id) : null,
            )),
            h('div', { className: 'lp-menu-note' }, app.note || ''),
            h('div', { className: 'lp-menu-note' }, app.configPath),
          )
          : null,
        app.configError ? h('div', { className: 'lp-hint' }, app.configError) : null,
      )
    }

    /** 当前页面所处会话 id（uiSession 的 session 绑定；拿不到就返回 null）。 */
    function readCurrentSessionId() {
      try {
        const source = UI_SESSION?.adapter?.current
        if (!source) return null
        const snapshot = typeof source.getSnapshot === 'function' ? source.getSnapshot() : null
        const id = snapshot?.props?.sessionId ?? snapshot?.sessionId
        return typeof id === 'string' && id ? id : null
      } catch {
        return null
      }
    }

    function useCurrentSessionId() {
      const [sessionId, setSessionId] = useState(readCurrentSessionId)
      useEffect(() => {
        let source = null
        try { source = UI_SESSION?.adapter?.current ?? null } catch { source = null }
        if (!source || typeof source.subscribe !== 'function') return undefined
        const update = () => setSessionId(readCurrentSessionId())
        update()
        return source.subscribe(update)
      }, [])
      return sessionId
    }

    /**
     * 团队任务浮窗（0.9.4）：不经过「领导面板」——在任意会话里触发 Agent Teams /
     * 外部 harness 任务时，右上角自动出现团队卡；任务结束 20 秒后自动收起。
     * 关闭只收起这一次，有新活动（lastActivityAt 变化）会重新出现。
     */
    function TeamHud() {
      const [data, setData] = useState(null)
      const [hiddenUntil, setHiddenUntil] = useState(0)
      const [, setTick] = useState(0)
      const seenActivity = useRef(0)
      const sessionId = useCurrentSessionId()

      useEffect(() => {
        let live = true
        const poll = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          try {
            const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
            const next = await call(`/team${query}`)
            if (live) setData(next)
          } catch {
            // Host 半边没加载 / 网络抖动：浮窗安静地不显示，不打扰主流程。
          }
        }
        void poll()
        const timer = setInterval(poll, POLL_ACTIVE_MS)
        return () => { live = false; clearInterval(timer) }
      }, [sessionId])

      // 「最近 20 秒」是时间条件，需要定期重渲染才能让它失效。
      useEffect(() => {
        const timer = setInterval(() => setTick(value => value + 1), 5000)
        return () => clearInterval(timer)
      }, [])

      const lastActivity = data?.lastActivityAt ?? 0
      useEffect(() => {
        if (!lastActivity || lastActivity === seenActivity.current) return
        seenActivity.current = lastActivity
        setHiddenUntil(0)
      }, [lastActivity])

      if (!data) return null
      const members = data.members ?? []
      const active = Boolean(data.active)
      const recent = lastActivity > 0 && Date.now() - lastActivity < 20_000
      if (members.length === 0 || !(active || recent)) return null
      if (Date.now() < hiddenUntil) return null
      const stageText = data.stage === 'running' ? t('stageRunning')
        : data.stage === 'waiting' ? t('stageWaiting')
          : data.stage === 'done' ? t('stageDone') : t('stageIdle')
      const teamData = {
        plan: { need: data.task || '' },
        messages: [],
        workers: members.map(member => ({
          name: member.name,
          id: `${data.sessionId ?? 'team'}-${member.name}`,
          status: member.status,
          done: member.status === 'done',
          external: member.harness !== 'dsh',
          harness: member.harness,
        })),
        running: active,
      }
      return h('div', { className: 'lp-hud notranslate', translate: 'no' },
        h('div', { className: 'lp-hud-head' },
          h('span', { className: 'lp-hud-dot', 'data-active': active ? '1' : '0' }),
          h('span', { className: 'lp-hud-title' }, t('hudTitle')),
          h('span', { className: 'lp-hud-sub' }, `${members.length} ${t('hudMembers')}`),
          h('button', {
            className: 'lp-hud-btn', type: 'button', title: t('hudClose'),
            onClick: () => setHiddenUntil(Date.now() + 60_000),
          }, '×')),
        h(TeamCard, {
          data: teamData,
          leaderName: data.leader?.name || data.sessionTitle || t('lead'),
          leaderHarness: data.leader?.harness || 'dsh',
          leaderLabel: data.leader?.label || 'DSH 官方',
          isHarnessLeader: false,
          stageText,
        }),
      )
    }

    function LeadPanel() {
      const [open, setOpen] = useState(false)
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [draft, setDraft] = useState('')
      const [modelOpen, setModelOpen] = useState(false)
      const [harness, setHarness] = useState(null)
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

      /** 0.9.2：运行中 2.5s 一刷，空闲 6s 一刷。 */
      const pollMs = (data?.running || data?.lastRun?.running) ? POLL_ACTIVE_MS : POLL_IDLE_MS

      useEffect(() => {
        if (!open) return undefined
        let live = true
        const tick = async () => { if (live) await refresh() }
        void tick()
        const timer = setInterval(tick, pollMs)
        return () => { live = false; clearInterval(timer) }
      }, [open, refresh, pollMs])

      useEffect(() => {
        if (!open) return
        void post('/ensure').then(refresh).catch(caught => {
          setError(caught instanceof Error ? caught.message : String(caught))
        })
      }, [open, refresh])

      const messages = data?.messages ?? []
      const workers = data?.workers ?? []
      const harnessOptions = data?.harnesses ?? []
      const selectedHarness = harness ?? data?.dispatchHarness ?? 'team'
      const dispatchLabel = selectedHarness === 'codex'
        ? t('dispatchCodex')
        : selectedHarness === 'claude-code'
          ? t('dispatchClaude')
          : selectedHarness === 'auto'
            ? t('dispatchAuto')
            : t('dispatch')
      const leaders = data?.leaders ?? []
      const leaderId = data?.leader ?? 'dsh'
      const leader = leaders.find(item => item.id === leaderId) ?? null
      const harnessLeader = leader?.kind === 'harness'
      /** 外部领导的原生配置快照（当前模型 / 配置路径 / 可执行文件）。 */
      const leaderApp = harnessLeader ? (data?.harnessApps?.[leader?.provider] ?? null) : null
      const modes = data?.modes ?? []
      const collabMode = data?.mode ?? 'single'
      const modeInfo = modes.find(item => item.id === collabMode) ?? null
      const isCollab = collabMode !== 'single'
      const platforms = data?.platforms ?? []
      const picks = data?.picks ?? ['dsh']
      const lastRun = data?.lastRun ?? null
      /** 工人来源选到外部 harness 时，同样显示它的原生模型与「打开」按钮。 */
      const workerApp = !harnessLeader && !isCollab && (selectedHarness === 'codex' || selectedHarness === 'claude-code')
        ? (data?.harnessApps?.[selectedHarness] ?? null)
        : null
      useEffect(() => {
        const node = bodyRef.current
        if (!node || !stickRef.current) return
        node.scrollTop = node.scrollHeight
      }, [messages.length, workers.length, data?.plan, data?.lastRun?.finishedAt])

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
        void run(() => post('/dispatch', { text, harness: selectedHarness }))
      }, [draft, run, selectedHarness])

      const chooseModel = useCallback((value) => {
        const [provider, model] = value.split('::')
        if (!provider || !model) return
        void run(() => post('/model', { provider, model }))
      }, [run])

      const changeHarnessModel = useCallback((platform, model) => {
        void run(() => post('/harness-model', { platform, model }))
      }, [run])

      const openHarness = useCallback((platform, what) => {
        void run(() => post('/open', { platform, what }))
      }, [run])

      const chooseLeader = useCallback((id) => {
        setModelOpen(false)
        void run(() => post('/leader', { leader: id }))
      }, [run])

      const chooseMode = useCallback((mode) => {
        setModelOpen(false)
        void run(() => post('/mode', { mode }))
      }, [run])

      const togglePick = useCallback((id) => {
        const next = picks.includes(id) ? picks.filter(item => item !== id) : [...picks, id]
        if (next.length === 0) return
        void run(() => post('/picks', { picks: next }))
      }, [picks, run])

      const runCollab = useCallback(() => {
        const text = draft.trim()
        if (!text) return
        setDraft('')
        void run(() => post('/run', { mode: collabMode, picks, text }))
      }, [draft, run, collabMode, picks])

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

      /** 团队总览卡：AI 名字（模型名）+ 对应 harness（按 harness 上色）。 */
      const teamHarness = harnessLeader ? (leader?.provider ?? 'dsh') : 'dsh'
      const teamStyle = harnessStyle(teamHarness)
      const teamName = harnessLeader
        ? (leaderApp?.model || leader?.label || teamStyle.label)
        : (currentModel ? modelName(currentModel) : (data?.sessionTitle || t('lead')))
      const teamLabel = harnessLeader ? (leader?.label || teamStyle.label) : teamStyle.label
      const showTeamCard = Boolean(data) && (!isCollab || collabMode === 'split')

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
        modes.length > 0
          ? h('div', { className: 'lp-headrow lp-harness' },
            h('span', { className: 'lp-harness-label' }, t('mode')),
            h('div', { className: 'lp-seg', role: 'group', 'aria-label': t('mode') },
              modes.map(mode => h('button', {
                key: mode.id,
                type: 'button',
                className: 'lp-seg-btn',
                'data-active': mode.id === collabMode ? '1' : '0',
                disabled: busy,
                title: mode.hint,
                onClick: () => chooseMode(mode.id),
              }, mode.label))))
          : null,
        modeInfo ? h('div', { className: 'lp-hint' }, modeInfo.hint) : null,
        isCollab
          ? h('div', { className: 'lp-headrow lp-harness' },
            h('span', { className: 'lp-harness-label' }, collabMode === 'split' ? t('harness') : t('picksPlatforms')),
            h('div', { className: 'lp-seg', role: 'group', 'aria-label': t('picksPlatforms') },
              platforms.map(platform => h('button', {
                key: platform.id,
                type: 'button',
                className: 'lp-seg-btn',
                'data-active': picks.includes(platform.id) ? '1' : '0',
                disabled: busy || platform.available === false,
                title: platform.label + (platform.available === false ? ` · ${t('platformUnavailable')}` : ''),
                onClick: () => togglePick(platform.id),
              }, platform.label))))
          : null,
        leaders.length > 1 && (!isCollab || collabMode === 'split')
          ? h('div', { className: 'lp-headrow lp-harness' },
            h('span', { className: 'lp-harness-label' }, t('leader')),
            h('div', { className: 'lp-seg', role: 'group', 'aria-label': t('leader') },
              leaders.map(option => h('button', {
                key: option.id,
                type: 'button',
                className: 'lp-seg-btn',
                'data-active': option.id === leaderId ? '1' : '0',
                // 分工模式只有 DSH 官方能做：外部 harness 置灰，避免选完发现派不出去。
                disabled: busy || option.available === false || (collabMode === 'split' && option.kind === 'harness'),
                title: collabMode === 'split' && option.kind === 'harness'
                  ? `${option.label} · ${t('splitLeaderLocked')}`
                  : option.kind === 'harness'
                    ? `${option.label} · 外部 harness（每轮带着对话历史跑一次）`
                    : option.label,
                onClick: () => chooseLeader(option.id),
              }, option.label))))
          : null,
        harnessLeader && leaderApp && !isCollab
          ? h(HarnessAppRow, {
            app: leaderApp,
            label: t('harnessModel'),
            busy,
            collapsed: modelOpen,
            onModel: changeHarnessModel,
            onOpen: openHarness,
            onMenuOpened: () => setModelOpen(false),
          })
          : null,
        h('div', { className: 'lp-headrow' },
          // 自定义下拉：原生 select 在深色主题里选项看不清，而且两个 provider 有同名模型，
          // 所以这里把 provider 与模型名分开显示，当前项打勾。
          harnessLeader
            ? h('span', {
              className: 'lp-hint',
              style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: leaderApp?.configPath ?? '',
            }, leaderApp?.note ?? '')
            : h('button', {
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
        harnessOptions.length > 0 && !harnessLeader && !isCollab
          ? h('div', { className: 'lp-headrow lp-harness' },
            h('span', { className: 'lp-harness-label' }, t('harness')),
            h('div', { className: 'lp-seg', role: 'group', 'aria-label': t('harness') },
              harnessOptions.map(option => h('button', {
                key: option.id,
                type: 'button',
                className: 'lp-seg-btn',
                'data-active': option.id === selectedHarness ? '1' : '0',
                disabled: busy || option.available === false,
                title: option.available === false
                  ? `${option.label} · ${t('harnessNoProvider')}`
                  : `${t('harness')}：${option.label}${option.tool ? `（${option.tool}）` : ''}`,
                onClick: () => setHarness(option.id),
              }, option.label))))
          : null,
        workerApp
          ? h(HarnessAppRow, {
            app: workerApp,
            label: t('workerModel'),
            busy,
            collapsed: modelOpen,
            onModel: changeHarnessModel,
            onOpen: openHarness,
            onMenuOpened: () => setModelOpen(false),
          })
          : null,
        modelOpen && !harnessLeader
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
        showTeamCard
          ? h(TeamCard, {
            data,
            leaderName: teamName,
            leaderHarness: teamHarness,
            leaderLabel: teamLabel,
            isHarnessLeader: harnessLeader,
          })
          : null,
        h(PlanCard, { plan: data?.plan }),
        harnessLeader ? h('div', { className: 'lp-hint' }, t('leaderNote')) : null,
        harnessLeader && data?.leaderRun
          ? h('div', { className: 'lp-card' },
            h('div', { className: 'lp-card-title' }, `${t('leaderRunning')} · ${data.leaderRun.label}`),
            h('div', { className: 'lp-wmeta' }, formatDuration(data.leaderRun.elapsedMs)))
          : null,
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
        isCollab && lastRun
          ? h(React.Fragment, null,
            h('div', { className: 'lp-sec' },
              h('b', null, t('resultTitle')),
              h('span', null, lastRun.running ? ` · ${t('resultRunning')}` : ` · ${lastRun.entries.length}`)),
            lastRun.entries.map(entry => h('div', { key: `${lastRun.mode}-${entry.platform}`, className: 'lp-worker' },
              h('span', { className: 'lp-wdot', 'data-s': entry.status === 'running' ? 'running' : entry.status === 'failed' ? 'failed' : 'done' }),
              h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                h('div', null,
                  h('span', { className: 'lp-wname' }, entry.label),
                  h('span', { className: 'lp-wmeta' }, ` · ${entry.status}`
                    + (entry.elapsedMs ? ` · ${formatDuration(entry.elapsedMs)}` : ''))),
                entry.text ? h('div', { className: 'lp-wtext' }, entry.text) : null))))
          : null,
        harnessLeader || collabMode === 'consult' || collabMode === 'pipeline' ? null : h(React.Fragment, null,
          h('div', { className: 'lp-sec' },
          h('b', null, t('workers')),
          h('span', null, workers.length > 0 ? `· ${workers.length}` : '')),
        workers.length === 0
          ? h('div', { className: 'lp-hint' }, t('noWorkers'))
          : workers.map(worker => {
            const harness = memberHarnessOf(worker)
            const style = harnessStyle(harness)
            const workerStatus = memberStatusOf(worker)
            return h('div', {
              key: worker.id ?? worker.name,
              className: 'lp-worker',
              style: { borderLeft: `3px solid ${style.accent}`, background: style.bg },
            },
            h('span', { className: 'lp-wdot', 'data-s': workerStatus, style: dotStyle(harness) }),
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
              h('div', null,
                h('span', { className: 'lp-wname' }, worker.name,
                  worker.external ? h('span', { className: 'lp-tag' }, t('externalTag')) : null),
                h('span', { className: 'lp-wharness', style: { color: style.accent, borderColor: style.accent } }, style.label),
                h('span', { className: 'lp-wmeta' }, ` · ${worker.status}`
                  + (worker.model ? ` · ${worker.model}` : '')
                  + (!worker.external && workerTokens(worker.usage) !== null
                    ? ` · ${formatTokens(workerTokens(worker.usage))} ${t('mTokens')} · ${formatCost(worker.cost, usage?.currency ?? '¥')}`
                    : '')),
              ),
              worker.description ? h('div', { className: 'lp-wmeta' }, worker.description) : null,
              worker.lastText ? h('div', { className: 'lp-wtext' }, worker.lastText) : null,
            ),
            )
          }),
        workers.some(worker => worker.external)
          ? h('div', { className: 'lp-hint' }, t('externalNote'))
          : null),
      ),
      h('div', { className: 'lp-foot' },
        h('div', { className: 'lp-metrics' },
          h('div', { className: 'lp-metric' },
            h('span', null, t('mTokens')), h('b', null, formatTokens(usage?.tokens))),
          h('div', { className: 'lp-metric' },
            h('span', null, t('mCost')), h('b', null, formatCost(usage?.cost, usage?.currency ?? '¥'))),
          h('div', { className: 'lp-metric' },
            h('span', null, t('mElapsed')), h('b', null, formatDuration(usage?.elapsedMs))),
          h('div', { className: 'lp-metric' },
            h('span', null, t('mEta')),
            h('b', null, harnessLeader
              ? '—'
              : usage?.etaMs === null || usage?.etaMs === undefined
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
            placeholder: isCollab ? t('placeholderTask') : t('placeholder'),
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
              disabled: busy, onClick: isCollab ? runCollab : dispatch,
            }, isCollab
              ? collabMode === 'split'
                ? t('runSplit')
                : collabMode === 'consult' ? t('runConsult') : t('runPipeline')
              : harnessLeader ? t('letItWork') : dispatchLabel),
            h('button', {
              className: 'lp-btn', type: 'button',
              disabled: busy || isCollab || draft.trim() === '', onClick: send,
            }, t('send')),
          ),
        ),
        h('div', { className: 'lp-hint' }, data?.priceNote || t('priceNote')),
      )))
    }

    module.exports = {
      name: 'dsh-lead-panel',
      inject: ['slots', 'locale', 'uiSession'],
      apply(ctx) {
        LOCALE = ctx.locale ?? null
        UI_SESSION = ctx.uiSession ?? null
        injectStyle()
        // 右上角浮窗：团队任务在任意会话里触发都会出现（shell.overlay 是整页浮层槽位）。
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-lead-panel.team-hud',
          order: 60,
        }, TeamHud))
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
