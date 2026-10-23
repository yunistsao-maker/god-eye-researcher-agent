import { describe, expect, it } from 'vitest';
import { parseEvent } from './lib/events';
import { parseRpcBody, unwrapToolResult } from './lib/mcp';
import { MOCK_SUBS, buildFinding, generatedSpec } from './lib/mockData';
import { resolvePath, validateSpec } from './lib/spec';
import { claimIndex, claimsOf, currentClaims, evidenceStats, hydrate, initialState, reduce, showsSubUi, tierOf, update, type ResearchState } from './state';
import type { Edge, Entity, Finding, ProjectGetResult, ResearchEvent, UiSpec, UiSpecRecord } from './types';

const PID = 'p-20261022-1a2b3c4d';
const TS = '2026-10-22T15:04:05.123Z';

function ev<T extends ResearchEvent['type']>(type: T, data: Extract<ResearchEvent, { type: T }>['data'], projectId = PID): ResearchEvent {
  return { type, projectId, ts: TS, data } as ResearchEvent;
}

const fid = (n: number) => `f-1a2b3c4d-${n}`;

function finding(n: number, overrides: Partial<Finding> = {}): Finding {
  const sub = MOCK_SUBS[n - 1];
  return { ...buildFinding(PID, sub), findingId: fid(n), ...overrides };
}

const subQuestions = MOCK_SUBS.map((s) => ({ findingId: fid(s.n), question: s.question, dataShape: s.dataShape }));

function started(): ResearchState {
  let s = update(initialState(), { kind: 'run.start', projectId: PID, topic: '台灣半導體產業導入生成式 AI 的現況', parentProjectId: null, at: 0, scale: 1 });
  s = reduce(s, ev('project.created', { topic: '台灣半導體產業導入生成式 AI 的現況', parentProjectId: null }), { now: 260 });
  return s;
}

function planned(): ResearchState {
  return reduce(started(), ev('plan.ready', { subQuestions }), { now: 1000 });
}

const compareSpec = generatedSpec('comparison') as UiSpec;

