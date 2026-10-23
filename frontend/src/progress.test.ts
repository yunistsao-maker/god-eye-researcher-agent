// Live progress (agent.activity / heartbeat / stalled), the streamed synthesis, round-2 plans and
// the liveness rule from contracts/events.md.
import { describe, expect, it } from 'vitest';
import { activityLabel, ago, shortUrl } from './lib/activity';
import { parseEvent } from './lib/events';
import { MOCK_FOLLOWUPS, MOCK_SUBS, buildFinding, generatedSpec } from './lib/mockData';
import {
  agentIdleMs,
  hydrate,
  initialState,
  liveness,
  livenessRef,
  reduce,
  update,
  type ResearchState,
} from './state';
import type { ProjectGetResult, ResearchEvent, SubQuestion, Synthesis, UiSpec } from './types';

const PID = 'p-20261023-1a2b3c4d';
const T0 = Date.parse('2026-10-23T08:00:00.000Z');
const TS = '2026-10-23T08:00:00.000Z';
const fid = (n: number) => `f-1a2b3c4d-${n}`;
const sec = (n: number) => n * 1000;

function ev<T extends ResearchEvent['type']>(type: T, data: Extract<ResearchEvent, { type: T }>['data'], ts = TS, projectId = PID): ResearchEvent {
  return { type, projectId, ts, data } as ResearchEvent;
}

const round1: SubQuestion[] = MOCK_SUBS.map((s) => ({ findingId: fid(s.n), question: s.question, dataShape: s.dataShape, round: 1 }));
const round2: SubQuestion[] = MOCK_FOLLOWUPS.map((s) => ({ findingId: fid(s.n), question: s.question, dataShape: s.dataShape, round: 2 }));

/** A run started in this tab at T0, with the round-1 plan. */
function planned(at = T0): ResearchState {
  let s = update(initialState(), { kind: 'run.start', projectId: PID, topic: 't', parentProjectId: null, at, scale: 1 });
  s = reduce(s, ev('project.created', { topic: 't', parentProjectId: null }), { now: at + 260 });
  return reduce(s, ev('plan.ready', { subQuestions: round1 }), { now: at + 1000 });
}

const activity = (agentId: string, phase: Extract<ResearchEvent, { type: 'agent.activity' }>['data']['phase'], detail?: string, round?: number) =>
  ev('agent.activity', { agentId, phase, ...(detail ? { detail } : {}), ...(round ? { round } : {}) });

