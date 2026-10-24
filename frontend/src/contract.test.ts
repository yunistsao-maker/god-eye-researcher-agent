// Replays a real backend run through the frontend. The fixture is written by
// tools/tests/test_agent_integration.py (real orchestrator + real tool Lambdas on moto),
// so this fails if the backend and the UI drift apart on event or tool-result shapes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEvent } from './lib/events';
import { unwrapToolResult } from './lib/mcp';
import { parseMarkdown } from './lib/markdown';
import { claimIndex, evidenceStats, hydrate, initialState, liveness, update, type ResearchState } from './state';

const fixture = JSON.parse(readFileSync(new URL('../../contracts/fixtures/sample-run.json', import.meta.url), 'utf8'));
const projectId: string = fixture.projectGet.project.projectId;

function summary(s: ResearchState) {
  const slots = s.order.map((id) => s.slots[id]);
  return {
    status: s.project?.status,
    ready: slots.filter((x) => x.status === 'ready').length,
    subUi: slots.filter((x) => x.ui.status === 'ready').length,
    failed: slots.filter((x) => x.ui.status === 'failed').map((x) => `${x.findingId}: ${x.ui.reason}`),
    spinning: slots.filter((x) => x.ui.status === 'generating').length,
    listShapes: slots.filter((x) => x.dataShape === 'list').map((x) => x.ui.status),
    edges: s.edges.length,
  };
}

describe('backend contract', () => {
  it('replays the live event stream (as AppSync delivers it: JSON strings)', () => {
    let s = update(initialState(), { kind: 'run.start', projectId, topic: fixture.projectGet.project.topic, parentProjectId: null, at: 0, scale: 1 });
    let mid: ReturnType<typeof summary> | null = null;
    let streamedBeforeReady: string | null = null;
    const sentDeltas = fixture.events
      .filter((e: { type: string }) => e.type === 'synthesis.delta')
      .map((e: { data: { text: string } }) => e.data.text)
      .join('');
    fixture.events.forEach((raw: unknown, i: number) => {
      const event = parseEvent(JSON.stringify(raw));
      expect(event, `event #${i} should parse`).not.toBeNull();
      if (event!.type === 'synthesis.ready') streamedBeforeReady = s.synthesis.text;
      s = update(s, { kind: 'event', event: event!, at: i * 100 });
      if (event!.type === 'finding.ready' && event!.data.finding.dataShape === 'list') mid = summary(s);
    });
    // The backend numbers synthesis.delta from 1; every chunk it sent must be on screen, in order,
    // before synthesis.ready replaces the stream with the stored report.
    if (sentDeltas) expect(streamedBeforeReady).toBe(sentDeltas);
    // The live activity of every sub-agent ends in `done`.
    for (const id of s.order) expect(s.agents[id]?.phase, id).toBe('done');
    // a list-shaped finding never shows a sub-UI spinner, even before the run ends
    expect(mid!.listShapes).toEqual(['none']);
    const done = summary(s);
    expect(done).toMatchObject({ status: 'completed', ready: 5, subUi: 4, failed: [], spinning: 0, listShapes: ['none'] });
    expect(done.edges).toBeGreaterThan(5);
    // Live progress and the synthesis are optional: a run without them still settles cleanly.
    const hasSynthesis = fixture.events.some((e: { type: string }) => e.type === 'synthesis.ready');
    if (!hasSynthesis) expect(s.synthesis.status).toBe('none');
    else expect(s.synthesis.status).toBe('ready');
    expect(liveness(s, Date.now())).toBe('idle');
    expect(s.order.every((id) => s.slots[id].round >= 1)).toBe(true);
  });

  it('hydrates project_get exactly as the gateway returns it', () => {
    const wrapped = { content: [{ type: 'text', text: JSON.stringify(fixture.projectGet) }] };
    const s = hydrate(unwrapToolResult(wrapped) as never);
    expect(summary(s)).toMatchObject({ status: 'completed', ready: 5, subUi: 4, failed: [], spinning: 0 });
    const cached = s.order.filter((id) => s.slots[id].ui.cache);
    expect(cached).toHaveLength(1);
    // project_get.synthesis is null (or absent) until synthesis_write runs
    expect(s.synthesis.status).toBe(fixture.projectGet.synthesis ? 'ready' : 'none');
  });

  it('turns a tool business error into an exception', () => {
    const wrapped = { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'Project p-x belongs to another user' }) }] };
    expect(() => unwrapToolResult(wrapped)).toThrow('another user');
  });
});