describe('reduce', () => {
  it('plan.ready creates findings in researching state', () => {
    const s = planned();
    expect(s.order).toEqual(subQuestions.map((q) => q.findingId));
    for (const q of subQuestions) {
      const slot = s.slots[q.findingId];
      expect(slot.status).toBe('researching');
      expect(slot.finding).toBeNull();
      expect(slot.ui.status).toBe('none');
      expect(slot.question).toBe(q.question);
      expect(slot.dataShape).toBe(q.dataShape);
      expect(tierOf(slot)).toEqual(['live', '研究中']);
    }
    expect(s.log[0].kind).toBe('ev');
    expect(s.log[0].text).toContain('plan.ready');
  });

  it('finding.ready moves the finding to ready and starts sub-UI generation', () => {
    const f = finding(1);
    const s = reduce(planned(), ev('finding.ready', { finding: f }), { now: 2600 });
    const slot = s.slots[fid(1)];
    expect(slot.status).toBe('ready');
    expect(slot.finding).toEqual(f);
    expect(slot.ui.status).toBe('generating');
    expect(tierOf(slot)).toEqual(['base', '通用卡片']);
    expect(s.slots[fid(2)].status).toBe('researching');
    expect(s.entities['e-fab-a']?.name).toBe('晶圓廠 A');
    expect(s.nodes[fid(1)]?.kind).toBe('finding');
  });

  it('ui.ready when the card is not busy shows the sub-UI', () => {
    let s = reduce(planned(), ev('finding.ready', { finding: finding(1) }));
    s = reduce(s, ev('ui.ready', { findingId: fid(1), spec: compareSpec, cache: false }), { isBusy: () => false });
    const slot = s.slots[fid(1)];
    expect(slot.ui.status).toBe('ready');
    expect(slot.ui.pendingSwap).toBe(false);
    expect(showsSubUi(slot)).toBe(true);
    expect(tierOf(slot)).toEqual(['accent', 'sub-UI · JSON spec']);
    expect(s.templates).toContain('comparison');
  });

  it('ui.ready while the user is inside the card keeps the generic card and offers a swap', () => {
    let s = reduce(planned(), ev('finding.ready', { finding: finding(1) }));
    s = reduce(s, ev('ui.ready', { findingId: fid(1), spec: compareSpec, cache: true }), { isBusy: (id) => id === fid(1) });
    let slot = s.slots[fid(1)];
    expect(slot.ui.status).toBe('ready');
    expect(slot.ui.pendingSwap).toBe(true);
    expect(showsSubUi(slot)).toBe(false);
    expect(tierOf(slot)[1]).toBe('通用卡片');
    s = update(s, { kind: 'swap.apply', findingId: fid(1) });
    slot = s.slots[fid(1)];
    expect(slot.ui.pendingSwap).toBe(false);
    expect(showsSubUi(slot)).toBe(true);
  });

  it('ui.failed marks the sub-UI failed with the reason', () => {
    const reason = 'spec 驗證失敗：元件 RiskMatrix 不在白名單內';
    let s = reduce(planned(), ev('finding.ready', { finding: finding(5) }));
    s = reduce(s, ev('ui.failed', { findingId: fid(5), reason }));
    const slot = s.slots[fid(5)];
    expect(slot.ui.status).toBe('failed');
    expect(slot.ui.reason).toBe(reason);
    expect(showsSubUi(slot)).toBe(false);
    expect(tierOf(slot)).toEqual(['bad', 'sub-UI 驗證失敗']);
    expect(s.log[0].text).toContain(reason);
  });

  it('ui.ready with a component outside the whitelist is treated as failed', () => {
    let s = reduce(planned(), ev('finding.ready', { finding: finding(5) }));
    s = reduce(s, ev('ui.ready', { findingId: fid(5), spec: generatedSpec('list') as UiSpec, cache: false }));
    expect(s.slots[fid(5)].ui.status).toBe('failed');
    expect(s.slots[fid(5)].ui.reason).toBe('spec 驗證失敗：元件 RiskMatrix 不在白名單內');
  });

  it('relation.added adds nodes and edges without duplicates', () => {
    const entities: Entity[] = [
      { id: 'e-fab-a', type: 'org', name: '晶圓廠 A' },
      { id: 'e-knowledge-retrieval', type: 'tech', name: '知識檢索' },
    ];
    const edges: Edge[] = [
      { from: fid(1), to: 'e-fab-a', type: 'mentions' },
      { from: fid(1), to: 'e-knowledge-retrieval', type: 'mentions' },
      { from: fid(2), to: fid(1), type: 'shares_entity', via: 'e-fab-a' },
    ];
    let s = reduce(planned(), ev('relation.added', { entities, edges }));
    expect(Object.keys(s.nodes).sort()).toEqual([fid(1), fid(2), 'e-fab-a', 'e-knowledge-retrieval'].sort());
    expect(s.nodes['e-fab-a'].label).toBe('晶圓廠 A');
    expect(s.edges).toHaveLength(3);

    // Same edges again, plus the symmetric shares_entity in the other direction: nothing new.
    s = reduce(s, ev('relation.added', { entities, edges: [...edges, { from: fid(1), to: fid(2), type: 'shares_entity', via: 'e-fab-a' }] }));
    expect(s.edges).toHaveLength(3);
    expect(Object.keys(s.nodes)).toHaveLength(4);

    // A directed relation is distinct from its reverse.
    s = reduce(s, ev('relation.added', { entities: [], edges: [{ from: fid(1), to: fid(2), type: 'contradicts' }] }));
    s = reduce(s, ev('relation.added', { entities: [], edges: [{ from: fid(1), to: fid(2), type: 'contradicts' }] }));
    expect(s.edges.filter((e) => e.type === 'contradicts')).toHaveLength(1);
    expect(s.log[0].text).toContain('× 0');
  });

  it('project.completed stops the run and updates the saved list', () => {
    let s = planned();
    s = reduce(s, ev('project.completed', { stats: { findings: 5, edges: 30, uiReady: 4, elapsedSec: 9.8 } }));
    expect(s.project?.status).toBe('completed');
    expect(s.clock.running).toBe(false);
    expect(s.projects.find((p) => p.projectId === PID)?.status).toBe('completed');
    expect(s.slots[fid(1)].status).toBe('missing');
  });

  it('events for another project do not touch the open project', () => {
    const s0 = planned();
    const s = reduce(s0, ev('finding.ready', { finding: finding(1) }, 'p-20261022-ffffffff'));
    expect(s.slots).toBe(s0.slots);
    expect(s.log).toHaveLength(s0.log.length + 1);
  });

  it('project.archived removes the project and closes it when open', () => {
    let s = reduce(planned(), ev('project.completed', { stats: { findings: 5, edges: 1, uiReady: 4, elapsedSec: 9 } }));
    s = reduce(s, ev('project.archived', {}));
    expect(s.project).toBeNull();
    expect(s.notice).toBe('archived');
    expect(s.projects.some((p) => p.projectId === PID)).toBe(false);
  });
});