describe('agent.activity', () => {
  it('records phase, detail, receive time and round per agent', () => {
    let s = reduce(planned(), activity(fid(1), 'searching', '台灣 晶圓廠 生成式 AI', 1), { now: T0 + 2000 });
    expect(s.agents[fid(1)]).toMatchObject({ phase: 'searching', detail: '台灣 晶圓廠 生成式 AI', lastActivityAt: T0 + 2000, round: 1, stalled: null });
    expect(s.log[0].text).toBe('**agent.activity** · F1 · 搜尋：台灣 晶圓廠 生成式 AI');
    s = reduce(s, activity('supervisor', 'reviewing', undefined, 1), { now: T0 + 3000 });
    expect(s.agents.supervisor.phase).toBe('reviewing');
    expect(s.log[0].text).toBe('**agent.activity** · Supervisor · 檢查矛盾與缺口');
    // round is kept when a later activity omits it
    s = reduce(s, activity(fid(1), 'reading', 'https://www.example.com/reports/x'), { now: T0 + 4000 });
    expect(s.agents[fid(1)].round).toBe(1);
    expect(s.log[0].text).toBe('**agent.activity** · F1 · 閱讀：example.com/reports/x');
  });

  it('logs searches, reads and supervisor steps, not thinking/writing/designing/done', () => {
    const s0 = planned();
    let s = s0;
    for (const phase of ['thinking', 'writing', 'designing', 'done'] as const) s = reduce(s, activity(fid(2), phase), { now: T0 + 2000 });
    s = reduce(s, activity('supervisor', 'thinking'), { now: T0 + 2000 });
    expect(s.log).toHaveLength(s0.log.length);
    s = reduce(s, activity('supervisor', 'waiting', '等待 5 個 sub-agent'), { now: T0 + 2100 });
    expect(s.log[0].text).toBe('**agent.activity** · Supervisor · 等待 5 個 sub-agent');
    s = reduce(s, activity(fid(2), 'failed', 'timeout'), { now: T0 + 2200 });
    expect(s.log[0].text).toContain('F2 · 失敗：timeout');
  });

  it('drops an activity published before the one it already has, and caps detail at 200 characters', () => {
    let s = reduce(planned(), ev('agent.activity', { agentId: fid(1), phase: 'searching', detail: 'q2' }, '2026-10-23T08:00:05.000Z'), { now: T0 + 5000 });
    s = reduce(s, ev('agent.activity', { agentId: fid(1), phase: 'thinking' }, '2026-10-23T08:00:04.000Z'), { now: T0 + 5100 });
    expect(s.agents[fid(1)].phase).toBe('searching');
    s = reduce(s, ev('agent.activity', { agentId: fid(1), phase: 'searching', detail: 'x'.repeat(260) }, '2026-10-23T08:00:06.000Z'), { now: T0 + 6000 });
    expect(s.agents[fid(1)].detail).toHaveLength(200);
  });

  it('ignores malformed activity and maps unknown phases to thinking', () => {
    const s0 = planned();
    expect(reduce(s0, ev('agent.activity', { phase: 'searching' } as never))).toBe(s0);
    const s = reduce(s0, ev('agent.activity', { agentId: fid(3), phase: 'dreaming' } as never), { now: T0 + 1 });
    expect(s.agents[fid(3)].phase).toBe('thinking');
  });

  it('live progress for a project that is not open is ignored and not logged', () => {
    const s0 = planned();
    const s = reduce(s0, activity(fid(1), 'searching', 'q'), { now: T0 });
    const other = { ...s, project: { ...s.project!, projectId: 'p-20261023-ffffffff' } };
    expect(reduce(other, activity(fid(1), 'reading', 'https://example.com'))).toBe(other);
    expect(reduce(other, ev('synthesis.delta', { seq: 0, text: 'x' }))).toBe(other);
  });
});

describe('agent.heartbeat', () => {
  it('records the heartbeat time globally and for each listed agent, without logging', () => {
    let s = reduce(planned(), activity('supervisor', 'waiting', '等待 5 個 sub-agent'), { now: T0 + 1100 });
    s = reduce(s, activity(fid(1), 'searching', 'q'), { now: T0 + 2000 });
    const before = s.log.length;
    s = reduce(s, ev('agent.heartbeat', { elapsedSec: 10, agents: [{ agentId: fid(1), phase: 'searching', idleSec: 3 }, { agentId: fid(2), phase: 'reading', idleSec: 4 }] }), { now: T0 + sec(10) });
    expect(s.log).toHaveLength(before);
    expect(s.live.lastHeartbeatAt).toBe(T0 + sec(10));
    expect(s.agents[fid(1)]).toMatchObject({ lastHeartbeatAt: T0 + sec(10), idleSec: 3, phase: 'searching', detail: 'q', lastActivityAt: T0 + 2000 });
    // unknown agent: created from the heartbeat, its last step implied by idleSec
    expect(s.agents[fid(2)]).toMatchObject({ phase: 'reading', detail: null, lastActivityAt: T0 + sec(6), lastHeartbeatAt: T0 + sec(10) });
    // the supervisor is left out while waiting; its entry is untouched
    expect(s.agents.supervisor).toMatchObject({ phase: 'waiting', lastHeartbeatAt: null });
  });

  it('idle time uses whichever of the last activity or the last heartbeat is fresher', () => {
    let s = reduce(planned(), activity(fid(1), 'thinking'), { now: T0 + sec(1) });
    expect(agentIdleMs(s.agents[fid(1)], T0 + sec(21))).toBe(sec(20));
    // the runtime saw output 1 s before its heartbeat at 20 s (the model is generating)
    s = reduce(s, ev('agent.heartbeat', { elapsedSec: 20, agents: [{ agentId: fid(1), phase: 'thinking', idleSec: 1 }] }), { now: T0 + sec(20) });
    expect(agentIdleMs(s.agents[fid(1)], T0 + sec(21))).toBe(sec(2));
  });

  it('adopts the heartbeat phase only when it reports a newer step than the last activity', () => {
    let s = reduce(planned(), activity(fid(1), 'searching', 'q'), { now: T0 + sec(10) });
    s = reduce(s, ev('agent.heartbeat', { elapsedSec: 10, agents: [{ agentId: fid(1), phase: 'thinking', idleSec: 0.2 }] }), { now: T0 + sec(10) + 300 });
    expect(s.agents[fid(1)].phase).toBe('searching'); // batched heartbeat from just before the search
    s = reduce(s, ev('agent.heartbeat', { elapsedSec: 20, agents: [{ agentId: fid(1), phase: 'reading', idleSec: 4 }] }), { now: T0 + sec(20) });
    expect(s.agents[fid(1)]).toMatchObject({ phase: 'reading', detail: null, lastActivityAt: T0 + sec(16) });
  });

  it('logs when heartbeats come back after more than 30 s', () => {
    let s = reduce(planned(), ev('agent.heartbeat', { elapsedSec: 1, agents: [] }), { now: T0 + sec(1) });
    s = reduce(s, ev('agent.heartbeat', { elapsedSec: 11, agents: [] }), { now: T0 + sec(11) });
    const n = s.log.length;
    s = reduce(s, ev('agent.heartbeat', { elapsedSec: 60, agents: [] }), { now: T0 + sec(56) });
    expect(s.log).toHaveLength(n + 1);
    expect(s.log[0].text).toBe('**agent.heartbeat** · 恢復，間隔 45 秒');
  });
});

