// The v2 workflow: routes, progress, plan review, steering, follow-up Q&A and incremental re-runs —
// through the reducer and through the mock backend (fake timers).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockTransport } from './lib/mock';
import { MOCK_SUBS, buildFinding } from './lib/mockData';
import { progressOf } from './lib/progress';
import { parseRoute, projectPath } from './router';
import { claimsOf, currentClaims, hydrate, initialState, reduce, update, type ResearchState } from './state';
import type { Finding, ProjectGetResult, ProjectListResult, ResearchEvent } from './types';

const PID = 'p-20261024-5e5e5e5e';
const TS = '2026-10-24T08:00:00.000Z';

function ev<T extends ResearchEvent['type']>(type: T, data: unknown, projectId = PID): ResearchEvent {
  return { type, projectId, ts: TS, data } as ResearchEvent;
}
const fid = (n: number) => `f-5e5e5e5e-${n}`;
const subQuestions = MOCK_SUBS.map((s) => ({ findingId: fid(s.n), question: s.question, dataShape: s.dataShape }));
function finding(n: number): Finding {
  return { ...buildFinding(PID, MOCK_SUBS[n - 1]), findingId: fid(n) };
}
function draft(): ResearchState {
  return update(initialState(), { kind: 'planning.start', projectId: PID, topic: '金融業 AI 客服的法規要求', parentProjectId: null, at: 0 });
}
function running(): ResearchState {
  let s = draft();
  s = update(s, { kind: 'run.begin', projectId: PID, at: 100, scale: 1 });
  s = reduce(s, ev('project.started', { mode: 'full', version: 1 }), { now: 200 });
  return reduce(s, ev('plan.ready', { subQuestions }), { now: 300 });
}

describe('routes', () => {
  it('parses every screen and keeps view parameters', () => {
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#/new')).toEqual({ name: 'new' });
    expect(parseRoute('#/new?from=p-20261022-a1b2c3d4')).toEqual({ name: 'new', from: 'p-20261022-a1b2c3d4' });
    expect(parseRoute('#/new?from=../../etc')).toEqual({ name: 'new' });
    expect(parseRoute('#/library')).toEqual({ name: 'library' });
    expect(parseRoute('#/p/p-20261022-a1b2c3d4')).toEqual({ name: 'project', id: 'p-20261022-a1b2c3d4', view: null, params: {} });
    expect(parseRoute('#/p/p-20261022-a1b2c3d4/evidence?claim=c-1&tab=conflicts')).toEqual({
      name: 'project',
      id: 'p-20261022-a1b2c3d4',
      view: 'evidence',
      params: { claim: 'c-1', tab: 'conflicts' },
    });
    expect(parseRoute('#/p/p-20261022-a1b2c3d4/nope')).toMatchObject({ view: null });
    expect(parseRoute('#/p/NOT_AN_ID/report')).toEqual({ name: 'home' });
  });

  it('builds links that parse back', () => {
    const link = projectPath('p-20261022-a1b2c3d4', 'report', { claim: 'c-1-2' });
    expect(link).toBe('#/p/p-20261022-a1b2c3d4/report?claim=c-1-2');
    expect(parseRoute(link)).toMatchObject({ view: 'report', params: { claim: 'c-1-2' } });
  });
});

describe('progress', () => {
  it('counts the plan, each sub-question, the review and the report', () => {
    let s = running();
    const p0 = progressOf(s, 1000);
    expect(p0).toMatchObject({ done: 1, total: 1 + 5 + 1 + 2, current: 2, etaMin: null });
    for (const n of [1, 2, 3]) s = reduce(s, ev('finding.ready', { finding: finding(n) }), { now: 1000 + n * 60_000 });
    const p1 = progressOf(s, 1000 + 3 * 60_000);
    expect(p1.done).toBe(4);
    expect(p1.etaMin).toBeGreaterThanOrEqual(1);
  });
});