describe('hydrate', () => {
  it('restores a completed project', () => {
    const findings = MOCK_SUBS.map((sub) => finding(sub.n));
    const result: ProjectGetResult = {
      project: { projectId: PID, topic: '台灣半導體產業導入生成式 AI 的現況', status: 'completed', parentProjectId: null, findingCount: 5, stats: { findings: 5, edges: 20, uiReady: 4, elapsedSec: 9.8 } },
      plan: { subQuestions },
      findings,
      uiSpecs: MOCK_SUBS.map(
        (sub): UiSpecRecord =>
          sub.failReason ? { findingId: fid(sub.n), status: 'failed', reason: sub.failReason } : { findingId: fid(sub.n), status: 'ready', spec: generatedSpec(sub.dataShape) },
      ),
      entities: findings.flatMap((f) => f.entities),
      edges: findings.flatMap((f) => f.entities.map((e) => ({ from: f.findingId, to: e.id, type: 'mentions' as const }))),
    };
    const s = hydrate(result);
    expect(s.project?.projectId).toBe(PID);
    expect(s.project?.status).toBe('completed');
    expect(s.clock.running).toBe(false);
    expect(s.order).toEqual(subQuestions.map((q) => q.findingId));
    expect(Object.values(s.slots).every((x) => x.status === 'ready' && x.finding)).toBe(true);
    expect([1, 2, 3, 4].every((n) => showsSubUi(s.slots[fid(n)]))).toBe(true);
    expect(s.slots[fid(5)].ui.status).toBe('failed');
    expect(s.slots[fid(5)].ui.reason).toBe('spec 驗證失敗：元件 RiskMatrix 不在白名單內');
    expect(s.nodes[fid(1)].kind).toBe('finding');
    expect(s.nodes['e-data-sovereignty'].label).toBe('資料主權');
    expect(new Set(s.edges.map((e) => e.from + e.to)).size).toBe(s.edges.length);
    expect(s.projects[0].projectId).toBe(PID);
  });

  it('accepts uiSpecs as a map and derives the plan and edges when missing', () => {
    const f = finding(2);
    const s = hydrate({
      project: { projectId: PID, topic: 't', status: 'completed' },
      findings: [f],
      uiSpecs: { [f.findingId]: generatedSpec('timeline') },
    });
    expect(s.order).toEqual([f.findingId]);
    expect(showsSubUi(s.slots[f.findingId])).toBe(true);
    expect(s.edges.filter((e) => e.type === 'mentions')).toHaveLength(f.entities.length);
  });
});