describe('agent.stalled', () => {
  it('marks the agent stalled; a later activity clears it, an earlier-published one does not', () => {
    let s = reduce(planned(), ev('agent.activity', { agentId: fid(4), phase: 'thinking' }, '2026-10-23T08:00:03.000Z'), { now: T0 + sec(3) });
    s = reduce(s, ev('agent.stalled', { agentId: fid(4), idleSec: 45, action: 'retrying' }, '2026-10-23T08:00:48.000Z'), { now: T0 + sec(48) });
    expect(s.agents[fid(4)].stalled).toMatchObject({ action: 'retrying', idleSec: 45, at: T0 + sec(48) });
    expect(s.agents[fid(4)].phase).toBe('thinking');
    expect(s.log[0].text).toBe('**agent.stalled** · F4 · 閒置 45 秒 · 重新嘗試');
    expect(s.slots[fid(4)].status).toBe('researching');

    // a heartbeat does not clear a stall
    s = reduce(s, ev('agent.heartbeat', { elapsedSec: 50, agents: [{ agentId: fid(4), phase: 'thinking', idleSec: 47 }] }), { now: T0 + sec(50) });
    expect(s.agents[fid(4)].stalled?.action).toBe('retrying');
    // delivered late, published before the stall: still stalled
    s = reduce(s, ev('agent.activity', { agentId: fid(4), phase: 'searching', detail: 'old' }, '2026-10-23T08:00:47.000Z'), { now: T0 + sec(51) });
    expect(s.agents[fid(4)].stalled).not.toBeNull();
    // the retry's first step clears it
    s = reduce(s, ev('agent.activity', { agentId: fid(4), phase: 'searching', detail: 'retry' }, '2026-10-23T08:00:49.000Z'), { now: T0 + sec(52) });
    expect(s.agents[fid(4)]).toMatchObject({ stalled: null, phase: 'searching', detail: 'retry' });
    expect(s.log[0].text).toBe('**agent.activity** · F4 · 恢復 · 搜尋：retry');
  });

  it('gave_up is kept, also for an agent that sent nothing before', () => {
    const s = reduce(planned(), ev('agent.stalled', { agentId: fid(2), idleSec: 90, action: 'gave_up' }), { now: T0 + sec(90) });
    expect(s.agents[fid(2)]).toMatchObject({ stalled: { action: 'gave_up', idleSec: 90 }, lastActivityAt: T0 });
    expect(s.log[0].text).toContain('已放棄');
    const done = reduce(s, ev('project.completed', { stats: { findings: 0, edges: 0, uiReady: 0, elapsedSec: 90 } }));
    expect(done.slots[fid(2)].status).toBe('missing');
    expect(done.agents[fid(2)].stalled?.action).toBe('gave_up');
  });
});

