/*
 * Mock transport: runs the whole backend in the browser. Emits the same event objects as the
 * contracts (as JSON, parsed by the same parser as live) on the prototype's timing, and mocks
 * project-tools in memory. No AWS calls.
 *
 * Run order (contracts/events.md): plan (with requirements) → 5 sub-agents in parallel (one stalls
 * once and recovers; every page read is a source.added) → review (coverage.updated) → round 2 with 2
 * follow-up questions → coverage.updated → report streamed as synthesis.delta → verifying →
 * synthesis.ready (citations, verification) → project.completed. agent.activity for every step,
 * agent.heartbeat every 2 s.
 */
import type {
  AgentPhase,
  Coverage,
  DataShape,
  Edge,
  Entity,
  Finding,
  Project,
  ProjectGetResult,
  Requirement,
  ResearchEvent,
  ResearchEventType,
  SourceDoc,
  SubQuestion,
  Synthesis,
  UiSpecRecord,
} from '../types';
import { parseEvent } from './events';
import { newProjectId } from './ids';
import {
  MOCK_FOLLOWUPS,
  MOCK_REQUIREMENTS,
  MOCK_SUBS,
  MOCK_SYNTHESIS,
  MOCK_TOPIC,
  buildFinding,
  buildSynthesis,
  chunkText,
  findingIdFor,
  generatedSpec,
  mockCoverage,
  mockDocs,
  relationEdges,
  type MockSub,
} from './mockData';
import { specProblem } from './spec';
import { wireToolName, type LogFn, type StartResearchArgs, type Transport } from './transport';

interface StoredProject {
  project: Project;
  plan: SubQuestion[];
  findings: Finding[];
  uiSpecs: UiSpecRecord[];
  entities: Entity[];
  edges: Edge[];
  synthesis: Synthesis | null;
  requirements: Requirement[];
  docs: SourceDoc[];
  coverage: Coverage | null;
}

function addDocs(into: SourceDoc[], list: SourceDoc[]): SourceDoc[] {
  const fresh = list.filter((d) => !into.some((x) => x.docId === d.docId));
  into.push(...fresh);
  return fresh;
}

function claimCount(findings: Finding[]): number {
  return findings.reduce((n, f) => n + (f.claims?.length ?? 0), 0);
}

const SEEDED_ID = 'p-20261022-a1b2c3d4';
const SEEDED_RETAIL_ID = 'p-20261015-c7e9f0a2';
const CLEANUP_STEP_MS = 420;
const CLEANUP_STEPS = 6;
/** All timings below are 1× milliseconds; the 1×/2× toggle divides them. */
const HEARTBEAT_MS = 2000;
const DELTA_MS = 120;
const DELTA_CHARS = 40;
const SHAPED: ReadonlySet<DataShape> = new Set<DataShape>(['comparison', 'timeline', 'metrics']);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toQuestion(projectId: string, s: MockSub): SubQuestion {
  return { findingId: findingIdFor(projectId, s.n), question: s.question, dataShape: s.dataShape, round: s.round };
}

function planFor(projectId: string, withFollowUps = false): SubQuestion[] {
  return [...MOCK_SUBS, ...(withFollowUps ? MOCK_FOLLOWUPS : [])].map((s) => toQuestion(projectId, s));
}

function mergeEntities(into: Entity[], list: Entity[]) {
  for (const e of list) if (!into.some((x) => x.id === e.id)) into.push(e);
}

/** Mock F5 deliberately goes through uigen and fails; other list/other findings get no sub-UI (as in the contract). */
function getsSubUi(sub: MockSub): boolean {
  return SHAPED.has(sub.dataShape) || !!sub.failReason;
}