// Written by tools/tests/test_agent_evidence.py: a run through the evidence backbone (documents,
// verified claims, coverage, a cited and verified report).
const evidence = JSON.parse(readFileSync(new URL('../../contracts/fixtures/evidence-run.json', import.meta.url), 'utf8'));

function citedLabels(report: string): string[] {
  const out: string[] = [];
  const walk = (list: ReturnType<typeof parseMarkdown>) => {
    for (const b of list) {
      const lines = b.t === 'table' ? [...b.head, ...b.rows.flat()] : 'items' in b ? b.items : [b.c];
      for (const line of lines) for (const n of line) if (n.t === 'cite') out.push(n.label);
    }
  };
  walk(parseMarkdown(report));
  return out;
}

function evidenceSummary(s: ResearchState) {
  const claims = claimIndex(s);
  return {
    stats: evidenceStats(s),
    requirements: s.requirements.map((r) => r.id),
    coverage: s.coverage?.requirements.map((c) => `${c.id}:${c.status}`),
    duplicates: s.docs.filter((d) => d.duplicateOf).map((d) => d.docId),
    // every [C#] in the report resolves to a claim the UI has
    unresolved: citedLabels(s.synthesis.text).filter((l) => !claims.has(s.synthesis.citations[l]?.claimId ?? '')),
    verification: s.synthesis.verification,
  };
}

describe('evidence contract', () => {
  const pid: string = evidence.projectGet.project.projectId;
  const expected = {
    stats: { sources: 4, claims: 3, corroborated: 1, asserted: 1, contested: 1, duplicates: 1 },
    requirements: ['q1', 'q2', 'q3'],
    coverage: ['q1:covered', 'q2:weak', 'q3:missing'],
    unresolved: [],
  };

  it('replays the evidence events', () => {
    let s = update(initialState(), { kind: 'run.start', projectId: pid, topic: evidence.projectGet.project.topic, parentProjectId: null, at: 0, scale: 1 });
    evidence.events.forEach((raw: unknown, i: number) => {
      const event = parseEvent(JSON.stringify(raw));
      expect(event, `event #${i} (${(raw as { type: string }).type}) should parse`).not.toBeNull();
      s = update(s, { kind: 'event', event: event!, at: i * 100 });
    });
    const got = evidenceSummary(s);
    expect(got).toMatchObject(expected);
    expect(got.verification).toMatchObject({ citedSentences: 7, supported: 4, removed: 2, precisionBefore: 0.571, precisionAfter: 1 });
    expect(got.verification!.deadUrls).toHaveLength(1);
    expect(s.agents.supervisor.phase).toBe('done');
    expect(s.log.some((l) => l.text.includes('coverage.updated'))).toBe(true);
  });

  it('hydrates the same evidence from project_get', () => {
    const s = hydrate(unwrapToolResult({ content: [{ type: 'text', text: JSON.stringify(evidence.projectGet) }] }) as never);
    expect(evidenceSummary(s)).toMatchObject(expected);
    expect(Object.keys(s.synthesis.citations).sort()).toEqual(['C1', 'C2', 'C3']);
    // The report layout the reader renders: a title, a bold bottom line, a 結論 lead's section and a table.
    const blocks = parseMarkdown(s.synthesis.text);
    expect(blocks[0]).toMatchObject({ t: 'h', level: 2 });
    expect(blocks.some((b) => b.t === 'table' && b.rows.length === 1)).toBe(true);
    const contested = [...claimIndex(s).values()].find((r) => r.claim.status === 'contested')!;
    expect(contested.claim.evidence.map((e) => e.stance)).toEqual(['supports', 'contradicts']);
  });
});
