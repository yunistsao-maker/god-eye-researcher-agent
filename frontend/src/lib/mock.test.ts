// The mock backend's full run, folded through the real reducer (fake timers, 2× speed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimIndex, evidenceStats, hydrate, initialState, liveness, update, type ResearchState } from '../state';
import type { ProjectGetResult, ProjectListResult, ResearchEvent } from '../types';
import { MockTransport } from './mock';
import { MOCK_SYNTHESIS } from './mockData';

const PID = 'p-20261023-0badc0de';

beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-10-23T08:00:00.000Z') }));
afterEach(() => vi.useRealTimers());

async function settle<T>(p: Promise<T>, ms = 500): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

describe('MockTransport research run', () => {
  it('emits activity, heartbeats, one recovered stall, round 2 and a streamed report', async () => {
    const t = new MockTransport({ log: () => undefined, getSpeed: () => 2 });
    const got: { ev: ResearchEvent; at: number }[] = [];
    await settle(t.subscribe(PID, (ev) => got.push({ ev, at: Date.now() })));
    await settle(t.startResearch({ projectId: PID, topic: '主題', parentProjectId: null }));
    await vi.advanceTimersByTimeAsync(30_000);

    const types = got.map((g) => g.ev.type);
    expect(types[0]).toBe('project.created');
    expect(types[types.length - 1]).toBe('project.completed');

    const of = <T extends ResearchEvent['type']>(type: T) => got.map((g) => g.ev).filter((e): e is Extract<ResearchEvent, { type: T }> => e.type === type);
    const acts = of('agent.activity');
    expect(acts.some((a) => a.data.phase === 'searching' && a.data.detail)).toBe(true);
    expect(acts.some((a) => a.data.phase === 'reading' && a.data.detail?.startsWith('https://example.com/'))).toBe(true);
    for (const phase of ['planning', 'waiting', 'reviewing', 'reporting', 'done'] as const) {
      expect(acts.some((a) => a.data.agentId === 'supervisor' && a.data.phase === phase), phase).toBe(true);
    }
    expect(acts.every((a) => a.data.round === 1 || a.data.round === 2)).toBe(true);
    expect(of('agent.heartbeat').length).toBeGreaterThanOrEqual(5);

    const stalls = of('agent.stalled');
    expect(stalls).toHaveLength(1);
    expect(stalls[0].data.action).toBe('retrying');

    const plans = of('plan.ready');
    expect(plans).toHaveLength(2);
    expect(plans[1].data.subQuestions).toHaveLength(7);
    expect(plans[1].data.subQuestions.slice(0, 5)).toEqual(plans[0].data.subQuestions);
    expect(plans[1].data.subQuestions.slice(5).map((q) => q.round)).toEqual([2, 2]);

    const deltas = of('synthesis.delta');
    expect(deltas.map((d) => d.data.seq)).toEqual(deltas.map((_, i) => i));
    expect(deltas.every((d) => Array.from(d.data.text).length <= 40)).toBe(true);
    expect(deltas.map((d) => d.data.text).join('')).toBe(MOCK_SYNTHESIS.report);
    expect(types.lastIndexOf('synthesis.delta')).toBeLessThan(types.indexOf('synthesis.ready'));
    expect(types.indexOf('synthesis.ready')).toBeLessThan(types.indexOf('project.completed'));

    // The supervisor is never in a heartbeat while it waits for its sub-agents.
    let supPhase = '';
    for (const { ev } of got) {
      if (ev.type === 'agent.activity' && ev.data.agentId === 'supervisor') supPhase = ev.data.phase;
      if (ev.type === 'agent.heartbeat' && supPhase === 'waiting') expect(ev.data.agents.some((a) => a.agentId === 'supervisor')).toBe(false);
    }

    // Fold through the reducer like the app does.
    let s: ResearchState = update(initialState(), { kind: 'run.start', projectId: PID, topic: '主題', parentProjectId: null, at: got[0].at - 300, scale: 2 });
    let sawStall = false;
    let sawStream = false;
    for (const { ev, at } of got) {
      s = update(s, { kind: 'event', event: ev, at });
      if (Object.values(s.agents).some((a) => a.stalled?.action === 'retrying')) sawStall = true;
      if (s.synthesis.status === 'streaming' && s.synthesis.text) sawStream = true;
      if (ev.type === 'agent.heartbeat') expect(liveness(s, at + 1000)).toBe('alive');
    }
    expect(sawStall && sawStream).toBe(true);
    expect(s.project?.status).toBe('completed');
    expect(s.order).toHaveLength(7);
    expect(s.order.every((id) => s.slots[id].status === 'ready')).toBe(true);
    expect(s.order.slice(5).map((id) => s.slots[id].round)).toEqual([2, 2]);
    expect(s.synthesis).toMatchObject({ status: 'ready', text: MOCK_SYNTHESIS.report, contradictions: MOCK_SYNTHESIS.contradictions });
    // Evidence: every page read once, coverage after each review, every citation resolves to a claim.
    expect(of('source.added').length).toBe(s.docs.length);
    expect(new Set(s.docs.map((d) => d.docId)).size).toBe(s.docs.length);
    expect(s.docs.some((d) => d.duplicateOf)).toBe(true);
    expect(of('coverage.updated').map((c) => c.data.round)).toEqual([1, 2]);
    expect(s.requirements).toHaveLength(5);
    const claims = claimIndex(s);
    const cites = Object.values(s.synthesis.citations);
    expect(cites.length).toBeGreaterThan(5);
    expect(cites.every((c) => claims.get(c.claimId)?.findingId === c.findingId)).toBe(true);
    expect(evidenceStats(s)).toMatchObject({ corroborated: expect.any(Number), contested: 1 });
    expect(evidenceStats(s).corroborated).toBeGreaterThan(0);
    expect(s.synthesis.verification?.claimsCited).toBe(cites.length);
    expect(acts.some((a) => a.data.agentId === 'supervisor' && a.data.phase === 'verifying')).toBe(true);
    expect(Object.values(s.agents).some((a) => a.stalled)).toBe(false);
    expect(liveness(s, Date.now())).toBe('idle');

    const saved = (await settle(t.callTool('project_get', { projectId: PID }))) as ProjectGetResult;
    expect(saved.synthesis?.report).toBe(MOCK_SYNTHESIS.report);
    expect(saved.project.status).toBe('completed');
    t.dispose();
  });

  it('the seeded project loads with a report and round-2 cards', async () => {
    const t = new MockTransport({ log: () => undefined, getSpeed: () => 1 });
    const list = (await settle(t.callTool('project_list', {}))) as ProjectListResult;
    const seeded = list.projects.find((x) => x.status === 'completed')!;
    const got = (await settle(t.callTool('project_get', { projectId: seeded.projectId }))) as ProjectGetResult;
    const s = hydrate(got);
    expect(s.synthesis.status).toBe('ready');
    expect(s.synthesis.text).toContain('模擬');
    expect(s.order).toHaveLength(7);
    expect(s.order.filter((id) => s.slots[id].round === 2)).toHaveLength(2);
    expect(s.order.every((id) => s.slots[id].status === 'ready')).toBe(true);
    expect(s.order.filter((id) => s.slots[id].ui.status === 'ready')).toHaveLength(5);
    expect(s.coverage?.round).toBe(2);
    expect(s.docs.length).toBeGreaterThan(10);
    const claims = claimIndex(s);
    expect(Object.values(s.synthesis.citations).every((c) => claims.has(c.claimId))).toBe(true);
    t.dispose();
  });
});