/** A finished project equivalent to one full mock run (used to seed the store). */
function seededProject(): StoredProject {
  const projectId = SEEDED_ID;
  const arrival = [...[...MOCK_SUBS].sort((a, b) => a.at - b.at), ...MOCK_FOLLOWUPS];
  const findings: Finding[] = [];
  const edges: Edge[] = [];
  const entities: Entity[] = [];
  for (const sub of arrival) {
    const f = buildFinding(projectId, sub);
    edges.push(...relationEdges(f, sub, findings));
    findings.push(f);
    mergeEntities(entities, f.entities);
  }
  findings.sort((a, b) => a.findingId.localeCompare(b.findingId));
  const uiSpecs: UiSpecRecord[] = arrival
    .filter(getsSubUi)
    .sort((a, b) => a.n - b.n)
    .map((sub) => {
      const findingId = findingIdFor(projectId, sub.n);
      if (sub.failReason) return { findingId, status: 'failed', reason: sub.failReason };
      return { findingId, status: 'ready', spec: generatedSpec(sub.dataShape), cache: sub.round === 2 };
    });
  const uiReady = uiSpecs.filter((u) => u.status === 'ready').length;
  const docs: SourceDoc[] = [];
  for (const sub of arrival) addDocs(docs, mockDocs(sub));
  return {
    project: {
      projectId,
      topic: MOCK_TOPIC,
      status: 'completed',
      parentProjectId: null,
      createdAt: '2026-10-22T06:12:03.000Z',
      updatedAt: '2026-10-22T06:12:21.000Z',
      findingCount: findings.length,
      stats: { findings: findings.length, edges: edges.length, uiReady, elapsedSec: 17.6, sources: docs.length, claims: claimCount(findings) },
    },
    plan: planFor(projectId, true),
    findings,
    uiSpecs,
    entities,
    edges,
    synthesis: buildSynthesis(projectId, '2026-10-22T06:12:20.000Z'),
    requirements: clone(MOCK_REQUIREMENTS),
    docs,
    coverage: mockCoverage(projectId, 2),
  };
}

function seededRetail(): StoredProject {
  return {
    project: {
      projectId: SEEDED_RETAIL_ID,
      topic: '零售業 AI 需求預測的導入方式',
      status: 'completed',
      parentProjectId: null,
      createdAt: '2026-10-15T02:40:11.000Z',
      updatedAt: '2026-10-15T02:40:24.000Z',
      findingCount: 6,
      stats: { findings: 6, edges: 21, uiReady: 5, elapsedSec: 12.4 },
    },
    plan: [],
    findings: [],
    uiSpecs: [],
    entities: [],
    edges: [],
    synthesis: null,
    requirements: [],
    docs: [],
    coverage: null,
  };
}

interface AgentTrack {
  phase: AgentPhase;
  /** 1× ms of its last step. */
  lastMs: number;
}

interface Run {
  projectId: string;
  token: number;
  t0: number;
  speed: number;
  /** 1× ms timeline position of the callback that is running now. */
  nowMs: number;
  /** Sub-agents of the current round that have not finished (finding written and sub-UI done). */
  open: Set<number>;
  round: 1 | 2;
  uiReady: number;
  edges: number;
  written: Finding[];
  agents: Map<string, AgentTrack>;
  completing: boolean;
}

export interface MockOptions {
  log: LogFn;
  getSpeed: () => number;
}

export class MockTransport implements Transport {
  readonly mode = 'mock' as const;
  private readonly log: LogFn;
  private readonly getSpeed: () => number;
  private readonly handlers = new Map<string, Set<(e: ResearchEvent) => void>>();
  private readonly store = new Map<string, StoredProject>();
  private readonly templates = new Map<DataShape, unknown>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private run: Run | null = null;
  private runSeq = 0;

  constructor(opts: MockOptions) {
    this.log = opts.log;
    this.getSpeed = opts.getSpeed;
    for (const p of [seededProject(), seededRetail()]) this.store.set(p.project.projectId, p);
  }

  /* ---------- plumbing ---------- */

  private speed(): number {
    const s = this.getSpeed();
    return s > 0 ? s : 1;
  }

  private timer(ms: number, fn: () => void) {
    const h = setTimeout(() => {
      this.timers.delete(h);
      fn();
    }, ms);
    this.timers.add(h);
  }

  /** Schedules `fn` `ms` (1× time) after the current point of the run; dropped if the run was replaced or finished. */
  private later(run: Run, ms: number, fn: () => void) {
    const d = Math.max(0, ms);
    const abs = run.nowMs + d;
    this.timer(d / run.speed, () => {
      if (!this.run || this.run.token !== run.token) return;
      run.nowMs = abs;
      fn();
    });
  }

