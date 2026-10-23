/*
 * Pure UI state. `reduce(state, event)` folds ResearchEvents (contracts/events.md) into UI state;
 * `hydrate(projectGetResult)` restores a saved project; `update(state, action)` adds the local UI
 * actions (log lines, view toggles, cleanup progress). No DOM, timers or randomness in here.
 * All times (`at`, `now`) are epoch milliseconds, so they compare with project.updatedAt.
 */
import { activityLabel } from './lib/activity';
import { specProblem } from './lib/spec';
import type {
  AgentPhase,
  CitationRef,
  Claim,
  Coverage,
  CoverageItem,
  CoverageStatus,
  DataShape,
  Edge,
  EdgeType,
  Entity,
  Finding,
  Project,
  ProjectGetResult,
  ProjectStats,
  ProjectStatus,
  Requirement,
  ResearchEvent,
  SourceDoc,
  StallAction,
  SubQuestion,
  Synthesis,
  UiSpec,
  UiSpecRecord,
  Verification,
} from './types';
import { AGENT_PHASES, DATA_SHAPES, SOURCE_TYPES } from './types';

export type LogKind = 'gw' | 'ev' | 'note';
export interface LogEntry {
  id: number;
  kind: LogKind;
  text: string; // plain text; **x** marks bold
  t: string; // clock label, "+1.23s" or "—"
}

export type FindingStatus = 'researching' | 'ready' | 'missing';
export type UiStatus = 'none' | 'generating' | 'ready' | 'failed';

export interface UiState {
  status: UiStatus;
  /** Valid UiSpec when status is 'ready'; may hold the rejected spec when 'failed'. */
  spec: unknown;
  reason: string | null;
  cache: boolean;
  /** ui.ready arrived while the user was hovering or focused inside the card. */
  pendingSwap: boolean;
}

export interface FindingSlot {
  findingId: string;
  question: string;
  dataShape: DataShape;
  status: FindingStatus;
  finding: Finding | null;
  ui: UiState;
  view: 'auto' | 'generic';
  /** Bumped whenever the body should play the swap-in animation. */
  anim: number;
  /** Plan round: 1, or 2 for follow-up questions added after the review. */
  round: number;
}

export interface AgentStall {
  action: StallAction;
  idleSec: number;
  /** Receive time of agent.stalled. */
  at: number;
  /** Publish time (event ts) of agent.stalled; only a later activity clears the stall. */
  ts: number;
}

/** Live status of one agent (`supervisor`, `f-1`, …), from agent.activity / agent.heartbeat / agent.stalled. */
export interface AgentLive {
  agentId: string;
  phase: AgentPhase;
  detail: string | null;
  /** Receive time of the latest agent.activity (or the start implied by a heartbeat's idleSec). */
  lastActivityAt: number;
  /** Publish time of the latest agent.activity, used to drop activities that arrive late. */
  ts: number;
  lastHeartbeatAt: number | null;
  /** idleSec reported by the latest heartbeat that listed this agent. */
  idleSec: number | null;
  round: number | null;
  stalled: AgentStall | null;
}

export interface LiveClock {
  /** Receive time of the latest agent.heartbeat in this page session. */
  lastHeartbeatAt: number | null;
  /** run.start time, when the run was started in this tab. */
  startedAt: number | null;
  /** When a project was restored with hydrate() (the moment this tab started listening). */
  hydratedAt: number | null;
}

export type SynthesisStatus = 'none' | 'streaming' | 'ready';
export interface SynthesisState {
  status: SynthesisStatus;
  /** Streamed text (contiguous seq prefix) or, once ready, the final report. */
  text: string;
  /** First seq of the stream (0, or 1 if the backend counts from 1); null until known. */
  start: number | null;
  /** Next seq to append. */
  next: number | null;
  /** Out-of-order chunks waiting for the gap before them to fill. */
  pending: Record<number, string>;
  contradictions: string[];
  gaps: string[];
  followUps: string[];
  createdAt: string | null;
  /** `C3` → the claim it cites; empty while streaming and for reports without verified claims. */
  citations: Record<string, CitationRef>;
  verification: Verification | null;
}

export interface GraphNode {
  id: string;
  kind: 'finding' | 'entity';
  label: string; // entity name; finding nodes are labelled at render time (F1, F2…)
}

export interface OpenProject extends Project {
  stats?: ProjectStats;
}

export type CleanupPhase = 'confirm' | 'running' | 'done' | 'error';
export interface CleanupState {
  phase: CleanupPhase;
  step: number; // index of the step in progress; CLEANUP_STEPS.length = all done
  error?: string;
}

export const CLEANUP_STEPS = [
  '停止 Runtime session',
  '匯出封存檔 archive/{id}.zip',
  '標記 S3 物件 status=archived',
  '設定 DynamoDB TTL',
  '刪除 S3 Vectors 向量',
  '發佈 project.archived',
] as const;

export interface ResearchState {
  project: OpenProject | null;
  notice: 'archived' | null;
  plan: SubQuestion[] | null;
  order: string[];
  slots: Record<string, FindingSlot>;
  entities: Record<string, Entity>;
  nodes: Record<string, GraphNode>;
  edges: Edge[];
  highlight: string | null; // entity id
  log: LogEntry[];
  logSeq: number;
  clock: { startedAt: number | null; scale: number; running: boolean };
  templates: DataShape[];
  projects: Project[];
  cleanup: Record<string, CleanupState>;
  agents: Record<string, AgentLive>;
  live: LiveClock;
  synthesis: SynthesisState;
  /** What the plan commits to answering (plan.ready / project_get). */
  requirements: Requirement[];
  /** Latest review of the requirements (coverage.updated / project_get). */
  coverage: Coverage | null;
  /** Project documents in arrival order, one per docId (source.added / project_get). */
  docs: SourceDoc[];
}

export const LOG_LIMIT = 200;

export function emptySynthesis(): SynthesisState {
  return {
    status: 'none',
    text: '',
    start: null,
    next: null,
    pending: {},
    contradictions: [],
    gaps: [],
    followUps: [],
    createdAt: null,
    citations: {},
    verification: null,
  };
}

function emptyLive(): LiveClock {
  return { lastHeartbeatAt: null, startedAt: null, hydratedAt: null };
}

export function initialState(): ResearchState {
  return {
    project: null,
    notice: null,
    plan: null,
    order: [],
    slots: {},
    entities: {},
    nodes: {},
    edges: [],
    highlight: null,
    log: [],
    logSeq: 0,
    clock: { startedAt: null, scale: 1, running: false },
    templates: [],
    projects: [],
    cleanup: {},
    agents: {},
    live: emptyLive(),
    synthesis: emptySynthesis(),
    requirements: [],
    coverage: null,
    docs: [],
  };
}

