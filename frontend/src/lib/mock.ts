/*
 * Mock transport: runs the whole backend in the browser. Emits the same event objects as the
 * contracts (as JSON, parsed by the same parser as live) on the prototype's timing, and mocks
 * project-tools and the data-tools the web app calls in memory. No AWS calls.
 *
 * Runtime actions (contracts/events.md):
 * - plan: the project becomes a draft and a plan is proposed for review (plan.proposed).
 * - start: plan (or the plan the user approved) → 5 sub-agents in parallel (one stalls once and
 *   recovers; every page read is a source.added) → review (coverage.updated) → round 2 with 2
 *   follow-up questions (one carries the user's redirection, if any) → coverage.updated → report
 *   streamed as synthesis.delta → verifying → synthesis.ready → project.completed.
 *   With mode "incremental": version + 1, every sub-question re-researched for newer data, one claim
 *   superseded (claims.updated), the next report version.
 * - ask: a follow-up answer (qa.ready). stop: ends the simulation (project_stop sends project.stopped).
 * agent.activity for every step, agent.heartbeat every 2 s.
 */
import type {
  AgentPhase,
  Brief,
  Coverage,
  DataShape,
  Edge,
  Entity,
  Finding,
  Project,
  ProjectGetResult,
  ProposedPlan,
  QA,
  ReportVersion,
  Requirement,
  ResearchEvent,
  ResearchEventType,
  SourceDoc,
  Steer,
  SubQuestion,
  Synthesis,
  UiSpecRecord,
} from '../types';
import { parseEvent } from './events';
import { newProjectId, randomHex } from './ids';
import {
  MOCK_FOLLOWUPS,
  MOCK_REQUIREMENTS,
  MOCK_SUBS,
  MOCK_TOPIC,
  buildFinding,
  buildSynthesis,
  buildSynthesisVersion,
  buildUpdateFinding,
  chunkText,
  findingIdFor,
  generatedSpec,
  mockAnswer,
  mockCoverage,
  mockDocs,
  relationEdges,
  updateDocs,
  type MockSub,
} from './mockData';
import { specProblem } from './spec';
import { wireToolName, type LogFn, type RuntimeAction, type RuntimeReply, type StartResearchArgs, type Transport } from './transport';

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
  proposal: ProposedPlan | null;
  steering: Steer[];
  qa: QA[];
  history: ReportVersion[];
}

function addDocs(into: SourceDoc[], list: SourceDoc[]): SourceDoc[] {
  const fresh = list.filter((d) => !into.some((x) => x.docId === d.docId));
  into.push(...fresh);
  return fresh;
}

function claimCount(findings: Finding[]): number {
  return findings.reduce((n, f) => n + (f.claims?.filter((c) => c.status !== 'superseded').length ?? 0), 0);
}

const SEEDED_ID = 'p-20261022-a1b2c3d4';
const SEEDED_RETAIL_ID = 'p-20260815-c7e9f0a2';
const SEEDED_DRAFT_ID = 'p-20261023-d4e5f6a7';
const CLEANUP_STEP_MS = 420;
const CLEANUP_STEPS = 6;
/** All timings below are 1× milliseconds; the 1×/2× toggle divides them. */
const HEARTBEAT_MS = 2000;
const DELTA_MS = 120;
const DELTA_CHARS = 40;
const PLAN_MS = 1400;
const ANSWER_MS = 1500;
const SHAPED: ReadonlySet<DataShape> = new Set<DataShape>(['comparison', 'timeline', 'metrics']);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toQuestion(projectId: string, s: MockSub): SubQuestion {
  return { findingId: findingIdFor(projectId, s.n), question: s.question, dataShape: s.dataShape, round: s.round };
}

function planFor(projectId: string, subs: MockSub[] = MOCK_SUBS, withFollowUps = false): SubQuestion[] {
  return [...subs, ...(withFollowUps ? MOCK_FOLLOWUPS : [])].map((s) => toQuestion(projectId, s));
}

function mergeEntities(into: Entity[], list: Entity[]) {
  for (const e of list) if (!into.some((x) => x.id === e.id)) into.push(e);
}