  private emit<T extends ResearchEventType>(projectId: string, type: T, data: Extract<ResearchEvent, { type: T }>['data']) {
    const wire = JSON.stringify({ type, projectId, ts: new Date().toISOString(), data });
    const hs = this.handlers.get(projectId);
    if (!hs) return;
    for (const h of hs) {
      queueMicrotask(() => {
        const ev = parseEvent(wire);
        if (ev) h(ev);
      });
    }
  }

  private gw(text: string) {
    this.log('gw', text);
  }

  /* ---------- Transport ---------- */

  async subscribe(projectId: string, onEvent: (event: ResearchEvent) => void): Promise<() => void> {
    await wait(40);
    let set = this.handlers.get(projectId);
    if (!set) this.handlers.set(projectId, (set = new Set()));
    set.add(onEvent);
    this.log('note', '已訂閱 /research/' + projectId);
    return () => {
      const s = this.handlers.get(projectId);
      if (!s) return;
      s.delete(onEvent);
      if (!s.size) this.handlers.delete(projectId);
    };
  }

  async startResearch(args: StartResearchArgs): Promise<void> {
    this.gw(`POST **research**/invocations · session ${args.projectId}`);
    await wait(60);
    if (this.run && !this.run.completing) throw new Error('已有研究正在進行');
    const parent = args.parentProjectId ? this.store.get(args.parentProjectId) : undefined;
    if (args.parentProjectId && !parent) throw new Error('找不到 parent 專案 ' + args.parentProjectId);
    this.startRun(args.projectId, args.topic || MOCK_TOPIC, parent ?? null);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const wire = wireToolName(name);
    const id = typeof args.projectId === 'string' ? args.projectId : typeof args.parentProjectId === 'string' ? args.parentProjectId : '';
    this.gw(`tools/call **${wire}**${id ? ' · ' + id : ''}`);
    await wait(90 / this.speed());
    const short = wire.split('___').pop();
    switch (short) {
      case 'project_list':
        return clone({ projects: this.listProjects() });
      case 'project_get':
        return clone(this.getProject(String(args.projectId ?? '')));
      case 'project_restart':
        return this.restart(String(args.parentProjectId ?? ''));
      case 'project_cleanup':
        return this.cleanup(String(args.projectId ?? ''));
      case 'project_save':
        return this.save(args);
      default:
        throw new Error(`未知的工具 ${wire}`);
    }
  }

  dispose(): void {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.handlers.clear();
    this.run = null;
  }

  /** Mock-only: clears the ui-templates/ cache so the next run regenerates every sub-UI. */
  clearTemplates(): void {
    this.templates.clear();
  }

  /* ---------- project-tools ---------- */

  private listProjects(): Project[] {
    return [...this.store.values()]
      .map((p) => p.project)
      .filter((p) => p.status !== 'archived')
      .sort((a, b) => (b.createdAt ?? b.projectId).localeCompare(a.createdAt ?? a.projectId));
  }

  private getProject(projectId: string): ProjectGetResult {
    const p = this.store.get(projectId);
    if (!p || p.project.status === 'archived') throw new Error('找不到專案 ' + projectId);
    return {
      project: p.project,
      plan: { subQuestions: p.plan },
      findings: p.findings,
      uiSpecs: p.uiSpecs,
      entities: p.entities,
      edges: p.edges,
      synthesis: p.synthesis,
      requirements: p.requirements,
      docs: p.docs,
      coverage: p.coverage,
    };
  }

  private restart(parentProjectId: string) {
    const parent = this.store.get(parentProjectId);
    if (!parent) throw new Error('找不到專案 ' + parentProjectId);
    return { projectId: newProjectId(), parentProjectId, topic: parent.project.topic };
  }