describe('plan review, steering and Q&A in the reducer', () => {
  it('a draft gets a proposed plan, or the reason it has none', () => {
    let s = update(draft(), { kind: 'planning.redo', at: 10 });
    expect(s.project).toMatchObject({ projectId: PID, status: 'draft' });
    expect(s.planning.status).toBe('drafting');
    s = reduce(s, ev('plan.proposed', { subQuestions, requirements: [{ id: 'q1', text: '主管機關的規範與指引' }], by: 'agent' }), { now: 20 });
    expect(s.planning).toEqual({ status: 'ready', error: null });
    expect(s.proposal?.subQuestions).toHaveLength(5);
    expect(s.proposal?.requirements[0].text).toBe('主管機關的規範與指引');

    const failed = reduce(update(draft(), { kind: 'planning.redo', at: 10 }), ev('plan.failed', { message: '問題太籠統' }), { now: 30 });
    expect(failed.planning).toEqual({ status: 'failed', error: '問題太籠統' });
  });

  it('a redirect is marked applied when a plan cites it', () => {
    let s = running();
    s = reduce(s, ev('steer.received', { steer: { steerId: 's-abc', kind: 'redirect', text: '多看半導體封測', createdAt: TS } }), { now: 400 });
    expect(s.steering).toEqual([expect.objectContaining({ steerId: 's-abc', text: '多看半導體封測' })]);
    expect(s.steering[0].appliedRound).toBeUndefined();
    const extra = { findingId: fid(6), question: '依你的新方向：多看半導體封測', dataShape: 'list', round: 2 };
    s = reduce(s, ev('plan.ready', { subQuestions: [...subQuestions, extra], steerIds: ['s-abc'] }), { now: 500 });
    expect(s.steering[0].appliedRound).toBe(2);
    expect(s.order).toContain(fid(6));
  });

  it('newer evidence supersedes a claim without dropping it', () => {
    let s = running();
    s = reduce(s, ev('finding.ready', { finding: finding(1) }), { now: 600 });
    const [first] = claimsOf(s.slots[fid(1)].finding);
    s = reduce(s, ev('claims.updated', { superseded: [{ findingId: fid(1), claimId: first.claimId, supersededBy: 'c-new' }] }), { now: 700 });
    const after = claimsOf(s.slots[fid(1)].finding);
    expect(after.find((c) => c.claimId === first.claimId)).toMatchObject({ status: 'superseded', supersededBy: 'c-new' });
    expect(currentClaims(s.slots[fid(1)].finding).some((c) => c.claimId === first.claimId)).toBe(false);
  });

  it('follow-up questions wait for an answer or show why there is none', () => {
    let s = running();
    s = update(s, { kind: 'qa.ask', qaId: 'qa-1', question: '只看封測時結論會不同嗎？', at: 800 });
    s = update(s, { kind: 'qa.ask', qaId: 'qa-2', question: '加入日本的比較', at: 810 });
    expect(Object.keys(s.qaPending)).toEqual(['qa-1', 'qa-2']);
    s = reduce(s, ev('qa.ready', { qa: { qaId: 'qa-1', question: '只看封測時結論會不同嗎？', answer: '不會 [C1]', citations: [], createdAt: TS } }), { now: 900 });
    expect(s.qa.map((q) => q.qaId)).toEqual(['qa-1']);
    expect(s.qaPending['qa-1']).toBeUndefined();
    s = reduce(s, ev('qa.failed', { qaId: 'qa-2', message: '逾時' }), { now: 950 });
    expect(s.qaPending['qa-2'].error).toBe('逾時');
  });

  it('an incremental run keeps the current report as history', () => {
    let s = running();
    s = reduce(s, ev('synthesis.ready', { synthesis: { report: '# 第一版', contradictions: [], gaps: [], followUps: [], citations: {} } }), { now: 1000 });
    s = reduce(s, ev('project.completed', { stats: { findings: 5 } }), { now: 1100 });
    s = update(s, { kind: 'run.begin', projectId: PID, at: 2000, scale: 1 });
    s = reduce(s, ev('project.started', { mode: 'incremental', version: 2, since: '2026-10-24' }), { now: 2100 });
    expect(s.project).toMatchObject({ status: 'running', version: 2, since: '2026-10-24' });
    expect(s.history).toEqual([expect.objectContaining({ version: 1, report: '# 第一版' })]);
    expect(s.synthesis.status).toBe('none');
  });
});

/* ---------------- the mock backend ---------------- */

beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-10-24T08:00:00.000Z') }));
afterEach(() => vi.useRealTimers());

async function settle<T>(p: Promise<T>, ms = 500): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

function recorder() {
  const got: ResearchEvent[] = [];
  const of = <T extends ResearchEvent['type']>(type: T) => got.filter((e): e is Extract<ResearchEvent, { type: T }> => e.type === type);
  return { got, of, push: (e: ResearchEvent) => got.push(e) };
}