/* ---------------- helpers ---------------- */

const SYMMETRIC: ReadonlySet<EdgeType> = new Set<EdgeType>(['shares_entity', 'similar_to']);
/** dataShapes the backend designs a sub-UI for. */
export const SUB_UI_SHAPES: ReadonlySet<DataShape> = new Set<DataShape>(['comparison', 'timeline', 'metrics']);

export function edgeKey(e: Edge): string {
  if (SYMMETRIC.has(e.type)) {
    const [a, b] = e.from < e.to ? [e.from, e.to] : [e.to, e.from];
    return `${e.type}|${a}|${b}|${e.via ?? ''}`;
  }
  return `${e.type}|${e.from}|${e.to}|${e.via ?? ''}`;
}

function emptyUi(): UiState {
  return { status: 'none', spec: null, reason: null, cache: false, pendingSwap: false };
}

function newSlot(findingId: string, question: string, dataShape: DataShape, round = 1): FindingSlot {
  return { findingId, question, dataShape, status: 'researching', finding: null, ui: emptyUi(), view: 'auto', anim: 0, round };
}

function asShape(v: unknown): DataShape {
  return typeof v === 'string' && (DATA_SHAPES as readonly string[]).includes(v) ? (v as DataShape) : 'other';
}

function asPhase(v: unknown): AgentPhase {
  return typeof v === 'string' && (AGENT_PHASES as readonly string[]).includes(v) ? (v as AgentPhase) : 'thinking';
}

function asRound(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : null;
}