  private save(args: Record<string, unknown>) {
    const projectId = String(args.projectId ?? '');
    const p = this.store.get(projectId);
    if (!p) throw new Error('找不到專案 ' + projectId);
    const status = args.status;
    if (status !== 'running' && status !== 'completed' && status !== 'failed') throw new Error('status 不正確');
    if (status === 'completed' && p.project.status !== 'completed') throw new Error('專案尚未完成，不能以 completed 儲存');
    p.project = { ...p.project, status, updatedAt: new Date().toISOString() };
    const ui = p.uiSpecs.filter((u) => u.status === 'ready').length;
    this.log('note', `寫入 manifest.json、findings/×${p.findings.length}、graph/graph.json、ui/×${ui}${p.synthesis ? '、synthesis.json' : ''}`);
    if (status === 'completed' && p.project.stats) this.emit(projectId, 'project.completed', { stats: p.project.stats });
    return clone({ project: p.project });
  }

  private cleanup(projectId: string) {
    const p = this.store.get(projectId);
    if (!p || p.project.status === 'archived') throw new Error('找不到專案 ' + projectId);
    if (p.project.status === 'running') throw new Error('研究中的專案不能清理');
    if (p.project.status === 'archiving') throw new Error('專案正在清理中');
    p.project = { ...p.project, status: 'archiving' };
    const speed = this.speed();
    this.log('note', 'Step Functions 清理流程啟動');
    this.timer(((CLEANUP_STEPS + 1) * CLEANUP_STEP_MS) / speed, () => {
      p.project = { ...p.project, status: 'archived' };
      this.emit(projectId, 'project.archived', {});
    });
    return { projectId, status: 'archiving' as const, executionArn: `arn:aws:states:us-west-2:000000000000:execution:project-cleanup:${projectId}` };
  }

  /* ---------- research simulation ---------- */

  /** agent.activity, and remembers the step for the next heartbeat. */
  private act(run: Run, agentId: string, phase: AgentPhase, round: number, detail?: string) {
    run.agents.set(agentId, { phase, lastMs: run.nowMs });
    const data: { agentId: string; phase: AgentPhase; round: number; detail?: string } = { agentId, phase, round };
    if (detail) data.detail = detail;
    this.emit(run.projectId, 'agent.activity', data);
  }

  private heartbeat(run: Run, stored: StoredProject) {
    const agents = [...run.agents.entries()]
      // Finished agents drop out; the supervisor is not watched while it waits for its sub-agents.
      .filter(([id, a]) => a.phase !== 'done' && a.phase !== 'failed' && !(id === 'supervisor' && a.phase === 'waiting'))
      .map(([agentId, a]) => ({ agentId, phase: a.phase, idleSec: Math.max(0, Math.round((run.nowMs - a.lastMs) / 100) / 10) }));
    this.emit(run.projectId, 'agent.heartbeat', { elapsedSec: Math.round(run.nowMs / 100) / 10, agents });
    stored.project = { ...stored.project, updatedAt: new Date().toISOString() };
    this.later(run, HEARTBEAT_MS, () => this.heartbeat(run, stored));
  }