describe('synthesis.delta / synthesis.ready', () => {
  const delta = (seq: number, text: string) => ev('synthesis.delta', { seq, text });
  const fold = (s: ResearchState, list: [number, string][]) => list.reduce((acc, [seq, t]) => reduce(acc, delta(seq, t), { now: T0 }), s);

  it('appends in seq order and logs only the first chunk', () => {
    const s0 = planned();
    const s = fold(s0, [[0, '## 總結'], [1, '\n\n第一段'], [2, '，第二句。']]);
    expect(s.synthesis).toMatchObject({ status: 'streaming', text: '## 總結\n\n第一段，第二句。', next: 3 });
    expect(s.log).toHaveLength(s0.log.length + 1);
    expect(s.log[0].text).toContain('synthesis.delta');
  });

  it('buffers out-of-order chunks until the gap fills', () => {
    let s = fold(planned(), [[2, 'C']]);
    expect(s.synthesis).toMatchObject({ status: 'streaming', text: '' });
    s = fold(s, [[0, 'A']]);
    expect(s.synthesis.text).toBe('A');
    s = fold(s, [[3, 'D']]);
    expect(s.synthesis.text).toBe('A');
    s = fold(s, [[1, 'B']]);
    expect(s.synthesis).toMatchObject({ text: 'ABCD', next: 4, pending: {} });
  });

  it('ignores duplicate seq, appended or still buffered', () => {
    const s0 = fold(planned(), [[0, 'A'], [1, 'B'], [3, 'D']]);
    const s1 = fold(s0, [[0, 'X'], [1, 'Y'], [3, 'Z']]);
    expect(s1.synthesis).toBe(s0.synthesis);
    expect(fold(s1, [[2, 'C']]).synthesis.text).toBe('ABCD');
  });

  it('accepts a stream that counts from 1, and a late chunk 0', () => {
    let s = fold(planned(), [[1, 'B'], [2, 'C']]);
    expect(s.synthesis.text).toBe('BC');
    s = fold(s, [[0, 'A']]);
    expect(s.synthesis.text).toBe('ABC');
    s = fold(s, [[3, 'D']]);
    expect(s.synthesis.text).toBe('ABCD');
  });

  it('ignores malformed chunks', () => {
    const s0 = planned();
    expect(reduce(s0, ev('synthesis.delta', { seq: -1, text: 'x' }))).toBe(s0);
    expect(reduce(s0, ev('synthesis.delta', { seq: 1.5, text: 'x' }))).toBe(s0);
    expect(reduce(s0, ev('synthesis.delta', { seq: 0, text: 3 } as never))).toBe(s0);
  });

  it('synthesis.ready replaces the streamed text with the report; later chunks are ignored', () => {
    const synthesis: Synthesis = { report: '## 總結\n\n完整報告。', contradictions: ['F3 與 F5 不一致', 7 as never], gaps: ['缺少良率數據'], followUps: [], createdAt: TS };
    let s = fold(planned(), [[0, '## 總'], [2, '殘缺']]);
    s = reduce(s, ev('synthesis.ready', { synthesis }), { now: T0 });
    expect(s.synthesis).toMatchObject({ status: 'ready', text: '## 總結\n\n完整報告。', contradictions: ['F3 與 F5 不一致'], gaps: ['缺少良率數據'], followUps: [], createdAt: TS, pending: {} });
    expect(s.log[0].text).toBe('**synthesis.ready** · 報告 12 字 · 矛盾 1 · 缺口 1 · 後續問題 0');
    const after = fold(s, [[1, '晚到'], [3, '更晚']]);
    expect(after.synthesis).toBe(s.synthesis);
  });

  it('a malformed synthesis.ready leaves the stream alone', () => {
    const s0 = fold(planned(), [[0, 'A']]);
    const s = reduce(s0, ev('synthesis.ready', { synthesis: { contradictions: [] } } as never), { now: T0 });
    expect(s.synthesis).toBe(s0.synthesis);
    expect(s.log[0].kind).toBe('note');
  });
});