describe('spec helpers', () => {
  it('validates the whitelist and resolves paths', () => {
    expect(validateSpec(compareSpec)).toBeNull();
    expect(validateSpec({ specVersion: 1, dataShape: 'list', root: { component: 'SandboxedHtml', props: {} } })).toContain('不在白名單內');
    expect(validateSpec({ specVersion: 1, dataShape: 'comparison', root: { component: 'Compare', props: { columns: 'data.columns', rows: '$.data.rows' } } })).toContain('格式不正確');
    const f = finding(1);
    expect(resolvePath('$.data.columns', f)).toEqual(['環節', '階段', '主要用途']);
    expect(resolvePath('$.data.__proto__', f)).toBeUndefined();
  });
});

describe('wire parsing', () => {
  it('parses events from objects, JSON strings and the Amplify envelope', () => {
    const e = { type: 'ui.failed', projectId: PID, ts: TS, data: { findingId: fid(5), reason: 'x' } };
    expect(parseEvent(e)?.type).toBe('ui.failed');
    expect(parseEvent(JSON.stringify(e))?.type).toBe('ui.failed');
    expect(parseEvent({ id: 'sub-1', type: 'data', event: JSON.stringify(e) })?.type).toBe('ui.failed');
    expect(parseEvent({ id: 'sub-1', type: 'data', event: e })?.projectId).toBe(PID);
    expect(parseEvent({ type: 'nope', projectId: PID, data: {} })).toBeNull();
  });

  it('reads MCP JSON and SSE bodies and unwraps tool results', () => {
    const rpc = { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '{"projects":[]}' }] } };
    expect(parseRpcBody(JSON.stringify(rpc), 'application/json', 3)?.id).toBe(3);
    const sse = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${JSON.stringify(rpc)}\n\n`;
    const parsed = parseRpcBody(sse, 'text/event-stream', 3);
    expect(unwrapToolResult(parsed?.result)).toEqual({ projects: [] });
    expect(() => unwrapToolResult({ isError: true, content: [{ type: 'text', text: 'denied' }] })).toThrow('denied');
  });
});

describe('evidence events', () => {
  const doc = (n: number, extra: Record<string, unknown> = {}) => ({
    docId: `d-00000000000${n}`,
    url: `https://example.com/${n}`,
    title: `來源 ${n}`,
    publisher: n === 3 ? 'example.org' : 'example.com',
    sourceType: 'news' as const,
    score: 0.6,
    duplicateOf: null,
    ...extra,
  });

  it('plan.ready keeps the requirements when round 2 re-sends the plan without them', () => {
    let s = reduce(started(), ev('plan.ready', { subQuestions, requirements: [{ id: 'q1', text: '現況' }, { id: 'q1', text: '重複' }, { id: 'q2', text: '' }] }), { now: 1000 });
    expect(s.requirements).toEqual([{ id: 'q1', text: '現況' }]);
    s = reduce(s, ev('plan.ready', { subQuestions }), { now: 2000 });
    expect(s.requirements).toEqual([{ id: 'q1', text: '現況' }]);
  });

  it('source.added adds each document once and logs only new ones', () => {
    let s = planned();
    s = reduce(s, ev('source.added', { doc: doc(1) }), { now: 1100 });
    s = reduce(s, ev('source.added', { doc: doc(2, { duplicateOf: 'd-000000000001', sourceType: 'bogus' }) }), { now: 1200 });
    const logged = s.log.length;
    s = reduce(s, ev('source.added', { doc: doc(1, { score: 7 }) }), { now: 1300 });
    expect(s.log.length).toBe(logged);
    expect(s.docs.map((d) => d.docId)).toEqual(['d-000000000001', 'd-000000000002']);
    expect(s.docs[0].score).toBe(1); // clamped
    expect(s.docs[1]).toMatchObject({ sourceType: 'unknown', duplicateOf: 'd-000000000001' });
    expect(s.log[0].text).toContain('轉載');
    expect(reduce(s, ev('source.added', { doc: { title: 'no id' } as never }), { now: 1400 })).toBe(s);
  });

  it('coverage.updated replaces the coverage and tolerates odd items', () => {
    const s = reduce(
      planned(),
      ev('coverage.updated', { round: 2, requirements: [{ id: 'q1', status: 'covered', claimIds: ['c-1-1'] }, { id: 'q2', status: 'nope' as never, claimIds: [] }, { status: 'weak' } as never] }),
      { now: 1500 },
    );
    expect(s.coverage).toMatchObject({ round: 2, requirements: [{ id: 'q1', status: 'covered' }, { id: 'q2', status: 'missing' }] });
    expect(s.log[0].text).toContain('已涵蓋 1/2');
  });

  it('indexes claims and counts evidence; findings without claims still work', () => {
    let s = planned();
    s = reduce(s, ev('finding.ready', { finding: finding(1) }), { now: 2600 });
    s = reduce(s, ev('finding.ready', { finding: finding(2, { claims: undefined }) }), { now: 2700 });
    const idx = claimIndex(s);
    expect([...idx.values()].every((r) => r.findingId === fid(1))).toBe(true);
    expect(idx.size).toBe(MOCK_SUBS[0].keyPoints.length);
    expect(evidenceStats(s)).toMatchObject({ claims: 3, corroborated: 1, asserted: 2, contested: 0 });
    const [a, b, c] = finding(1).claims!;
    const odd = finding(1, { claims: [{ ...a, status: 'superseded' as never }, { ...b, status: 'weird' as never }, c, { text: 'no id' } as never] });
    expect(claimsOf(odd).map((x) => [x.claimId, x.status])).toEqual([[a.claimId, 'superseded'], [b.claimId, 'asserted'], [c.claimId, c.status]]);
    expect(currentClaims(odd).map((x) => x.claimId)).toEqual([b.claimId, c.claimId]);
  });

  it('a refresh keeps documents the server has not stored yet; another project starts clean', () => {
    let s = planned();
    s = reduce(s, ev('source.added', { doc: doc(1) }), { now: 1100 });
    s = reduce(s, ev('source.added', { doc: doc(3) }), { now: 1150 });
    const result: ProjectGetResult = { project: { projectId: PID, topic: 't', status: 'running' }, docs: [doc(1)], requirements: [{ id: 'q1', text: '現況' }] };
    const again = hydrate(result, s, 2000);
    expect(again.docs.map((d) => d.docId)).toEqual(['d-000000000001', 'd-000000000003']);
    expect(again.requirements).toEqual([{ id: 'q1', text: '現況' }]);
    const other = hydrate({ ...result, project: { ...result.project, projectId: 'p-20261022-ffffffff' } }, s, 2000);
    expect(other.docs.map((d) => d.docId)).toEqual(['d-000000000001']);
    expect(other.coverage).toBeNull();
  });

  it('synthesis.ready keeps citations and the sentence check', () => {
    const s = reduce(
      planned(),
      ev('synthesis.ready', {
        synthesis: {
          report: '主張 [C1]。',
          contradictions: [],
          gaps: [],
          followUps: [],
          citations: { C1: { claimId: 'c-1-1', findingId: fid(1) }, bad: { claimId: 'x', findingId: 'y' } } as never,
          verification: { citedSentences: 2, supported: 1, partial: 1, precisionBefore: 0.5, precisionAfter: 2 } as never,
        },
      }),
      { now: 5000 },
    );
    expect(s.synthesis.citations).toEqual({ C1: { claimId: 'c-1-1', findingId: fid(1) } });
    expect(s.synthesis.verification).toMatchObject({ citedSentences: 2, supported: 1, partial: 1, removed: 0, precisionBefore: 0.5, precisionAfter: 1, deadUrls: [] });
    expect(s.log[0].text).toContain('查核 1/2 句有據');
  });
});