  private startRun(projectId: string, topic: string, parent: StoredProject | null) {
    const run: Run = {
      projectId,
      token: ++this.runSeq,
      t0: performance.now(),
      speed: this.speed(),
      nowMs: 0,
      open: new Set(MOCK_SUBS.map((s) => s.n)),
      round: 1,
      uiReady: 0,
      edges: 0,
      written: [],
      agents: new Map(),
      completing: false,
    };
    this.run = run;
    const parentId = parent?.project.projectId ?? null;
    const stored: StoredProject = {
      project: { projectId, topic, status: 'running', parentProjectId: parentId, createdAt: new Date().toISOString(), findingCount: 0 },
      plan: [],
      findings: [],
      uiSpecs: [],
      entities: [],
      edges: [],
      synthesis: null,
      requirements: [],
      docs: [],
      coverage: null,
    };
    const L = (ms: number, fn: () => void) => this.later(run, ms, fn);

    L(150, () => {
      this.gw('tools/call **project-tools___project_save** · 建立 manifest.json');
      stored.project = { ...stored.project, updatedAt: new Date().toISOString() };
      this.store.set(projectId, stored);
    });
    L(260, () => this.emit(projectId, 'project.created', { topic, parentProjectId: parentId }));
    L(300, () => this.act(run, 'supervisor', 'planning', 1));
    L(400, () => this.heartbeat(run, stored));
    if (parent) {
      L(420, () => this.gw(`tools/call **project-tools___project_get** · 讀取 ${parent.project.projectId}`));
      L(560, () => this.log('note', `seed：帶入 ${parent.project.projectId} 的 ${parent.findings.length || parent.project.findingCount || 0} 筆 findings 摘要`));
    }
    L(640, () => this.act(run, 'supervisor', 'thinking', 1));
    L(900, () => this.gw('tools/call **data-tools___plan_save** · ' + MOCK_SUBS.length + ' 個子題'));
    L(1000, () => {
      stored.plan = planFor(projectId);
      stored.requirements = clone(MOCK_REQUIREMENTS);
      this.emit(projectId, 'plan.ready', { subQuestions: stored.plan, requirements: stored.requirements });
    });
    L(1060, () => this.act(run, 'supervisor', 'waiting', 1, `等待 ${MOCK_SUBS.length} 個 sub-agent`));

    const subs = MOCK_SUBS.map((sub) => ({ sub, at: sub.at * (parent ? 0.85 + Math.random() * 0.25 : 1) }));
    // One sub-agent goes quiet once: the watchdog cancels it and it recovers (the latest one without a sub-UI failure).
    const stallN = subs.filter((x) => !x.sub.failReason).sort((a, b) => b.at - a.at)[0]?.sub.n;
    subs.forEach(({ sub, at }, i) => this.scheduleSubAgent(run, stored, sub, 0, 1080 + i * 70, 1500 + i * 230, at, sub.n === stallN));
  }

  /**
   * One sub-agent's steps: thinking → searching → reading → … → writing (finding.ready) → designing
   * (sub-UI) → done. Times are 1× ms from `base`; `at` is when finding.ready goes out.
   */
  private scheduleSubAgent(run: Run, stored: StoredProject, sub: MockSub, base: number, start: number, firstSearch: number, at: number, stall: boolean) {
    const id = findingIdFor(run.projectId, sub.n);
    const F = 'F' + sub.n;
    const docs = mockDocs(sub);
    const urls = docs.filter((d) => !d.duplicateOf).map((d) => d.url);
    const L = (ms: number, fn: () => void) => this.later(run, base + ms - run.nowMs, fn);
    const A = (ms: number, phase: AgentPhase, detail?: string) =>
      L(ms, () => {
        this.act(run, id, phase, sub.round, detail);
        // fetch_page registers the page (and any syndicated copy found next to it) as a project document.
        if (phase === 'reading') {
          const read = docs.filter((d) => d.url === detail || (d.duplicateOf && docs.find((x) => x.docId === d.duplicateOf)?.url === detail));
          this.later(run, 180, () => this.addSources(run, stored, read));
        }
      });
    const writeAt = at - 120;

    L(start, () => this.gw(`POST **subagent**/invocations · ${F}${sub.round === 2 ? ' · 補充研究' : ''}`));
    A(start + 40, 'thinking');
    L(firstSearch, () => this.gw(`tools/call **web-search___WebSearch** · ${F}`));
    L(firstSearch + 300, () => this.gw(`tools/call **web-tools___fetch_page** · ${F} × ${urls.length}`));

    type Step = [AgentPhase, string?];
    const full: Step[] = [['searching', sub.queries[0]], ['reading', urls[0]], ['thinking'], ['searching', sub.queries[1]], ['reading', urls[1]], ['thinking']];
    const short: Step[] = [['searching', sub.queries[0]], ['reading', urls[0]], ['reading', urls[1]], ['thinking']];
    const spread = (steps: Step[], from: number, to: number) => {
      const gap = Math.max(80, (to - from) / steps.length);
      steps.forEach(([phase, detail], k) => A(from + k * gap, phase, detail));
    };

    const thinkAt = firstSearch + 600;
    const silence = Math.min(1500, writeAt - thinkAt - 730);
    if (stall && silence >= 800) {
      // searching → reading → thinking … nothing … agent.stalled (retrying) → the retry runs the second search.
      spread([['searching', sub.queries[0]], ['reading', urls[0]], ['thinking']], firstSearch, thinkAt + 300);
      const stalledAt = thinkAt + silence;
      L(stalledAt, () => {
        this.log('note', `watchdog：${F} 閒置 ${(silence / 1000).toFixed(1)} 秒，取消後重試`);
        this.emit(run.projectId, 'agent.stalled', { agentId: id, idleSec: Math.round(silence / 1000), action: 'retrying' });
      });
      spread([['thinking'], ['searching', sub.queries[1]], ['reading', urls[1]], ['thinking']], stalledAt + 160, writeAt);
    } else {
      const to = writeAt - 150;
      spread((to - firstSearch) / full.length >= 260 ? full : short, firstSearch, to);
    }

    A(writeAt, 'writing');
    L(writeAt, () => this.gw(`tools/call **data-tools___finding_write** · ${F} · schema OK`));
    L(at, () => this.onFinding(run, stored, sub));
    if (getsSubUi(sub)) {
      A(at + 240, 'designing');
      L(at + 240, () => this.onUiCheck(run, stored, sub));
    } else {
      L(at + 80, () => this.subDone(run, stored, sub));
    }
  }