describe('plan.ready round 2', () => {
  function withFinding(): ResearchState {
    const f = { ...buildFinding(PID, MOCK_SUBS[0]), findingId: fid(1) };
    let s = reduce(planned(), ev('finding.ready', { finding: f }), { now: T0 + 2600 });
    s = reduce(s, ev('ui.ready', { findingId: fid(1), spec: generatedSpec('comparison') as UiSpec, cache: false }), { now: T0 + 5000 });
    return s;
  }

  it('adds the new questions as researching slots without touching the existing ones', () => {
    const s0 = withFinding();
    const s = reduce(s0, ev('plan.ready', { subQuestions: [...round1, ...round2] }), { now: T0 + sec(12) });
    expect(s.order).toEqual([...round1, ...round2].map((q) => q.findingId));
    expect(s.slots[fid(1)]).toBe(s0.slots[fid(1)]);
    expect(s.slots[fid(2)]).toMatchObject({ status: 'researching', round: 1 });
    for (const q of round2) expect(s.slots[q.findingId]).toMatchObject({ status: 'researching', round: 2, question: q.question, finding: null });
    expect(s.plan).toHaveLength(7);
    expect(s.log[0].text).toBe('**plan.ready** · 第 2 輪 · 新增 2 個子題（共 7）');
  });

  it('keeps a finished card even if the plan names another dataShape', () => {
    const s0 = withFinding();
    const changed = round1.map((q, i) => (i === 0 ? { ...q, dataShape: 'list' as const, question: '改寫過的問題' } : q));
    const s = reduce(s0, ev('plan.ready', { subQuestions: [...changed, ...round2] }));
    expect(s.slots[fid(1)]).toBe(s0.slots[fid(1)]);
  });

  it('tolerates a round-2 plan that carries only the new items', () => {
    const s = reduce(withFinding(), ev('plan.ready', { subQuestions: round2 }));
    expect(s.order).toEqual([...round1, ...round2].map((q) => q.findingId));
    expect(s.plan?.map((q) => q.findingId)).toEqual(s.order);
    expect(s.slots[fid(6)].round).toBe(2);
  });

  it('a slot without round defaults to 1', () => {
    const s = reduce(planned(), ev('plan.ready', { subQuestions: [{ findingId: fid(9), question: 'q', dataShape: 'other' }] }));
    expect(s.slots[fid(9)].round).toBe(1);
  });
});

describe('hydrate with live state', () => {
  const synthesis: Synthesis = { report: '## 總結\n\n報告', contradictions: ['c'], gaps: ['g1', 'g2'], followUps: ['f'], createdAt: TS };
  const base = (status: 'running' | 'completed', extra: Partial<ProjectGetResult> = {}): ProjectGetResult => ({
    project: { projectId: PID, topic: 't', status, updatedAt: '2026-10-23T08:00:00.000Z' },
    plan: { subQuestions: [...round1, ...round2] },
    findings: [],
    ...extra,
  });

  it('restores synthesis from project_get and keeps plan rounds', () => {
    const s = hydrate(base('completed', { synthesis }));
    expect(s.synthesis).toMatchObject({ status: 'ready', text: synthesis.report, contradictions: ['c'], gaps: ['g1', 'g2'], followUps: ['f'] });
    expect(s.slots[fid(6)].round).toBe(2);
    expect(s.slots[fid(1)].round).toBe(1);
    expect(hydrate(base('completed', { synthesis: null })).synthesis.status).toBe('none');
    expect(hydrate(base('completed')).synthesis.status).toBe('none');
  });

  it('re-reading the open project keeps this session’s agents, heartbeat and streamed text', () => {
    let s = planned();
    s = reduce(s, activity(fid(1), 'searching', 'q'), { now: T0 + sec(2) });
    s = reduce(s, ev('agent.heartbeat', { elapsedSec: 3, agents: [] }), { now: T0 + sec(3) });
    s = reduce(s, ev('synthesis.delta', { seq: 0, text: '部分' }), { now: T0 + sec(4) });
    const r = update(s, { kind: 'hydrate', result: base('running'), at: T0 + sec(40) });
    expect(r.agents[fid(1)].detail).toBe('q');
    expect(r.live).toMatchObject({ lastHeartbeatAt: T0 + sec(3), startedAt: T0 });
    expect(r.synthesis.text).toBe('部分');
    expect(r.clock.running).toBe(true);
    // a saved report wins over the stream
    expect(update(s, { kind: 'hydrate', result: base('running', { synthesis }) }).synthesis.text).toBe(synthesis.report);
    // another project starts clean
    const other = update(s, { kind: 'hydrate', result: { ...base('running'), project: { projectId: 'p-20261023-99999999', topic: 'x', status: 'running' } }, at: T0 + sec(40) });
    expect(other.agents).toEqual({});
    expect(other.live).toEqual({ lastHeartbeatAt: null, startedAt: null, hydratedAt: T0 + sec(40) });
    expect(other.synthesis.status).toBe('none');
  });
});