describe('MockTransport workflow', () => {
  it('proposes a plan for review, then researches exactly the approved plan', async () => {
    const t = new MockTransport({ log: () => undefined, getSpeed: () => 4 });
    const r = recorder();
    await settle(t.subscribe(PID, r.push));
    await settle(t.invoke('plan', { projectId: PID, topic: '金融業 AI 客服的法規要求', depth: 'quick' }), 3000);
    const proposed = r.of('plan.proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0].data.subQuestions.length).toBeGreaterThanOrEqual(2);
    const listed = (await settle(t.callTool('project_list', {}))) as ProjectListResult;
    expect(listed.projects.find((p) => p.projectId === PID)?.status).toBe('draft');

    const plan = { subQuestions: [{ question: '金管會對 AI 客服的規範', dataShape: 'list' }, { question: '銀行導入案例', dataShape: 'timeline' }], requirements: [{ id: 'q1', text: '主管機關的規範' }] };
    await settle(t.invoke('start', { projectId: PID, topic: '金融業 AI 客服的法規要求', plan }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.of('project.started')[0].data).toMatchObject({ version: 1 });
    const firstPlan = r.of('plan.ready')[0].data.subQuestions.map((q) => q.question);
    expect(firstPlan).toEqual(['金管會對 AI 客服的規範', '銀行導入案例']);
    expect(r.got[r.got.length - 1].type).toBe('project.completed');
    t.dispose();
  });

  it('a plan that cannot be drafted reports why', async () => {
    const t = new MockTransport({ log: () => undefined, getSpeed: () => 4 });
    const r = recorder();
    await settle(t.subscribe(PID, r.push));
    await settle(t.invoke('plan', { projectId: PID, topic: '這個題目會失敗' }), 3000);
    expect(r.of('plan.failed')).toHaveLength(1);
    expect(r.of('plan.proposed')).toHaveLength(0);
    t.dispose();
  });

  it('a redirect becomes a new sub-question; finishing early still writes the report', async () => {
    const t = new MockTransport({ log: () => undefined, getSpeed: () => 2 });
    const r = recorder();
    await settle(t.subscribe(PID, r.push));
    await settle(t.startResearch({ projectId: PID, topic: '主題', parentProjectId: null }));
    await vi.advanceTimersByTimeAsync(2_000);
    const reply = (await settle(t.callTool('project_steer', { projectId: PID, kind: 'redirect', text: '多看半導體封測，少看 PCB' }))) as { steer: { steerId: string } };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.of('steer.received')[0].data.steer.steerId).toBe(reply.steer.steerId);
    const cited = r.of('plan.ready').filter((p) => (p.data.steerIds ?? []).includes(reply.steer.steerId));
    expect(cited.length).toBeGreaterThan(0);
    expect(cited[0].data.subQuestions.some((q) => q.question.includes('多看半導體封測'))).toBe(true);
    expect(r.of('synthesis.ready')).toHaveLength(1);

    const PID2 = 'p-20261024-6f6f6f6f';
    const r2 = recorder();
    await settle(t.subscribe(PID2, r2.push));
    await settle(t.startResearch({ projectId: PID2, topic: '主題', parentProjectId: null }));
    await vi.advanceTimersByTimeAsync(1_500);
    await settle(t.callTool('project_steer', { projectId: PID2, kind: 'finish' }));
    await vi.advanceTimersByTimeAsync(30_000);
    const rounds = r2.of('plan.ready').map((p) => Math.max(...p.data.subQuestions.map((q) => q.round ?? 1)));
    expect(Math.max(...rounds)).toBe(1); // no supplementary round
    expect(r2.of('synthesis.ready')).toHaveLength(1);
    expect(r2.got[r2.got.length - 1].type).toBe('project.completed');
    t.dispose();
  });

  it('answers follow-ups from the report and re-runs incrementally', async () => {
    const t = new MockTransport({ log: () => undefined, getSpeed: () => 2 });
    const list = (await settle(t.callTool('project_list', {}))) as ProjectListResult;
    const seeded = list.projects.find((p) => p.status === 'completed')!;
    const r = recorder();
    await settle(t.subscribe(seeded.projectId, r.push));

    await settle(t.invoke('ask', { projectId: seeded.projectId, qaId: 'qa-1', question: '只看半導體封測時，結論會不同嗎？' }), 3000);
    await settle(t.invoke('ask', { projectId: seeded.projectId, qaId: 'qa-2', question: '加入日本與韓國的比較' }), 3000);
    const answers = r.of('qa.ready').map((e) => e.data.qa);
    expect(answers.map((a) => a.qaId)).toEqual(['qa-1', 'qa-2']);
    expect(answers[0].needsResearch).toBe(false);
    expect(answers[1].needsResearch).toBe(true);

    await settle(t.invoke('start', { projectId: seeded.projectId, mode: 'incremental', extraQuestions: ['加入日本與韓國的比較'] }));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(r.of('project.started')[0].data).toMatchObject({ mode: 'incremental', version: 2 });
    expect(r.of('claims.updated').length).toBeGreaterThan(0);
    expect(r.got[r.got.length - 1].type).toBe('project.completed');

    const got = (await settle(t.callTool('project_get', { projectId: seeded.projectId }))) as ProjectGetResult;
    const s = hydrate(got);
    expect(s.project?.version).toBe(2);
    expect(s.history.map((h) => h.version)).toContain(1);
    expect(s.qa).toHaveLength(2);
    expect(s.order.some((id) => s.slots[id].question.includes('日本與韓國'))).toBe(true);
    t.dispose();
  });
});