  /** source.added for pages this project has not read yet. */
  private addSources(run: Run, stored: StoredProject, docs: SourceDoc[]) {
    for (const doc of addDocs(stored.docs, docs)) this.emit(run.projectId, 'source.added', { doc: clone(doc) });
  }

  private onFinding(run: Run, stored: StoredProject, sub: MockSub) {
    this.addSources(run, stored, mockDocs(sub)); // a page whose reading step was skipped (never in practice)
    const f = buildFinding(run.projectId, sub);
    const edges = relationEdges(f, sub, run.written);
    run.written.push(f);
    run.edges += edges.length;
    stored.findings.push(f);
    stored.edges.push(...edges);
    mergeEntities(stored.entities, f.entities);
    stored.project = { ...stored.project, findingCount: stored.findings.length };
    this.emit(run.projectId, 'finding.ready', { finding: f });
    this.later(run, 160, () => this.emit(run.projectId, 'relation.added', { entities: f.entities, edges }));
  }

  private onUiCheck(run: Run, stored: StoredProject, sub: MockSub) {
    const F = 'F' + sub.n;
    const findingId = findingIdFor(run.projectId, sub.n);
    const cached = this.templates.get(sub.dataShape);
    this.gw(`tools/call **data-tools___ui_template_get** · ${sub.dataShape} → ${cached ? '命中' : '未命中'}`);
    if (cached) {
      this.later(run, 260, () => {
        this.gw(`tools/call **data-tools___ui_spec_write** · ${F} · fromCache`);
        stored.uiSpecs.push({ findingId, status: 'ready', spec: clone(cached), cache: true });
        run.uiReady++;
        this.emit(run.projectId, 'ui.ready', { findingId, spec: clone(cached) as never, cache: true });
        this.subDone(run, stored, sub);
      });
      return;
    }
    this.later(run, 120, () => this.gw(`POST **uigen**/invocations · ${F} · ${sub.dataShape}`));
    this.later(run, 120 + sub.uiDelay, () => {
      this.gw(`tools/call **data-tools___ui_spec_write** · ${F}`);
      const spec = generatedSpec(sub.dataShape);
      const problem = specProblem(spec);
      this.later(run, 140, () => {
        if (problem) {
          const reason = sub.failReason ?? problem;
          stored.uiSpecs.push({ findingId, status: 'failed', reason });
          this.emit(run.projectId, 'ui.failed', { findingId, reason });
        } else {
          this.templates.set(sub.dataShape, spec);
          stored.uiSpecs.push({ findingId, status: 'ready', spec, cache: false });
          run.uiReady++;
          this.emit(run.projectId, 'ui.ready', { findingId, spec: spec as never, cache: false });
        }
        this.subDone(run, stored, sub);
      });
    });
  }

  /** The sub-agent finished (finding written, sub-UI done). The last one of a round moves the supervisor on. */
  private subDone(run: Run, stored: StoredProject, sub: MockSub) {
    this.act(run, findingIdFor(run.projectId, sub.n), 'done', sub.round);
    run.open.delete(sub.n);
    if (run.open.size) return;
    if (run.round === 1) this.review(run, stored);
    else this.report(run, stored);
  }