describe('liveness(state, now)', () => {
  it('is idle without a running project', () => {
    expect(liveness(initialState(), T0)).toBe('idle');
    const done = reduce(planned(), ev('project.completed', { stats: { findings: 5, edges: 1, uiReady: 4, elapsedSec: 9 } }));
    expect(liveness(done, T0 + sec(1))).toBe('idle');
    expect(livenessRef(done)).toBeNull();
    expect(liveness(hydrate({ project: { projectId: PID, topic: 't', status: 'completed', updatedAt: '2020-01-01T00:00:00Z' } }), T0)).toBe('idle');
  });

  it('a run started in this tab counts from its start until the first heartbeat', () => {
    const s = planned(T0);
    expect(livenessRef(s)).toBe(T0);
    expect(liveness(s, T0 + sec(5))).toBe('alive');
    expect(liveness(s, T0 + sec(15))).toBe('quiet');
    expect(liveness(s, T0 + sec(30))).toBe('quiet');
    expect(liveness(s, T0 + sec(30) + 1)).toBe('stale');
  });

  it('follows heartbeats: alive within 15 s, quiet up to 30 s, then stale', () => {
    let s = reduce(planned(T0), ev('agent.heartbeat', { elapsedSec: 40, agents: [] }), { now: T0 + sec(40) });
    expect(livenessRef(s)).toBe(T0 + sec(40));
    expect(liveness(s, T0 + sec(42))).toBe('alive');
    expect(liveness(s, T0 + sec(54))).toBe('alive');
    expect(liveness(s, T0 + sec(56))).toBe('quiet');
    expect(liveness(s, T0 + sec(71))).toBe('stale');
    s = reduce(s, ev('agent.heartbeat', { elapsedSec: 80, agents: [] }), { now: T0 + sec(80) });
    expect(liveness(s, T0 + sec(81))).toBe('alive');
  });

  const running = (updatedAt: string | undefined): ProjectGetResult => ({ project: { projectId: PID, topic: 't', status: 'running', updatedAt }, plan: { subQuestions: round1 } });

  it('a restored running project: updatedAt older than 3 min is stale at once', () => {
    const s = update(initialState(), { kind: 'hydrate', result: running('2026-10-23T08:00:00.000Z'), at: T0 + sec(181) });
    expect(liveness(s, T0 + sec(181))).toBe('stale');
  });

  it('a restored running project counts from when this tab loaded it (not before) until the first heartbeat', () => {
    // updatedAt 40 s old on load: the runtime only refreshes it every 60 s, so this is not a stop yet.
    const s = update(initialState(), { kind: 'hydrate', result: running('2026-10-23T08:00:00.000Z'), at: T0 + sec(40) });
    expect(livenessRef(s)).toBe(T0 + sec(40));
    expect(liveness(s, T0 + sec(45))).toBe('alive');
    expect(liveness(s, T0 + sec(56))).toBe('quiet');
    expect(liveness(s, T0 + sec(71))).toBe('stale');
    // 2 min old: waits 30 s for a heartbeat, then stale
    const two = update(initialState(), { kind: 'hydrate', result: running('2026-10-23T08:00:00.000Z'), at: T0 + sec(120) });
    expect(liveness(two, T0 + sec(125))).toBe('alive');
    expect(liveness(two, T0 + sec(151))).toBe('stale');
    // heartbeats take over
    const hb = reduce(s, ev('agent.heartbeat', { elapsedSec: 300, agents: [] }), { now: T0 + sec(60) });
    expect(liveness(hb, T0 + sec(85))).toBe('quiet');
    expect(liveness(hb, T0 + sec(91))).toBe('stale');
  });

  it('without a load time it measures from updatedAt', () => {
    const s = hydrate(running('2026-10-23T08:00:00.000Z'));
    expect(livenessRef(s)).toBe(T0);
    expect(liveness(s, T0 + sec(10))).toBe('alive');
    expect(liveness(s, T0 + sec(20))).toBe('quiet');
    expect(liveness(s, T0 + sec(31))).toBe('stale');
    expect(liveness(hydrate(running(undefined)), T0)).toBe('quiet'); // nothing to measure from
  });

  it('「重新整理狀態」: a fresh updatedAt from project_get counts as a sign of life; an old one does not', () => {
    let s = reduce(planned(T0), ev('agent.heartbeat', { elapsedSec: 5, agents: [] }), { now: T0 + sec(5) });
    expect(liveness(s, T0 + sec(40))).toBe('stale');
    const old = update(s, { kind: 'hydrate', result: running('2026-10-23T07:59:00.000Z'), at: T0 + sec(40) });
    expect(liveness(old, T0 + sec(40))).toBe('stale');
    s = update(s, { kind: 'hydrate', result: running('2026-10-23T08:00:38.000Z'), at: T0 + sec(40) });
    expect(liveness(s, T0 + sec(40))).toBe('alive');
    expect(liveness(s, T0 + sec(69))).toBe('stale');
    // the server says it finished meanwhile
    const done = update(s, { kind: 'hydrate', result: { ...running(undefined), project: { projectId: PID, topic: 't', status: 'completed' } }, at: T0 + sec(70) });
    expect(liveness(done, T0 + sec(70))).toBe('idle');
  });
});