function nonNeg(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/** Parsed event ts, or NaN. */
function tsOf(ev: ResearchEvent): number {
  return Date.parse(ev.ts);
}

/** "F3", "Supervisor", or the raw id. */
export function agentLabel(state: Pick<ResearchState, 'order'>, agentId: string): string {
  return agentId === 'supervisor' ? 'Supervisor' : findingLabel(state, agentId);
}

export function findingLabel(state: Pick<ResearchState, 'order'>, findingId: string): string {
  const i = state.order.indexOf(findingId);
  return i >= 0 ? 'F' + (i + 1) : findingId;
}

function clockLabel(state: ResearchState, at: number): string {
  const c = state.clock;
  if (!c.running || c.startedAt == null) return '—';
  return '+' + (Math.max(0, (at - c.startedAt) * c.scale) / 1000).toFixed(2) + 's';
}

export function addLog(state: ResearchState, kind: LogKind, text: string, at: number): ResearchState {
  const entry: LogEntry = { id: state.logSeq + 1, kind, text, t: clockLabel(state, at) };
  return { ...state, logSeq: entry.id, log: [entry, ...state.log].slice(0, LOG_LIMIT) };
}

function withEntities(state: ResearchState, list: readonly Entity[] | undefined): ResearchState {
  if (!list || !list.length) return state;
  const entities = { ...state.entities };
  const nodes = { ...state.nodes };
  for (const e of list) {
    if (!e || typeof e.id !== 'string') continue;
    entities[e.id] = e;
    if (nodes[e.id]) nodes[e.id] = { ...nodes[e.id], label: e.name };
  }
  return { ...state, entities, nodes };
}

function ensureNode(nodes: Record<string, GraphNode>, entities: Record<string, Entity>, id: string): boolean {
  if (nodes[id]) return false;
  const kind = id.startsWith('f-') ? 'finding' : 'entity';
  nodes[id] = { id, kind, label: kind === 'entity' ? entities[id]?.name ?? id : '' };
  return true;
}

/** Adds edges (and their endpoint nodes), skipping duplicates. Returns the edges actually added. */
function withEdges(state: ResearchState, list: readonly Edge[] | undefined): { state: ResearchState; added: Edge[] } {
  if (!list || !list.length) return { state, added: [] };
  const seen = new Set(state.edges.map(edgeKey));
  const nodes = { ...state.nodes };
  const added: Edge[] = [];
  for (const e of list) {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string' || e.from === e.to) continue;
    const k = edgeKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    ensureNode(nodes, state.entities, e.from);
    ensureNode(nodes, state.entities, e.to);
    const clean: Edge = { from: e.from, to: e.to, type: e.type };
    if (e.via) clean.via = e.via;
    added.push(clean);
  }
  if (!added.length) return { state, added };
  return { state: { ...state, nodes, edges: [...state.edges, ...added] }, added };
}

function withFindingNode(state: ResearchState, findingId: string): ResearchState {
  if (state.nodes[findingId]) return state;
  const nodes = { ...state.nodes };
  ensureNode(nodes, state.entities, findingId);
  return { ...state, nodes };
}

function putSlot(state: ResearchState, slot: FindingSlot): ResearchState {
  const order = state.order.includes(slot.findingId) ? state.order : [...state.order, slot.findingId];
  return { ...state, order, slots: { ...state.slots, [slot.findingId]: slot } };
}

function upsertProject(list: Project[], p: Partial<Project> & { projectId: string }, prepend = true): Project[] {
  const i = list.findIndex((x) => x.projectId === p.projectId);
  if (i === -1) {
    const fresh: Project = { topic: '', status: 'running', ...p } as Project;
    return prepend ? [fresh, ...list] : [...list, fresh];
  }
  const copy = list.slice();
  copy[i] = { ...copy[i], ...p };
  return copy;
}

function addTemplate(list: DataShape[], shape: DataShape): DataShape[] {
  return list.includes(shape) ? list : [...list, shape];
}

/** Ends a run: stops spinners on slots that will never get more events. */
function settleSlots(slots: Record<string, FindingSlot>): Record<string, FindingSlot> {
  const out: Record<string, FindingSlot> = {};
  for (const [id, s] of Object.entries(slots)) {
    let next = s;
    if (s.status === 'researching') next = { ...next, status: 'missing' };
    if (s.ui.status === 'generating') next = { ...next, ui: { ...next.ui, status: 'none' } };
    out[id] = next;
  }
  return out;
}

function closeOpenProject(state: ResearchState): ResearchState {
  return {
    ...state,
    project: null,
    notice: 'archived',
    plan: null,
    order: [],
    slots: {},
    entities: {},
    nodes: {},
    edges: [],
    highlight: null,
    clock: { ...state.clock, running: false },
    agents: {},
    live: emptyLive(),
    synthesis: emptySynthesis(),
    requirements: [],
    coverage: null,
    docs: [],
  };
}

function finishProject(state: ResearchState, status: ProjectStatus, patch: Partial<OpenProject>): ResearchState {
  if (!state.project) return state;
  return {
    ...state,
    project: { ...state.project, ...patch, status },
    slots: settleSlots(state.slots),
    clock: { ...state.clock, running: false },
  };
}

/* ---------------- event reducer ---------------- */

export interface ReduceEnv {
  /** Event receive time in ms (defaults to the event's ts). */
  now?: number;
  /** True when the user is hovering or focused inside the card for this finding. */
  isBusy?: (findingId: string) => boolean;
}

function eventLogText(state: ResearchState, ev: ResearchEvent): string {
  const F = (id: string) => findingLabel(state, id);
  switch (ev.type) {
    case 'project.created':
      return `**project.created** · ${ev.projectId}`;
    case 'plan.ready':
      return `**plan.ready** · ${ev.data.subQuestions?.length ?? 0} 個子題`;
    case 'finding.ready':
      return `**finding.ready** · ${F(ev.data.finding?.findingId ?? '?')} · ${ev.data.finding?.dataShape ?? '?'}`;
    case 'ui.failed':
      return `**ui.failed** · ${F(ev.data.findingId)} · ${ev.data.reason}`;
    case 'project.completed':
      return `**project.completed** · ${ev.data.stats?.findings ?? state.order.length} findings · ${ev.data.stats?.edges ?? state.edges.length} 關聯`;
    case 'project.failed':
      return `**project.failed** · ${ev.data.message ?? ''}`;
    case 'project.archived':
      return `**project.archived** · ${ev.projectId}`;
    default:
      return `**${ev.type}**`;
  }
}

const REL_WORD: Partial<Record<EdgeType, string>> = { similar_to: '相似', contradicts: '矛盾', supports: '支持', causes: '導致' };

export function reduce(state: ResearchState, ev: ResearchEvent, env: ReduceEnv = {}): ResearchState {
  const at = env.now ?? (Date.parse(ev.ts) || 0);
  const isOpen = !!state.project && state.project.projectId === ev.projectId;

  // Events that only touch the saved-project list (any project id).
  if (ev.type === 'project.archived') {
    let s = addLog(state, 'ev', eventLogText(state, ev), at);
    const c = s.cleanup[ev.projectId];
    if (c && c.phase === 'running') {
      // The cleanup animation finishes the step list, then dispatches cleanup.remove.
      return { ...s, cleanup: { ...s.cleanup, [ev.projectId]: { phase: 'done', step: CLEANUP_STEPS.length } } };
    }
    if (c && c.phase === 'done') return s; // already confirmed; removal is scheduled
    s = { ...s, projects: s.projects.filter((p) => p.projectId !== ev.projectId) };
    const { [ev.projectId]: _drop, ...rest } = s.cleanup;
    s = { ...s, cleanup: rest };
    return isOpen && !s.clock.running ? closeOpenProject(s) : s;
  }

  if (!isOpen) {
    // Live progress for a project that is not open is noise; tool events still update the saved list.
    if (ev.type.startsWith('agent.') || ev.type === 'synthesis.delta') return state;
    let s = addLog(state, 'ev', eventLogText(state, ev), at);
    if (ev.type === 'project.created') {
      s = { ...s, projects: upsertProject(s.projects, { projectId: ev.projectId, topic: ev.data.topic, parentProjectId: ev.data.parentProjectId, status: 'running' }) };
    } else if (ev.type === 'project.completed') {
      s = { ...s, projects: upsertProject(s.projects, { projectId: ev.projectId, status: 'completed', findingCount: ev.data.stats?.findings, stats: ev.data.stats }, false) };
    } else if (ev.type === 'project.failed') {
      s = { ...s, projects: upsertProject(s.projects, { projectId: ev.projectId, status: 'failed', message: ev.data.message }, false) };
    }
    return s;
  }

  switch (ev.type) {
    case 'project.created': {
      const s = addLog(state, 'ev', eventLogText(state, ev), at);
      const project: OpenProject = { ...s.project!, topic: ev.data.topic || s.project!.topic, parentProjectId: ev.data.parentProjectId ?? null, status: 'running' };
      return {
        ...s,
        project,
        projects: upsertProject(s.projects, { projectId: ev.projectId, topic: project.topic, parentProjectId: project.parentProjectId, status: 'running', findingCount: 0 }),
      };
    }

    case 'plan.ready': {
      const subs = (Array.isArray(ev.data.subQuestions) ? ev.data.subQuestions : []).filter((q) => q && typeof q.findingId === 'string');
      // The contract re-sends the full plan for round 2; tolerate a partial one by keeping the earlier items first.
      const prevPlan = state.plan ?? [];
      const subIds = new Set(subs.map((q) => q.findingId));
      const prevIds = new Set(prevPlan.map((q) => q.findingId));
      const plan = prevPlan.every((q) => subIds.has(q.findingId))
        ? subs
        : [...prevPlan.map((q) => subs.find((x) => x.findingId === q.findingId) ?? q), ...subs.filter((q) => !prevIds.has(q.findingId))];
      const known = new Set(state.order);
      const slots = { ...state.slots };
      for (const q of plan) {
        const prev = slots[q.findingId];
        const round = asRound(q.round) ?? prev?.round ?? 1;
        if (!prev) slots[q.findingId] = newSlot(q.findingId, q.question, asShape(q.dataShape), round);
        else if (prev.finding) slots[q.findingId] = prev.round === round ? prev : { ...prev, round }; // never disturb a finished card
        else slots[q.findingId] = { ...prev, question: q.question || prev.question, dataShape: asShape(q.dataShape), round };
      }
      const order = [...plan.map((q) => q.findingId), ...state.order.filter((id) => !plan.some((q) => q.findingId === id))];
      const requirements = readRequirements(ev.data.requirements);
      const s: ResearchState = { ...state, plan, slots, order, requirements: requirements.length ? requirements : state.requirements };
      const added = plan.filter((q) => !known.has(q.findingId));
      const round = Math.max(1, ...plan.map((q) => asRound(q.round) ?? 1));
      const text =
        state.plan && round >= 2
          ? `**plan.ready** · 第 ${round} 輪 · 新增 ${added.length} 個子題（共 ${plan.length}）`
          : eventLogText(s, ev);
      return addLog(s, 'ev', text, at);
    }

    case 'finding.ready': {
      const f = ev.data.finding;
      if (!f || typeof f.findingId !== 'string') return addLog(state, 'note', '收到格式不正確的 finding.ready', at);
      const prev = state.slots[f.findingId] ?? newSlot(f.findingId, f.question, asShape(f.dataShape));
      let ui = prev.ui;
      // Only shaped findings get a sub-UI; list/other findings keep the generic card (see contracts/events.md).
      if (ui.status === 'none' && SUB_UI_SHAPES.has(asShape(f.dataShape))) ui = { ...ui, status: 'generating' };
      else if (ui.status === 'ready') {
        const problem = specProblem(ui.spec, f);
        if (problem) ui = { ...ui, status: 'failed', reason: problem, pendingSwap: false };
      }
      const slot: FindingSlot = {
        ...prev,
        question: f.question || prev.question,
        dataShape: asShape(f.dataShape),
        status: 'ready',
        finding: f,
        ui,
        anim: prev.anim + 1,
      };
      let s = putSlot(state, slot);
      s = withEntities(s, f.entities);
      s = withFindingNode(s, f.findingId);
      return addLog(s, 'ev', eventLogText(s, ev), at);
    }

    case 'relation.added': {
      let s = withEntities(state, ev.data.entities);
      const r = withEdges(s, ev.data.edges);
      s = r.state;
      const extra = r.added
        .filter((e) => REL_WORD[e.type] && e.from.startsWith('f-') && e.to.startsWith('f-'))
        .map((e) => REL_WORD[e.type] + ' ' + findingLabel(s, e.to));
      return addLog(s, 'ev', `**relation.added** × ${r.added.length}${extra.length ? ' · ' + extra.join('、') : ''}`, at);
    }

    case 'ui.ready': {
      const { findingId, spec, cache } = ev.data;
      const prev = state.slots[findingId] ?? newSlot(findingId, findingId, asShape((spec as Partial<UiSpec> | undefined)?.dataShape));
      const F = findingLabel(state, findingId);
      const problem = specProblem(spec, prev.finding ?? undefined);
      if (problem) {
        const slot: FindingSlot = { ...prev, ui: { status: 'failed', spec, reason: problem, cache: !!cache, pendingSwap: false } };
        return addLog(putSlot(state, slot), 'ev', `**ui.ready** · ${F} · 前端驗證失敗：${problem}`, at);
      }
      if (prev.ui.status === 'ready' && JSON.stringify(prev.ui.spec) === JSON.stringify(spec)) {
        return addLog(state, 'ev', `**ui.ready** · ${F} · 重複事件`, at);
      }
      const busy = prev.status === 'ready' && !!env.isBusy?.(findingId);
      const slot: FindingSlot = {
        ...prev,
        ui: { status: 'ready', spec, reason: null, cache: !!cache, pendingSwap: busy },
        view: busy ? prev.view : 'auto',
        anim: busy ? prev.anim : prev.anim + 1,
      };
      const s = { ...putSlot(state, slot), templates: addTemplate(state.templates, (spec as UiSpec).dataShape) };
      return addLog(s, 'ev', `**ui.ready** · ${F}${cache ? ' · 快取' : ''}${busy ? ' · 使用者操作中，暫不替換' : ''}`, at);
    }

    case 'ui.failed': {
      const { findingId, reason } = ev.data;
      const prev = state.slots[findingId] ?? newSlot(findingId, findingId, 'other');
      const slot: FindingSlot = { ...prev, ui: { status: 'failed', spec: prev.ui.spec, reason: reason || 'sub-UI 產生失敗', cache: false, pendingSwap: false } };
      const s = putSlot(state, slot);
      return addLog(s, 'ev', eventLogText(s, ev), at);
    }

    case 'project.completed': {
      const s = addLog(state, 'ev', eventLogText(state, ev), at);
      const stats = ev.data.stats;
      const done = finishProject(s, 'completed', { stats });
      return {
        ...done,
        projects: upsertProject(done.projects, { projectId: ev.projectId, status: 'completed', findingCount: stats?.findings ?? done.order.length, stats }),
      };
    }

    case 'project.failed': {
      const s = addLog(state, 'ev', eventLogText(state, ev), at);
      const done = finishProject(s, 'failed', { message: ev.data.message });
      return { ...done, projects: upsertProject(done.projects, { projectId: ev.projectId, status: 'failed', message: ev.data.message }) };
    }

    case 'agent.activity':
      return onActivity(state, ev.data, tsOf(ev), at);

    case 'agent.heartbeat':
      return onHeartbeat(state, ev.data, at);

    case 'agent.stalled': {
      const d = ev.data;
      if (!d || typeof d.agentId !== 'string' || !d.agentId) return state;
      const idleSec = nonNeg(d.idleSec) ?? 0;
      const action: StallAction = d.action === 'gave_up' ? 'gave_up' : 'retrying';
      const prev = state.agents[d.agentId] ?? blankAgent(d.agentId, 'thinking', at - idleSec * 1000);
      const agent: AgentLive = { ...prev, stalled: { action, idleSec, at, ts: tsOf(ev) } };
      const s = { ...state, agents: { ...state.agents, [d.agentId]: agent } };
      return addLog(s, 'ev', `**agent.stalled** · ${agentLabel(s, d.agentId)} · 閒置 ${Math.round(idleSec)} 秒 · ${action === 'retrying' ? '重新嘗試' : '已放棄'}`, at);
    }

    case 'synthesis.delta': {
      const d = ev.data;
      const syn = state.synthesis;
      if (!d || syn.status === 'ready') return state; // late chunks after synthesis.ready are ignored
      const seq = typeof d.seq === 'number' && Number.isInteger(d.seq) && d.seq >= 0 ? d.seq : null;
      if (seq === null || typeof d.text !== 'string') return state;
      const next = appendDelta(syn, seq, d.text);
      if (next === syn) return state;
      const s = { ...state, synthesis: next };
      return syn.status === 'none' ? addLog(s, 'ev', '**synthesis.delta** · 開始串流綜合報告', at) : s;
    }

    case 'synthesis.ready': {
      const syn = readySynthesis(ev.data?.synthesis);
      if (!syn) return addLog(state, 'note', '收到格式不正確的 synthesis.ready', at);
      const s = { ...state, synthesis: syn };
      return addLog(
        s,
        'ev',
        `**synthesis.ready** · 報告 ${Array.from(syn.text).length} 字 · 矛盾 ${syn.contradictions.length} · 缺口 ${syn.gaps.length} · 後續問題 ${syn.followUps.length}` +
          (syn.verification ? ` · 查核 ${syn.verification.supported}/${syn.verification.citedSentences} 句有據` : ''),
        at,
      );
    }

    case 'source.added': {
      const doc = readDoc(ev.data?.doc);
      if (!doc) return state;
      const known = state.docs.some((d) => d.docId === doc.docId);
      const docs = known ? state.docs.map((d) => (d.docId === doc.docId ? doc : d)) : [...state.docs, doc];
      const s = { ...state, docs };
      if (known) return s;
      const dup = doc.duplicateOf ? ' · 轉載，與既有來源重複' : '';
      return addLog(s, 'ev', `**source.added** · ${doc.publisher || doc.url} · ${sourceTypeLabel(doc.sourceType)}${dup}`, at);
    }

    case 'coverage.updated': {
      const coverage = readCoverage(ev.data);
      if (!coverage) return addLog(state, 'note', '收到格式不正確的 coverage.updated', at);
      const s = { ...state, coverage };
      const n = coverageCounts(coverage.requirements);
      return addLog(s, 'ev', `**coverage.updated** · 第 ${coverage.round} 輪 · 已涵蓋 ${n.covered}/${coverage.requirements.length} · 薄弱 ${n.weak} · 缺少 ${n.missing}`, at);
    }

    default:
      return state;
  }
}

/* ---------------- live progress ---------------- */

/** A heartbeat may imply a newer step than the last activity we got; within this window it is the same step. */
const HEARTBEAT_PHASE_SLACK_MS = 1000;

function blankAgent(agentId: string, phase: AgentPhase, lastActivityAt: number): AgentLive {
  return { agentId, phase, detail: null, lastActivityAt, ts: NaN, lastHeartbeatAt: null, idleSec: null, round: null, stalled: null };
}

function onActivity(state: ResearchState, d: { agentId: string; phase: AgentPhase; detail?: string; round?: number } | undefined, ts: number, at: number): ResearchState {
  if (!d || typeof d.agentId !== 'string' || !d.agentId) return state;
  const prev = state.agents[d.agentId];
  // Runtime events are batched; an activity published before the one we already have is stale.
  if (prev && ts < prev.ts) return state;
  const phase = asPhase(d.phase);
  const detail = typeof d.detail === 'string' && d.detail.trim() ? Array.from(d.detail).slice(0, 200).join('') : null;
  const round = asRound(d.round) ?? prev?.round ?? null;
  const clears = !!prev?.stalled && !(ts < prev.stalled.ts);
  const agent: AgentLive = {
    agentId: d.agentId,
    phase,
    detail,
    lastActivityAt: at,
    ts,
    lastHeartbeatAt: prev?.lastHeartbeatAt ?? null,
    idleSec: 0,
    round,
    stalled: prev?.stalled && !clears ? prev.stalled : null,
  };
  const s = { ...state, agents: { ...state.agents, [d.agentId]: agent } };
  const label = agentLabel(s, d.agentId);
  const text = activityLabel(phase, detail, round);
  // The log keeps the useful steps only: searches, reads, supervisor milestones, failures and recoveries.
  const supervisorStep = d.agentId === 'supervisor' && phase !== 'thinking' && phase !== 'done';
  if (clears) return addLog(s, 'ev', `**agent.activity** · ${label} · 恢復 · ${text}`, at);
  if (phase === 'searching' || phase === 'reading' || phase === 'failed' || supervisorStep) return addLog(s, 'ev', `**agent.activity** · ${label} · ${text}`, at);
  return s;
}

function onHeartbeat(state: ResearchState, d: { elapsedSec: number; agents: { agentId: string; phase: AgentPhase; idleSec: number }[] } | undefined, at: number): ResearchState {
  const list = Array.isArray(d?.agents) ? d!.agents : [];
  const agents = { ...state.agents };
  for (const a of list) {
    if (!a || typeof a.agentId !== 'string' || !a.agentId) continue;
    const idle = nonNeg(a.idleSec);
    const implied = idle === null ? at : at - idle * 1000;
    const prev = agents[a.agentId];
    if (!prev) {
      agents[a.agentId] = { ...blankAgent(a.agentId, asPhase(a.phase), implied), lastHeartbeatAt: at, idleSec: idle };
      continue;
    }
    const next: AgentLive = { ...prev, lastHeartbeatAt: at, idleSec: idle ?? prev.idleSec };
    // A missed (or not yet delivered) agent.activity: adopt the heartbeat's phase when it reports a newer step.
    const phase = asPhase(a.phase);
    if (phase !== prev.phase && implied > prev.lastActivityAt + HEARTBEAT_PHASE_SLACK_MS) {
      next.phase = phase;
      next.detail = null;
      next.lastActivityAt = implied;
    }
    agents[a.agentId] = next;
  }
  const gap = state.live.lastHeartbeatAt === null ? null : at - state.live.lastHeartbeatAt;
  const s: ResearchState = { ...state, agents, live: { ...state.live, lastHeartbeatAt: at } };
  return gap !== null && gap > STALE_AFTER_MS ? addLog(s, 'ev', `**agent.heartbeat** · 恢復，間隔 ${Math.round(gap / 1000)} 秒`, at) : s;
}

/** Appends one synthesis.delta in seq order. Returns `syn` itself when the chunk changes nothing (duplicate). */
function appendDelta(syn: SynthesisState, seq: number, text: string): SynthesisState {
  let { start, next } = syn;
  if (start !== null && next !== null) {
    if (seq < start) {
      // We guessed a 1-based stream from chunk 1; chunk 0 showed up late.
      return seq === 0 && start === 1 ? { ...syn, status: 'streaming', text: text + syn.text, start: 0 } : syn;
    }
    if (seq < next) return syn;
  }
  if (syn.pending[seq] !== undefined) return syn;
  const pending: Record<number, string> = { ...syn.pending, [seq]: text };
  if (start === null) {
    start = pending[0] !== undefined ? 0 : pending[1] !== undefined ? 1 : null;
    if (start === null) return { ...syn, status: 'streaming', pending };
    next = start;
  }
  let out = syn.text;
  let n = next!;
  while (pending[n] !== undefined) {
    out += pending[n];
    delete pending[n];
    n++;
  }
  return { ...syn, status: 'streaming', text: out, start, next: n, pending };
}

function readySynthesis(raw: unknown): SynthesisState | null {
  if (!isObj(raw) || typeof raw.report !== 'string') return null;
  const v = raw as Partial<Synthesis>;
  return {
    ...emptySynthesis(),
    status: 'ready',
    text: v.report!,
    contradictions: strings(v.contradictions),
    gaps: strings(v.gaps),
    followUps: strings(v.followUps),
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : null,
    citations: readCitations(v.citations),
    verification: readVerification(v.verification),
  };
}

/* ---------------- evidence (claims, documents, coverage) ---------------- */

const SOURCE_TYPE_LABEL: Record<string, string> = {
  government: '政府',
  standards: '標準',
  academic: '學術',
  research: '研究機構',
  news: '新聞',
  reference: '參考資料',
  community: '社群',
  official: '官方',
  unknown: '其他',
};

export function sourceTypeLabel(t: string | undefined | null): string {
  return SOURCE_TYPE_LABEL[t ?? 'unknown'] ?? SOURCE_TYPE_LABEL.unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readRequirements(raw: unknown): Requirement[] {
  if (!Array.isArray(raw)) return [];
  const out: Requirement[] = [];
  for (const r of raw) {
    if (isObj(r) && str(r.id) && str(r.text) && !out.some((x) => x.id === r.id)) out.push({ id: r.id as string, text: r.text as string });
  }
  return out;
}

function readDoc(raw: unknown): SourceDoc | null {
  if (!isObj(raw) || !str(raw.docId) || !str(raw.url)) return null;
  const type = typeof raw.sourceType === 'string' && (SOURCE_TYPES as readonly string[]).includes(raw.sourceType) ? (raw.sourceType as SourceDoc['sourceType']) : 'unknown';
  const score = num(raw.score);
  return {
    docId: raw.docId as string,
    url: raw.url as string,
    canonicalUrl: str(raw.canonicalUrl) ?? undefined,
    title: str(raw.title) ?? (raw.url as string),
    publisher: str(raw.publisher) ?? '',
    publishedDate: str(raw.publishedDate),
    sourceType: type,
    score: score === null ? undefined : Math.max(0, Math.min(1, score)),
    duplicateOf: str(raw.duplicateOf),
    via: str(raw.via) ?? undefined,
    fetchedAt: str(raw.fetchedAt) ?? undefined,
  };
}

const COVERAGE_STATUSES: readonly CoverageStatus[] = ['covered', 'weak', 'missing'];

function readCoverage(raw: unknown): Coverage | null {
  if (!isObj(raw) || !Array.isArray(raw.requirements)) return null;
  const requirements: CoverageItem[] = [];
  for (const r of raw.requirements) {
    if (!isObj(r) || !str(r.id)) continue;
    const status = (COVERAGE_STATUSES as readonly unknown[]).includes(r.status) ? (r.status as CoverageStatus) : 'missing';
    const item: CoverageItem = { id: r.id as string, status, claimIds: strings(r.claimIds) };
    if (str(r.note)) item.note = r.note as string;
    requirements.push(item);
  }
  return { round: asRound(raw.round) ?? 1, requirements, updatedAt: str(raw.updatedAt) ?? undefined };
}

function readCitations(raw: unknown): Record<string, CitationRef> {
  const out: Record<string, CitationRef> = {};
  if (!isObj(raw)) return out;
  for (const [label, ref] of Object.entries(raw)) {
    if (/^C\d{1,3}$/.test(label) && isObj(ref) && str(ref.claimId)) out[label] = { claimId: ref.claimId as string, findingId: str(ref.findingId) ?? '' };
  }
  return out;
}

const VERIFICATION_COUNTS = ['citedSentences', 'supported', 'partial', 'unsupported', 'revised', 'removed', 'uncitedSentences', 'unknownCitations', 'claimsCited'] as const;

function readVerification(raw: unknown): Verification | null {
  if (!isObj(raw)) return null;
  const v = {} as Verification;
  for (const k of VERIFICATION_COUNTS) v[k] = Math.max(0, Math.round(num(raw[k]) ?? 0));
  const before = num(raw.precisionBefore);
  const after = num(raw.precisionAfter);
  v.precisionBefore = before === null ? null : Math.max(0, Math.min(1, before));
  v.precisionAfter = after === null ? null : Math.max(0, Math.min(1, after));
  v.deadUrls = strings(raw.deadUrls);
  return v;
}

export function coverageCounts(items: readonly CoverageItem[]): Record<CoverageStatus, number> {
  const n: Record<CoverageStatus, number> = { covered: 0, weak: 0, missing: 0 };
  for (const i of items) n[i.status]++;
  return n;
}

const CLAIM_STATUSES: readonly string[] = ['corroborated', 'asserted', 'contested'];

/**
 * The finding's well-formed claims (a finding written before the evidence backbone has none).
 * `superseded` claims (reserved in the schema for claims a later finding replaced) are left out;
 * any other unknown status is shown as single-source.
 */
export function claimsOf(f: Finding | null | undefined): Claim[] {
  if (!f || !Array.isArray(f.claims)) return [];
  const out: Claim[] = [];
  for (const c of f.claims as unknown[]) {
    if (!isObj(c) || typeof c.claimId !== 'string' || typeof c.text !== 'string' || !Array.isArray(c.evidence)) continue;
    if (c.status === 'superseded') continue;
    const claim = c as unknown as Claim;
    out.push(CLAIM_STATUSES.includes(claim.status) ? claim : { ...claim, status: 'asserted' });
  }
  return out;
}

export interface ClaimRef {
  claim: Claim;
  findingId: string;
}

/** claimId → claim, across the open project's findings. */
export function claimIndex(state: Pick<ResearchState, 'order' | 'slots'>): Map<string, ClaimRef> {
  const out = new Map<string, ClaimRef>();
  for (const id of state.order) for (const claim of claimsOf(state.slots[id]?.finding)) out.set(claim.claimId, { claim, findingId: id });
  return out;
}

export interface EvidenceStats {
  sources: number;
  publishers: number;
  duplicates: number;
  claims: number;
  corroborated: number;
  asserted: number;
  contested: number;
}

export function evidenceStats(state: Pick<ResearchState, 'order' | 'slots' | 'docs'>): EvidenceStats {
  const claims = state.order.flatMap((id) => claimsOf(state.slots[id]?.finding));
  return {
    sources: state.docs.length,
    publishers: new Set(state.docs.map((d) => d.publisher).filter(Boolean)).size,
    duplicates: state.docs.filter((d) => d.duplicateOf).length,
    claims: claims.length,
    corroborated: claims.filter((c) => c.status === 'corroborated').length,
    asserted: claims.filter((c) => c.status === 'asserted').length,
    contested: claims.filter((c) => c.status === 'contested').length,
  };
}

/* ---------------- hydrate ---------------- */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizePlan(plan: ProjectGetResult['plan'], findings: Finding[]): SubQuestion[] {
  const list = Array.isArray(plan) ? plan : isObj(plan) && Array.isArray(plan.subQuestions) ? plan.subQuestions : null;
  if (list && list.length) return list.filter((q) => q && typeof q.findingId === 'string');
  return findings.map((f) => ({ findingId: f.findingId, question: f.question, dataShape: f.dataShape }));
}

function normalizeUiSpecs(raw: ProjectGetResult['uiSpecs']): Record<string, UiSpecRecord> {
  const out: Record<string, UiSpecRecord> = {};
  if (Array.isArray(raw)) {
    for (const r of raw) if (isObj(r) && typeof r.findingId === 'string') out[r.findingId] = r as UiSpecRecord;
  } else if (isObj(raw)) {
    for (const [id, v] of Object.entries(raw)) {
      if (isObj(v) && ('spec' in v || 'status' in v || 'reason' in v)) out[id] = { findingId: id, ...(v as Omit<UiSpecRecord, 'findingId'>) };
      else out[id] = { findingId: id, spec: v };
    }
  }
  return out;
}

function deriveMentions(findings: Finding[]): Edge[] {
  const edges: Edge[] = [];
  for (const f of findings) for (const e of f.entities ?? []) edges.push({ from: f.findingId, to: e.id, type: 'mentions' });
  return edges;
}

/**
 * Restores a project from project_get. Keeps the log, templates, saved list and cleanup state of `base`.
 * `at` is when the result arrived: for a running project, the liveness rule counts from there until the
 * first heartbeat. Re-hydrating the open project (「重新整理狀態」) keeps this session's live progress.
 */
export function hydrate(result: ProjectGetResult, base: ResearchState = initialState(), at?: number): ResearchState {
  const project: OpenProject = { ...result.project };
  const findings = (result.findings ?? []).filter((f) => f && typeof f.findingId === 'string');
  const byId = new Map(findings.map((f) => [f.findingId, f]));
  const plan = normalizePlan(result.plan, findings);
  const uiSpecs = normalizeUiSpecs(result.uiSpecs);
  const running = project.status === 'running';
  const same = base.project?.projectId === project.projectId;

  const slots: Record<string, FindingSlot> = {};
  const order: string[] = [];
  const place = (id: string, question: string, shape: DataShape, round: number) => {
    if (slots[id]) return;
    order.push(id);
    const f = byId.get(id) ?? null;
    const slot = newSlot(id, f?.question || question, f ? asShape(f.dataShape) : shape, round);
    slot.finding = f;
    slot.status = f ? 'ready' : running ? 'researching' : 'missing';
    const rec = uiSpecs[id];
    if (rec) {
      const problem = specProblem(rec.spec, f ?? undefined);
      if (rec.status === 'failed') slot.ui = { status: 'failed', spec: rec.spec ?? null, reason: rec.reason ?? problem ?? 'sub-UI 產生失敗', cache: false, pendingSwap: false };
      else if (rec.spec !== undefined && problem) slot.ui = { status: 'failed', spec: rec.spec, reason: problem, cache: false, pendingSwap: false };
      else if (rec.spec !== undefined) slot.ui = { status: 'ready', spec: rec.spec, reason: null, cache: !!rec.cache, pendingSwap: false };
    } else if (f && running && SUB_UI_SHAPES.has(asShape(f.dataShape))) {
      slot.ui = { ...slot.ui, status: 'generating' };
    }
    slots[id] = slot;
  };
  for (const q of plan) place(q.findingId, q.question, asShape(q.dataShape), asRound(q.round) ?? 1);
  for (const f of findings) place(f.findingId, f.question, asShape(f.dataShape), 1);

  const saved = readySynthesis(result.synthesis);
  const requirements = readRequirements(result.requirements);
  // A refresh of the open project may race a source.added that is not stored yet; keep what we already have.
  const docs = (Array.isArray(result.docs) ? result.docs : []).map(readDoc).filter((d): d is SourceDoc => d !== null);
  let s: ResearchState = {
    ...initialState(),
    project,
    plan,
    order,
    slots,
    log: base.log,
    logSeq: base.logSeq,
    templates: base.templates,
    projects: upsertProject(base.projects, { ...project }),
    cleanup: base.cleanup,
    clock: same && running && base.clock.running ? base.clock : { startedAt: null, scale: base.clock.scale, running: false },
    agents: same ? base.agents : {},
    // Same project: we have been listening since the first restore, so a refresh only adds the server's updatedAt.
    live: same ? { ...base.live, hydratedAt: base.live.hydratedAt ?? at ?? null } : { ...emptyLive(), hydratedAt: at ?? null },
    synthesis: saved ?? (same ? base.synthesis : emptySynthesis()),
    requirements: requirements.length ? requirements : same ? base.requirements : [],
    coverage: (result.coverage ? readCoverage(result.coverage) : null) ?? (same ? base.coverage : null),
    docs: same ? [...docs, ...base.docs.filter((d) => !docs.some((x) => x.docId === d.docId))] : docs,
  };
  s = withEntities(s, result.entities);
  for (const f of findings) s = withEntities(s, f.entities);
  for (const f of findings) s = withFindingNode(s, f.findingId);
  const edges = result.edges && result.edges.length ? result.edges : deriveMentions(findings);
  s = withEdges(s, edges).state;
  return s;
}

/* ---------------- local actions ---------------- */

export type Action =
  | { kind: 'event'; event: ResearchEvent; at: number; busy?: string[] }
  | { kind: 'log'; logKind: LogKind; text: string; at: number }
  | { kind: 'run.start'; projectId: string; topic: string; parentProjectId: string | null; at: number; scale: number; keepLogAfter?: number }
  | { kind: 'run.error'; projectId: string; message: string; at: number }
  | { kind: 'hydrate'; result: ProjectGetResult; at?: number }
  | { kind: 'view.toggle'; findingId: string }
  | { kind: 'swap.apply'; findingId: string }
  | { kind: 'highlight'; entityId: string | null }
  | { kind: 'projects.set'; projects: Project[] }
  | { kind: 'cleanup.confirm' | 'cleanup.cancel' | 'cleanup.start' | 'cleanup.step' | 'cleanup.archived' | 'cleanup.remove'; projectId: string }
  | { kind: 'cleanup.error'; projectId: string; message: string }
  | { kind: 'templates.clear' };

function patchSlot(state: ResearchState, id: string, fn: (s: FindingSlot) => FindingSlot): ResearchState {
  const slot = state.slots[id];
  if (!slot) return state;
  return { ...state, slots: { ...state.slots, [id]: fn(slot) } };
}

function setCleanup(state: ResearchState, id: string, c: CleanupState | null): ResearchState {
  const { [id]: _old, ...rest } = state.cleanup;
  return { ...state, cleanup: c ? { ...rest, [id]: c } : rest };
}

export function update(state: ResearchState, action: Action): ResearchState {
  switch (action.kind) {
    case 'event': {
      const busy = new Set(action.busy ?? []);
      return reduce(state, action.event, { now: action.at, isBusy: (id) => busy.has(id) });
    }
    case 'log':
      return addLog(state, action.logKind, action.text, action.at);
    case 'run.start': {
      const project: OpenProject = { projectId: action.projectId, topic: action.topic, status: 'running', parentProjectId: action.parentProjectId };
      return {
        ...initialState(),
        project,
        templates: state.templates,
        projects: state.projects,
        cleanup: state.cleanup,
        // The log restarts with each run (like the prototype), keeping lines logged since the click (e.g. project_restart).
        log: action.keepLogAfter === undefined ? [] : state.log.filter((l) => l.id > action.keepLogAfter!),
        logSeq: state.logSeq,
        clock: { startedAt: action.at, scale: action.scale, running: true },
        live: { ...emptyLive(), startedAt: action.at },
      };
    }
    case 'run.error': {
      if (!state.project || state.project.projectId !== action.projectId) return state;
      const s = addLog(state, 'note', '啟動失敗：' + action.message, action.at);
      return finishProject(s, 'failed', { message: action.message });
    }
    case 'hydrate':
      return hydrate(action.result, state, action.at);
    case 'view.toggle':
      return patchSlot(state, action.findingId, (s) => ({ ...s, view: s.view === 'auto' ? 'generic' : 'auto', anim: s.anim + 1 }));
    case 'swap.apply':
      return patchSlot(state, action.findingId, (s) => ({ ...s, view: 'auto', ui: { ...s.ui, pendingSwap: false }, anim: s.anim + 1 }));
    case 'highlight':
      return { ...state, highlight: action.entityId === null || state.highlight === action.entityId ? null : action.entityId };
    case 'projects.set': {
      // Keep projects we know are running locally even if the list lags behind.
      const incoming = action.projects;
      const extra = state.projects.filter((p) => p.status === 'running' && !incoming.some((x) => x.projectId === p.projectId));
      return { ...state, projects: [...extra, ...incoming] };
    }
    case 'cleanup.confirm':
      return setCleanup(state, action.projectId, { phase: 'confirm', step: 0 });
    case 'cleanup.cancel':
      return setCleanup(state, action.projectId, null);
    case 'cleanup.start':
      return setCleanup(state, action.projectId, { phase: 'running', step: 0 });
    case 'cleanup.step': {
      const c = state.cleanup[action.projectId];
      if (!c || c.phase !== 'running') return state;
      // Hold on the last step until project.archived (or the project_list poll) confirms it.
      return setCleanup(state, action.projectId, { ...c, step: Math.min(c.step + 1, CLEANUP_STEPS.length - 1) });
    }
    case 'cleanup.archived': {
      const c = state.cleanup[action.projectId];
      if (!c || c.phase !== 'running') return state;
      return setCleanup(state, action.projectId, { phase: 'done', step: CLEANUP_STEPS.length });
    }
    case 'cleanup.remove': {
      let s = setCleanup(state, action.projectId, null);
      s = { ...s, projects: s.projects.filter((p) => p.projectId !== action.projectId) };
      const isOpen = s.project?.projectId === action.projectId;
      return isOpen && !s.clock.running ? closeOpenProject(s) : s;
    }
    case 'cleanup.error':
      return setCleanup(state, action.projectId, { phase: 'error', step: state.cleanup[action.projectId]?.step ?? 0, error: action.message });
    case 'templates.clear':
      return { ...state, templates: [] };
    default:
      return state;
  }
}

/* ---------------- selectors ---------------- */

export function showsSubUi(slot: FindingSlot): boolean {
  return slot.status === 'ready' && slot.ui.status === 'ready' && slot.view === 'auto' && !slot.ui.pendingSwap;
}

export type TierKind = 'base' | 'live' | 'accent' | 'bad';
export function tierOf(slot: FindingSlot): [TierKind, string] {
  if (slot.status === 'researching') return ['live', '研究中'];
  if (slot.status === 'missing') return ['base', '未完成'];
  if (slot.ui.status === 'failed') return ['bad', 'sub-UI 驗證失敗'];
  if (showsSubUi(slot)) return ['accent', 'sub-UI · JSON spec'];
  return ['base', '通用卡片'];
}

export function statsOf(state: ResearchState) {
  const slots = state.order.map((id) => state.slots[id]).filter(Boolean);
  return {
    total: slots.length,
    ready: slots.filter((s) => s.status === 'ready').length,
    uiReady: slots.filter((s) => s.ui.status === 'ready').length,
    edges: state.edges.length,
  };
}

/* ---------------- liveness (contracts/events.md, "Liveness rule for clients") ---------------- */

export type Liveness = 'alive' | 'quiet' | 'stale' | 'idle';
/** Heartbeats come every 10 s; after 15 s of silence show a soft warning. */
export const QUIET_AFTER_MS = 15_000;
export const STALE_AFTER_MS = 30_000;
/** The runtime refreshes project.updatedAt every 60 s; older than this on load means it stopped. */
export const STALE_UPDATED_MS = 180_000;

type LiveSlice = Pick<ResearchState, 'project' | 'live'>;

function updatedAtMs(p: Project): number | null {
  const t = p.updatedAt ? Date.parse(p.updatedAt) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * The latest sign of life for the open running project, or null when there is none to measure from:
 * the last heartbeat, the run start (run started in this tab), project.updatedAt from project_get, and,
 * only until the first heartbeat, the moment this tab restored the project (it cannot have missed
 * heartbeats from before it was listening).
 */
export function livenessRef(state: LiveSlice): number | null {
  const p = state.project;
  if (!p || p.status !== 'running') return null;
  const lv = state.live;
  const marks = [lv.lastHeartbeatAt, lv.startedAt, updatedAtMs(p), lv.lastHeartbeatAt === null ? lv.hydratedAt : null];
  const known = marks.filter((x): x is number => x !== null);
  return known.length ? Math.max(...known) : null;
}

/** Whether the open run looks alive at `now` (epoch ms). */
export function liveness(state: LiveSlice, now: number): Liveness {
  const p = state.project;
  if (!p || p.status !== 'running') return 'idle';
  const lv = state.live;
  if (lv.lastHeartbeatAt === null && lv.startedAt === null) {
    const u = updatedAtMs(p);
    if (u !== null && now - u > STALE_UPDATED_MS) return 'stale';
  }
  const ref = livenessRef(state);
  if (ref === null) return 'quiet';
  const age = now - ref;
  if (age > STALE_AFTER_MS) return 'stale';
  if (age >= QUIET_AFTER_MS) return 'quiet';
  return 'alive';
}

/** How long the agent has produced nothing, using whichever of its last activity or last heartbeat is fresher. */
export function agentIdleMs(agent: AgentLive, now: number): number {
  const sinceActivity = now - agent.lastActivityAt;
  if (agent.lastHeartbeatAt === null || agent.idleSec === null) return Math.max(0, sinceActivity);
  return Math.max(0, Math.min(sinceActivity, now - agent.lastHeartbeatAt + agent.idleSec * 1000));
}

/** Finding ids whose finding mentions the entity. */
export function findingsMentioning(state: ResearchState, entityId: string): Set<string> {
  const out = new Set<string>();
  for (const id of state.order) {
    const f = state.slots[id]?.finding;
    if (f && f.entities.some((e) => e.id === entityId)) out.add(id);
  }
  for (const e of state.edges) if (e.type === 'mentions' && e.to === entityId) out.add(e.from);
  return out;
}