  /** Supervisor review of round 1, then round 2 for the follow-up questions. */
  private review(run: Run, stored: StoredProject) {
    const projectId = run.projectId;
    const L = (ms: number, fn: () => void) => this.later(run, ms, fn);
    L(200, () => this.act(run, 'supervisor', 'reviewing', 1));
    L(1100, () => {
      this.gw('tools/call **data-tools___coverage_save** · 第 1 輪');
      stored.coverage = mockCoverage(projectId, 1);
      this.emit(projectId, 'coverage.updated', clone(stored.coverage));
    });
    L(1300, () => this.log('note', `review：1 個矛盾（F3 ↔ F5）、2 個缺口，追加 ${MOCK_FOLLOWUPS.length} 個子題`));
    L(1500, () => this.act(run, 'supervisor', 'planning', 2));
    L(1900, () => this.gw(`tools/call **data-tools___plan_save** · 第 2 輪 · 共 ${MOCK_SUBS.length + MOCK_FOLLOWUPS.length} 個子題`));
    L(2000, () => {
      run.round = 2;
      for (const s of MOCK_FOLLOWUPS) run.open.add(s.n);
      stored.plan = [...stored.plan, ...MOCK_FOLLOWUPS.map((s) => toQuestion(projectId, s))];
      this.emit(projectId, 'plan.ready', { subQuestions: stored.plan });
      this.act(run, 'supervisor', 'waiting', 2, `等待 ${MOCK_FOLLOWUPS.length} 個 sub-agent`);
      const base = run.nowMs;
      MOCK_FOLLOWUPS.forEach((sub, j) => this.scheduleSubAgent(run, stored, sub, base, 80 + j * 70, 400 + j * 230, sub.at, false));
    });
  }

  /** Report streamed as synthesis.delta, then synthesis.ready and project.completed. */
  private report(run: Run, stored: StoredProject) {
    const L = (ms: number, fn: () => void) => this.later(run, ms, fn);
    const chunks = chunkText(MOCK_SYNTHESIS.report, DELTA_CHARS);
    const start = 600;
    L(150, () => this.act(run, 'supervisor', 'reviewing', 2));
    L(300, () => {
      this.gw('tools/call **data-tools___coverage_save** · 第 2 輪');
      stored.coverage = mockCoverage(run.projectId, 2);
      this.emit(run.projectId, 'coverage.updated', clone(stored.coverage));
    });
    L(start - 100, () => this.act(run, 'supervisor', 'reporting', 2));
    chunks.forEach((text, seq) => L(start + seq * DELTA_MS, () => this.emit(run.projectId, 'synthesis.delta', { seq, text })));
    const end = start + chunks.length * DELTA_MS;
    L(end + 100, () => this.act(run, 'supervisor', 'verifying', 2));
    L(end + 500, () => this.gw('tools/call **web-tools___url_check** · 檢查報告引用的連結'));
    L(end + 700, () => this.gw(`tools/call **data-tools___synthesis_write** · ${Array.from(MOCK_SYNTHESIS.report).length} 字 · 查核結果`));
    L(end + 820, () => {
      stored.synthesis = buildSynthesis(run.projectId, new Date().toISOString());
      this.emit(run.projectId, 'synthesis.ready', { synthesis: stored.synthesis });
      this.act(run, 'supervisor', 'done', 2);
    });
    L(end + 1120, () => {
      run.completing = true;
      this.gw('tools/call **project-tools___project_save** · graph.json 快照');
    });
    L(end + 1280, () => {
      const elapsedSec = Math.round(((performance.now() - run.t0) * run.speed) / 100) / 10;
      const stats = { findings: stored.findings.length, edges: run.edges, uiReady: run.uiReady, elapsedSec, sources: stored.docs.length, claims: claimCount(stored.findings) };
      stored.project = { ...stored.project, status: 'completed', updatedAt: new Date().toISOString(), findingCount: stored.findings.length, stats };
      this.emit(run.projectId, 'project.completed', { stats });
      this.run = null;
    });
  }
}