describe('activity text', () => {
  it('describes each phase', () => {
    expect(activityLabel('searching', 'fab LLM')).toBe('搜尋：fab LLM');
    expect(activityLabel('reading', 'https://www.example.com/reports/semiconductor-genai-survey?x=1')).toBe('閱讀：example.com/reports/semiconductor-genai-survey');
    expect(activityLabel('thinking')).toBe('思考中…');
    expect(activityLabel('writing')).toBe('寫入 finding');
    expect(activityLabel('designing')).toBe('設計 sub-UI');
    expect(activityLabel('planning')).toBe('規劃中');
    expect(activityLabel('planning', null, 2)).toBe('規劃補充研究');
    expect(activityLabel('waiting')).toBe('等待 sub-agent 完成');
    expect(activityLabel('waiting', '等待 5 個 sub-agent')).toBe('等待 5 個 sub-agent');
    expect(activityLabel('reviewing')).toBe('檢查矛盾與缺口');
    expect(activityLabel('reporting')).toBe('撰寫報告');
  });

  it('shortens URLs and formats ages', () => {
    const long = shortUrl('https://example.com/' + 'a'.repeat(80));
    expect(Array.from(long)).toHaveLength(48);
    expect(long.endsWith('…')).toBe(true);
    expect(shortUrl('not a url')).toBe('not a url');
    expect(shortUrl('https://example.com/')).toBe('example.com');
    expect(ago(2400)).toBe('2 秒前');
    expect(ago(-50)).toBe('0 秒前');
    expect(ago(125_000)).toBe('2 分鐘前');
  });
});

describe('wire parsing of the new events', () => {
  it('accepts every live-progress and synthesis event type', () => {
    for (const [type, data] of [
      ['agent.activity', { agentId: 'f-1', phase: 'searching', detail: 'q', round: 1 }],
      ['agent.heartbeat', { elapsedSec: 10, agents: [] }],
      ['agent.stalled', { agentId: 'f-1', idleSec: 45, action: 'retrying' }],
      ['synthesis.delta', { seq: 0, text: 'x' }],
      ['synthesis.ready', { synthesis: { report: 'r', contradictions: [], gaps: [], followUps: [] } }],
    ] as const) {
      expect(parseEvent(JSON.stringify({ type, projectId: PID, ts: TS, data }))?.type).toBe(type);
    }
  });
});