/** Mock F5 deliberately goes through uigen and fails; other list/other findings get no sub-UI (as in the contract). */
function getsSubUi(sub: MockSub): boolean {
  return SHAPED.has(sub.dataShape) || !!sub.failReason;
}

function emptyStored(project: Project): StoredProject {
  return { project, plan: [], findings: [], uiSpecs: [], entities: [], edges: [], synthesis: null, requirements: [], docs: [], coverage: null, proposal: null, steering: [], qa: [], history: [] };
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
  const stored = emptyStored({
    projectId,
    topic: MOCK_TOPIC,
    status: 'completed',
    parentProjectId: null,
    createdAt: '2026-10-22T06:12:03.000Z',
    updatedAt: '2026-10-22T06:12:21.000Z',
    completedAt: '2026-10-22T06:12:21.000Z',
    findingCount: findings.length,
    version: 1,
    brief: { depth: 'standard', audience: '管理層決策', startDate: '2023-10-22' },
    stats: { findings: findings.length, edges: edges.length, uiReady, elapsedSec: 17.6, sources: docs.length, claims: claimCount(findings) },
  });
  return {
    ...stored,
    plan: planFor(projectId, MOCK_SUBS, true),
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
  return emptyStored({
    projectId: SEEDED_RETAIL_ID,
    topic: '零售業 AI 需求預測的導入方式',
    status: 'completed',
    parentProjectId: null,
    createdAt: '2026-08-15T02:40:11.000Z',
    updatedAt: '2026-08-15T02:40:24.000Z',
    completedAt: '2026-08-15T02:40:24.000Z',
    findingCount: 6,
    version: 1,
    stats: { findings: 6, edges: 21, uiReady: 5, elapsedSec: 12.4, sources: 31, claims: 44 },
  });
}

function seededDraft(): StoredProject {
  const projectId = SEEDED_DRAFT_ID;
  const brief: Brief = { depth: 'quick', audience: '客戶提案', startDate: '2025-10-23' };
  const stored = emptyStored({
    projectId,
    topic: '金融業 AI 客服的法規要求',
    status: 'draft',
    parentProjectId: null,
    createdAt: '2026-10-23T09:30:00.000Z',
    updatedAt: '2026-10-23T09:31:00.000Z',
    findingCount: 0,
    version: 1,
    brief,
  });
  stored.proposal = {
    subQuestions: [
      { findingId: 'f-d4e5f6a7-1', question: '金管會對 AI 客服的規範有哪些？', dataShape: 'list' },
      { findingId: 'f-d4e5f6a7-2', question: '銀行導入 AI 客服的時程與案例', dataShape: 'timeline' },
      { findingId: 'f-d4e5f6a7-3', question: '個資與紀錄保存的要求比較', dataShape: 'comparison' },
    ],
    requirements: [
      { id: 'q1', text: '主管機關的規範與指引' },
      { id: 'q2', text: '個資與紀錄保存' },
      { id: 'q3', text: '已上線的案例' },
    ],
    brief,
    by: 'user',
    updatedAt: '2026-10-23T09:31:00.000Z',
  };
  return stored;
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
  round: number;
  uiReady: number;
  edges: number;
  written: Finding[];
  agents: Map<string, AgentTrack>;
  completing: boolean;
  /** Round-1 sub-questions (the user's approved plan, mapped onto the mock content). */
  subs: MockSub[];
  /** The user asked to wrap up: no further rounds. */
  finish: boolean;
  /** Incremental runs: the version being written and the date it searches from. */
  version: number;
  since: string | null;
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
    for (const p of [seededProject(), seededRetail(), seededDraft()]) this.store.set(p.project.projectId, p);
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
    await this.invoke('start', { projectId: args.projectId, topic: args.topic, parentProjectId: args.parentProjectId });
  }

  async invoke(action: RuntimeAction, payload: Record<string, unknown>): Promise<RuntimeReply> {
    const projectId = String(payload.projectId ?? '');
    this.gw(`POST **research**/invocations · ${action} · ${projectId}`);
    await wait(60);
    const topic = typeof payload.topic === 'string' && payload.topic.trim() ? payload.topic.trim() : MOCK_TOPIC;
    const parentId = typeof payload.parentProjectId === 'string' ? payload.parentProjectId : null;
    switch (action) {
      case 'plan':
        this.proposePlan(projectId, topic, parentId, briefOf(payload));
        return { projectId, status: 'accepted' };
      case 'start': {
        if (this.run && !this.run.completing) throw new Error('已有研究正在進行');
        if (payload.mode === 'incremental') {
          const extra = Array.isArray(payload.extraQuestions) ? payload.extraQuestions.filter((q): q is string => typeof q === 'string') : [];
          this.startIncremental(projectId, extra);
          return { projectId, status: 'accepted' };
        }
        const parent = parentId ? this.store.get(parentId) : undefined;
        if (parentId && !parent) throw new Error('找不到 parent 專案 ' + parentId);
        this.startRun(projectId, topic, parent ?? null, approvedPlan(payload.plan), briefOf(payload));
        return { projectId, status: 'accepted' };
      }
      case 'ask':
        this.answer(projectId, String(payload.qaId ?? ''), String(payload.question ?? ''), typeof payload.selection === 'string' ? payload.selection : undefined);
        return { projectId, status: 'accepted' };
      case 'stop':
        return { projectId, status: this.stopRun(projectId) ? 'stopping' : 'not_running' };
      default:
        throw new Error('Unsupported action ' + action);
    }
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
      case 'project_stop':
        return this.projectStop(String(args.projectId ?? ''));
      case 'project_steer':
        return this.steer(String(args.projectId ?? ''), args.kind, typeof args.text === 'string' ? args.text : '');
      case 'project_notify':
        return this.notify(String(args.projectId ?? ''), args.enabled === true);
      case 'plan_propose':
        return this.saveProposal(args);
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
      proposedPlan: p.project.status === 'draft' ? p.proposal : null,
      steering: p.steering,
      qa: p.qa,
      history: p.history,
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

  private projectStop(projectId: string) {
    const p = this.store.get(projectId);
    if (!p) throw new Error('找不到專案 ' + projectId);
    if (p.project.status !== 'running') return clone({ project: p.project, stopped: false, runtimeSessionId: null });
    const stats = { findings: p.findings.length, edges: p.edges.length, uiReady: p.uiSpecs.filter((u) => u.status === 'ready').length, elapsedSec: 0, sources: p.docs.length, claims: claimCount(p.findings) };
    p.project = { ...p.project, status: 'stopped', stoppedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stats };
    this.emit(projectId, 'project.stopped', { stats });
    return clone({ project: p.project, stopped: true, runtimeSessionId: 'mock-session-' + projectId });
  }

  private steer(projectId: string, kind: unknown, text: string) {
    const p = this.store.get(projectId);
    if (!p || p.project.status !== 'running') throw new Error('只有研究中的專案可以改方向');
    if (kind !== 'redirect' && kind !== 'finish') throw new Error('kind 不正確');
    if (kind === 'redirect' && text.trim().length < 3) throw new Error('請寫下新的方向（至少 3 個字）');
    if (p.steering.length >= 10) throw new Error('每次研究最多 10 個方向');
    const steer: Steer = { steerId: 's-' + randomHex(10), kind, text: text.trim(), createdAt: new Date().toISOString() };
    p.steering.push(steer);
    this.emit(projectId, 'steer.received', { steer: clone(steer) });
    if (kind === 'finish' && this.run?.projectId === projectId) this.run.finish = true;
    return clone({ steer });
  }

  private notify(projectId: string, enabled: boolean) {
    const p = this.store.get(projectId);
    if (!p) throw new Error('找不到專案 ' + projectId);
    p.project = { ...p.project, notify: enabled };
    return { notify: enabled, available: true };
  }

  private saveProposal(args: Record<string, unknown>) {
    const projectId = String(args.projectId ?? '');
    const p = this.store.get(projectId);
    if (!p || p.project.status !== 'draft') throw new Error('只有草稿可以修改計畫');
    const subs = Array.isArray(args.subQuestions) ? (args.subQuestions as SubQuestion[]) : [];
    if (!subs.length || subs.length > 12) throw new Error('子題需要 1 到 12 個');
    const brief = typeof args.brief === 'object' && args.brief ? (args.brief as Brief) : p.project.brief;
    p.proposal = { subQuestions: clone(subs), requirements: clone((args.requirements as Requirement[]) ?? []), brief, by: 'user', updatedAt: new Date().toISOString() };
    if (typeof args.topic === 'string') p.project = { ...p.project, topic: args.topic };
    p.project = { ...p.project, brief, updatedAt: new Date().toISOString() };
    this.emit(projectId, 'plan.proposed', clone(p.proposal));
    return { count: subs.length };
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

  /* ---------- plan review ---------- */

  private proposePlan(projectId: string, topic: string, parentId: string | null, brief: Brief) {
    let stored = this.store.get(projectId);
    if (stored && stored.project.status !== 'draft') throw new Error('只有新專案或草稿可以擬定計畫');
    const fresh = !stored;
    if (!stored) {
      stored = emptyStored({ projectId, topic, status: 'draft', parentProjectId: parentId, createdAt: new Date().toISOString(), findingCount: 0, version: 1, brief });
      this.store.set(projectId, stored);
    } else {
      stored.project = { ...stored.project, topic, brief };
    }
    const target = stored;
    const speed = this.speed();
    if (fresh) this.timer(200 / speed, () => this.emit(projectId, 'project.created', { topic, parentProjectId: parentId, status: 'draft' }));
    this.timer(260 / speed, () => this.emit(projectId, 'agent.activity', { agentId: 'supervisor', phase: 'planning', round: 1 }));
    this.timer(PLAN_MS / speed, () => {
      if (/失敗|fail/i.test(topic)) {
        this.emit(projectId, 'agent.activity', { agentId: 'supervisor', phase: 'failed', round: 1, detail: '模擬的規劃失敗' });
        this.emit(projectId, 'plan.failed', { message: '模型暫時無法回應（模擬的失敗，主題含「失敗」時會出現）' });
        return;
      }
      this.gw('tools/call **data-tools___plan_propose** · ' + MOCK_SUBS.length + ' 個子題');
      const depthSubs = brief.depth === 'quick' ? MOCK_SUBS.slice(0, 3) : MOCK_SUBS;
      target.proposal = {
        subQuestions: depthSubs.map((s) => ({ findingId: findingIdFor(projectId, s.n), question: s.question, dataShape: s.dataShape })),
        requirements: clone(MOCK_REQUIREMENTS),
        brief,
        by: 'agent',
        updatedAt: new Date().toISOString(),
      };
      this.emit(projectId, 'plan.proposed', clone(target.proposal));
      this.emit(projectId, 'agent.activity', { agentId: 'supervisor', phase: 'done', round: 1 });
    });
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

  private newRun(projectId: string, subs: MockSub[], version = 1, since: string | null = null): Run {
    const run: Run = {
      projectId,
      token: ++this.runSeq,
      t0: performance.now(),
      speed: this.speed(),
      nowMs: 0,
      open: new Set(subs.map((s) => s.n)),
      round: 1,
      uiReady: 0,
      edges: 0,
      written: [],
      agents: new Map(),
      completing: false,
      subs,
      finish: false,
      version,
      since,
    };
    this.run = run;
    return run;
  }

  /** The user's stop (after project_stop): the simulation ends where it is. */
  private stopRun(projectId: string): boolean {
    const run = this.run;
    if (!run || run.projectId !== projectId) return false;
    for (const [agentId, a] of run.agents) {
      if (a.phase !== 'done' && a.phase !== 'failed') this.emit(projectId, 'agent.activity', { agentId, phase: 'done', round: run.round, detail: '已停止' });
    }
    this.run = null;
    return true;
  }

  private startRun(projectId: string, topic: string, parent: StoredProject | null, plan: { subs: MockSub[]; requirements: Requirement[] } | null, brief: Brief) {
    const draft = this.store.get(projectId);
    if (draft && draft.project.status !== 'draft') throw new Error('專案已經開始過了');
    const subs = plan?.subs ?? MOCK_SUBS;
    const run = this.newRun(projectId, subs);
    const parentId = parent?.project.projectId ?? null;
    const stored: StoredProject = draft ?? emptyStored({ projectId, topic, status: 'running', parentProjectId: parentId, createdAt: new Date().toISOString(), findingCount: 0, version: 1, brief });
    const L = (ms: number, fn: () => void) => this.later(run, ms, fn);

    L(150, () => {
      this.gw('tools/call **project-tools___project_save** · ' + (draft ? '草稿開始研究' : '建立 manifest.json'));
      stored.project = { ...stored.project, topic, status: 'running', brief, updatedAt: new Date().toISOString() };
      stored.proposal = null;
      this.store.set(projectId, stored);
    });
    if (draft) L(260, () => this.emit(projectId, 'project.started', { version: 1, mode: 'full', since: null }));
    else L(260, () => this.emit(projectId, 'project.created', { topic, parentProjectId: parentId, status: 'running' }));
    L(400, () => this.heartbeat(run, stored));
    let planAt = 1000;
    if (plan) {
      planAt = 500; // the approved plan is researched as is
      L(300, () => this.log('note', `依你核准的計畫研究：${subs.length} 個子題`));
    } else {
      L(300, () => this.act(run, 'supervisor', 'planning', 1));
      if (parent) {
        L(420, () => this.gw(`tools/call **project-tools___project_get** · 讀取 ${parent.project.projectId}`));
        L(560, () => this.log('note', `seed：帶入 ${parent.project.projectId} 的 ${parent.findings.length || parent.project.findingCount || 0} 筆 findings 摘要`));
      }
      L(640, () => this.act(run, 'supervisor', 'thinking', 1));
    }
    L(planAt - 100, () => this.gw('tools/call **data-tools___plan_save** · ' + subs.length + ' 個子題'));
    L(planAt, () => {
      stored.plan = planFor(projectId, subs);
      stored.requirements = plan ? clone(plan.requirements) : clone(MOCK_REQUIREMENTS);
      this.emit(projectId, 'plan.ready', { subQuestions: stored.plan, requirements: stored.requirements });
    });
    L(planAt + 60, () => this.act(run, 'supervisor', 'waiting', 1, `等待 ${subs.length} 個 sub-agent`));

    const timed = subs.map((sub) => ({ sub, at: sub.at * (parent ? 0.85 + Math.random() * 0.25 : 1) - (1000 - planAt) }));
    // One sub-agent goes quiet once: the watchdog cancels it and it recovers (the latest one without a sub-UI failure).
    const stallN = timed.filter((x) => !x.sub.failReason).sort((a, b) => b.at - a.at)[0]?.sub.n;
    timed.forEach(({ sub, at }, i) => this.scheduleSubAgent(run, stored, sub, 0, planAt + 80 + i * 70, planAt + 500 + i * 230, at, sub.n === stallN));
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
    if (run.round === 1 && !run.finish) this.review(run, stored);
    else this.report(run, stored);
  }

  /** Supervisor review of round 1, then round 2 for the follow-up questions (one carries the user's redirection). */
  private review(run: Run, stored: StoredProject) {
    const projectId = run.projectId;
    const L = (ms: number, fn: () => void) => this.later(run, ms, fn);
    L(200, () => this.act(run, 'supervisor', 'reviewing', 1));
    L(1100, () => {
      this.gw('tools/call **data-tools___coverage_save** · 第 1 輪');
      stored.coverage = coverageFor(projectId, 1, stored.requirements);
      this.emit(projectId, 'coverage.updated', clone(stored.coverage));
    });
    L(1300, () => this.log('note', `review：1 個矛盾（F3 ↔ F5）、2 個缺口，追加 ${MOCK_FOLLOWUPS.length} 個子題`));
    L(1500, () => {
      if (run.finish) return this.report(run, stored); // asked to wrap up during the review
      this.act(run, 'supervisor', 'planning', 2);
    });
    L(1900, () => {
      if (run.finish) return;
      this.gw(`tools/call **data-tools___plan_save** · 第 2 輪 · 共 ${run.subs.length + MOCK_FOLLOWUPS.length} 個子題`);
    });
    L(2000, () => {
      if (run.finish) return;
      run.round = 2;
      const redirects = stored.steering.filter((s) => s.kind === 'redirect' && s.appliedRound === undefined);
      const follow = MOCK_FOLLOWUPS.map((s, i) => (i === 0 && redirects.length ? { ...s, question: `依你的新方向：${redirects[redirects.length - 1].text}` } : s));
      for (const s of follow) run.open.add(s.n);
      for (const r of redirects) r.appliedRound = 2;
      stored.plan = [...stored.plan, ...follow.map((s) => toQuestion(projectId, s))];
      const data: { subQuestions: SubQuestion[]; steerIds?: string[] } = { subQuestions: stored.plan };
      if (redirects.length) data.steerIds = redirects.map((r) => r.steerId);
      this.emit(projectId, 'plan.ready', data);
      this.act(run, 'supervisor', 'waiting', 2, `等待 ${follow.length} 個 sub-agent`);
      const base = run.nowMs;
      follow.forEach((sub, j) => this.scheduleSubAgent(run, stored, sub, base, 80 + j * 70, 400 + j * 230, sub.at, false));
    });
  }

  /** Report streamed as synthesis.delta, then synthesis.ready and project.completed. */
  private report(run: Run, stored: StoredProject, synthesis?: () => Synthesis) {
    const L = (ms: number, fn: () => void) => this.later(run, ms, fn);
    const draft = synthesis ?? (() => buildSynthesis(run.projectId, new Date().toISOString()));
    const text = draft().report;
    const chunks = chunkText(text, DELTA_CHARS);
    const start = 600;
    L(150, () => this.act(run, 'supervisor', 'reviewing', run.round));
    L(300, () => {
      this.gw(`tools/call **data-tools___coverage_save** · 第 ${run.round} 輪`);
      stored.coverage = coverageFor(run.projectId, 2, stored.requirements);
      this.emit(run.projectId, 'coverage.updated', clone(stored.coverage));
    });
    L(start - 100, () => this.act(run, 'supervisor', 'reporting', run.round));
    chunks.forEach((t, seq) => L(start + seq * DELTA_MS, () => this.emit(run.projectId, 'synthesis.delta', { seq, text: t })));
    const end = start + chunks.length * DELTA_MS;
    L(end + 100, () => this.act(run, 'supervisor', 'verifying', run.round));
    L(end + 500, () => this.gw('tools/call **web-tools___url_check** · 檢查報告引用的連結'));
    L(end + 700, () => this.gw(`tools/call **data-tools___synthesis_write** · ${Array.from(text).length} 字 · 查核結果`));
    L(end + 820, () => {
      if (stored.synthesis && (stored.synthesis.version ?? 1) !== run.version) {
        stored.history.push({ version: stored.synthesis.version ?? 1, createdAt: stored.synthesis.createdAt, report: stored.synthesis.report });
      }
      stored.synthesis = { ...draft(), createdAt: new Date().toISOString(), version: run.version };
      this.emit(run.projectId, 'synthesis.ready', { synthesis: stored.synthesis });
      this.act(run, 'supervisor', 'done', run.round);
    });
    L(end + 1120, () => {
      run.completing = true;
      this.gw('tools/call **project-tools___project_save** · graph.json 快照');
    });
    L(end + 1280, () => {
      const elapsedSec = Math.round(((performance.now() - run.t0) * run.speed) / 100) / 10;
      const stats = { findings: stored.findings.length, edges: run.edges, uiReady: run.uiReady, elapsedSec, sources: stored.docs.length, claims: claimCount(stored.findings) };
      const now = new Date().toISOString();
      stored.project = { ...stored.project, status: 'completed', updatedAt: now, completedAt: now, findingCount: stored.findings.length, stats, version: run.version };
      this.emit(run.projectId, 'project.completed', { stats });
      if (stored.project.notify) this.log('note', '（模擬）已寄出研究完成的 email 通知');
      this.run = null;
    });
  }

  /* ---------- incremental runs ---------- */

  private startIncremental(projectId: string, extra: string[]) {
    const stored = this.store.get(projectId);
    if (!stored || stored.project.status !== 'completed') throw new Error('只有已完成的專案可以增量重跑');
    const version = (stored.project.version ?? 1) + 1;
    const since = (stored.project.completedAt ?? stored.project.updatedAt ?? new Date().toISOString()).slice(0, 10);
    const originals = stored.plan.filter((q) => (q.version ?? 1) === 1).slice(0, 7);
    const base = stored.plan.length;
    const pairs = originals.map((q, i) => {
      const n = Number(q.findingId.split('-').pop());
      const sub = [...MOCK_SUBS, ...MOCK_FOLLOWUPS].find((s) => s.n === n) ?? MOCK_SUBS[i % MOCK_SUBS.length];
      return { orig: q, sub: { ...sub, question: q.question }, newN: base + i + 1 };
    });
    const extraSubs = extra.slice(0, 2).map((question, i) => ({ question, newN: base + pairs.length + i + 1 }));
    const run = this.newRun(projectId, pairs.map((p) => ({ ...p.sub, n: p.newN, round: 1 as const })), version, since);
    const L = (ms: number, fn: () => void) => this.later(run, ms, fn);
    stored.project = { ...stored.project, status: 'running', version, since, updatedAt: new Date().toISOString() };
    L(150, () => this.emit(projectId, 'project.started', { version, mode: 'incremental', since }));
    L(300, () => this.heartbeat(run, stored));
    L(400, () => this.act(run, 'supervisor', 'planning', 1, `第 ${version} 版：只找 ${since} 之後的資料`));
    L(900, () => {
      stored.plan = [
        ...stored.plan,
        ...pairs.map((p) => ({ findingId: findingIdFor(projectId, p.newN), question: p.orig.question, dataShape: 'list' as DataShape, round: 1, version, updates: p.orig.findingId })),
        ...extraSubs.map((x) => ({ findingId: findingIdFor(projectId, x.newN), question: x.question, dataShape: 'list' as DataShape, round: 1, version })),
      ];
      this.emit(projectId, 'plan.ready', { subQuestions: stored.plan });
      this.act(run, 'supervisor', 'waiting', 1, `等待 ${pairs.length + extraSubs.length} 個 sub-agent`);
    });
    const newIds: string[] = [];
    const replaced: Record<string, string> = {};
    const docs = updateDocs(since);
    const all = [...pairs.map((p) => ({ id: findingIdFor(projectId, p.newN), p })), ...extraSubs.map((x) => ({ id: findingIdFor(projectId, x.newN), x }))];
    run.open = new Set(all.map((_, i) => i));
    all.forEach((item, i) => {
      const t0 = 1100 + i * 260;
      L(t0, () => this.act(run, item.id, 'searching', 1, `${'p' in item ? item.p.orig.question : item.x.question} ${since} 之後`));
      L(t0 + 500, () => {
        if ('p' in item) {
          const hasNew = docs.find((d) => d.url.includes(item.p.sub.n === 1 ? 'survey-2026' : 'impact-2026'));
          if (hasNew && [1, 3].includes(item.p.sub.n)) {
            this.act(run, item.id, 'reading', 1, hasNew.url);
            this.addSources(run, stored, [hasNew]);
          }
        }
      });
      L(t0 + 1100, () => {
        let f: Finding;
        if ('p' in item) {
          f = buildUpdateFinding(projectId, item.p.sub, item.p.newN, since);
        } else {
          f = { findingId: item.id, projectId, question: item.x.question, summary: '這個問題目前沒有找到可信的公開資料。（模擬）', keyPoints: [], entities: [], sources: [], dataShape: 'list', data: {}, confidence: 0.3, claims: [] };
        }
        stored.findings.push(f);
        stored.project = { ...stored.project, findingCount: stored.findings.length };
        this.emit(projectId, 'finding.ready', { finding: clone(f) });
        const superseded: { claimId: string; findingId: string; supersededBy: string }[] = [];
        for (const c of f.claims ?? []) {
          newIds.push(c.claimId);
          if (!c.updates) continue;
          for (const old of stored.findings) {
            const target = old.claims?.find((x) => x.claimId === c.updates);
            if (!target) continue;
            target.status = 'superseded';
            target.supersededBy = c.claimId;
            replaced[target.claimId] = c.claimId;
            superseded.push({ claimId: target.claimId, findingId: old.findingId, supersededBy: c.claimId });
          }
        }
        if (superseded.length) this.emit(projectId, 'claims.updated', { superseded });
        this.act(run, item.id, 'done', 1, f.claims?.length ? undefined : '沒有新資料');
        run.open.delete(i);
        if (!run.open.size) this.report(run, stored, () => buildSynthesisVersion(projectId, version, new Date().toISOString(), newIds, replaced));
      });
    });
  }

  /* ---------- follow-up questions ---------- */

  private answer(projectId: string, qaId: string, question: string, selection?: string) {
    const stored = this.store.get(projectId);
    if (!stored) throw new Error('找不到專案 ' + projectId);
    if (!stored.synthesis) throw new Error('這個專案還沒有報告');
    const speed = this.speed();
    this.timer(300 / speed, () => this.emit(projectId, 'agent.activity', { agentId: 'answer', phase: 'thinking', round: 1 }));
    this.timer(ANSWER_MS / speed, () => {
      const a = mockAnswer(question, stored.synthesis);
      const qa: QA = { qaId, question, answer: a.answer, citations: a.citations, needsResearch: a.needsResearch, createdAt: new Date().toISOString() };
      if (selection) qa.selection = selection;
      if (a.researchQuestion) qa.researchQuestion = a.researchQuestion;
      stored.qa = [...stored.qa.filter((x) => x.qaId !== qaId), qa];
      this.emit(projectId, 'qa.ready', { qa: clone(qa) });
      this.emit(projectId, 'agent.activity', { agentId: 'answer', phase: 'done', round: 1 });
    });
  }
}

/* ---------- helpers ---------- */

function briefOf(payload: Record<string, unknown>): Brief {
  const out: Brief = {};
  if (payload.depth === 'quick' || payload.depth === 'standard' || payload.depth === 'deep') out.depth = payload.depth;
  for (const key of ['audience', 'startDate', 'notes'] as const) if (typeof payload[key] === 'string' && payload[key]) out[key] = payload[key] as string;
  for (const key of ['includeDomains', 'excludeDomains'] as const) {
    if (Array.isArray(payload[key])) out[key] = (payload[key] as unknown[]).filter((d): d is string => typeof d === 'string');
  }
  return out;
}

/** The approved plan of a start call, mapped onto the mock's content (at most 5 sub-questions). */
function approvedPlan(raw: unknown): { subs: MockSub[]; requirements: Requirement[] } | null {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { subQuestions?: unknown }).subQuestions)) return null;
  const list = (raw as { subQuestions: { question?: unknown }[] }).subQuestions.filter((q) => typeof q?.question === 'string' && (q.question as string).trim().length >= 3);
  if (!list.length) return null;
  const subs = list.slice(0, MOCK_SUBS.length).map((q, i) => ({ ...MOCK_SUBS[i], question: (q.question as string).trim() }));
  const reqs = ((raw as { requirements?: unknown[] }).requirements ?? [])
    .map((r) => (typeof r === 'string' ? r : typeof r === 'object' && r && typeof (r as { text?: unknown }).text === 'string' ? (r as { text: string }).text : ''))
    .filter((t) => t.trim().length >= 3)
    .slice(0, 12)
    .map((text, i) => ({ id: `q${i + 1}`, text }));
  return { subs, requirements: reqs };
}

/** The mock's coverage, limited to the requirements the plan kept. */
function coverageFor(projectId: string, round: 1 | 2, requirements: Requirement[]): Coverage {
  const full = mockCoverage(projectId, round);
  const ids = new Set(requirements.map((r) => r.id));
  return { ...full, requirements: full.requirements.filter((c) => ids.has(c.id)) };
}

export const MOCK_IDS = { completed: SEEDED_ID, stale: SEEDED_RETAIL_ID, draft: SEEDED_DRAFT_ID };
