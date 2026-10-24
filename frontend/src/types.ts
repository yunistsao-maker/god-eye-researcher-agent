/*
 * Shared types. Source of truth: contracts/events.md, finding.schema.json, ui-spec.schema.json.
 */

export type DataShape = 'comparison' | 'timeline' | 'metrics' | 'list' | 'other';
export const DATA_SHAPES: readonly DataShape[] = ['comparison', 'timeline', 'metrics', 'list', 'other'];

export type EntityType = 'org' | 'person' | 'tech' | 'domain' | 'place' | 'concept' | 'other';

export interface Entity {
  id: string; // ^e-[a-z0-9-]{1,60}$
  type: EntityType;
  name: string;
}

export type RelationType = 'supports' | 'contradicts' | 'causes';

export interface Relation {
  from: string;
  to: string;
  type: RelationType;
}

export interface Source {
  title: string;
  url: string;
}

/* dataShape payloads (Finding.data) */
export interface ComparisonData {
  columns: string[];
  rows: string[][];
}
export interface TimelineItem {
  when: string;
  what: string;
}
export interface TimelineData {
  items: TimelineItem[];
}
export interface MetricItem {
  label: string;
  value: number;
  unit: string;
}
export interface MetricsData {
  items: MetricItem[];
}

/* Evidence backbone: project documents, verified claims, coverage (contracts/events.md) */
export type SourceType = 'government' | 'standards' | 'academic' | 'research' | 'news' | 'reference' | 'community' | 'official' | 'unknown';
export const SOURCE_TYPES: readonly SourceType[] = ['government', 'standards', 'academic', 'research', 'news', 'reference', 'community', 'official', 'unknown'];

/** One fetched page, deduplicated and scored by the backend (DOC#). */
export interface SourceDoc {
  docId: string; // ^d-[0-9a-f]{12}$
  url: string;
  canonicalUrl?: string;
  title: string;
  /** Registrable domain; two docs with the same publisher are not independent. */
  publisher: string;
  publishedDate?: string | null;
  sourceType?: SourceType;
  /** 0..1 source quality prior (type, recency, blocklist). */
  score?: number;
  /** docId of the earlier near-duplicate (syndicated copy). */
  duplicateOf?: string | null;
  via?: string;
  fetchedAt?: string;
}

export type ClaimStatus = 'corroborated' | 'asserted' | 'contested' | 'superseded';
export type Stance = 'supports' | 'contradicts';

/** A verbatim quote, checked by the backend against the stored page text. */
export interface Evidence {
  docId: string;
  quote: string;
  stance: Stance;
  charStart?: number;
  charEnd?: number;
  url: string;
  title: string;
  publisher: string;
  duplicateOf?: string | null;
  sourceType?: SourceType;
  score?: number;
}

export interface Claim {
  claimId: string; // c-<n>-<m>
  text: string;
  /** corroborated: ≥2 independent publishers support it; contested: a source contradicts it. */
  status: ClaimStatus;
  independentSources: number;
  supporting: number;
  contradicting: number;
  evidence: Evidence[];
  /** Incremental runs: the earlier claim this one replaced. */
  updates?: string;
  /** Set when a newer claim replaced this one (status superseded). */
  supersededBy?: string;
}

/** A research requirement the plan commits to answering (from plan.ready / project_get). */
export interface Requirement {
  id: string;
  text: string;
}

export type CoverageStatus = 'covered' | 'weak' | 'missing';
export interface CoverageItem {
  id: string;
  status: CoverageStatus;
  claimIds: string[];
  note?: string;
}
export interface Coverage {
  round: number;
  requirements: CoverageItem[];
  updatedAt?: string;
}

export interface Finding {
  findingId: string; // ^f-[a-z0-9-]{1,40}$
  projectId: string; // ^p-[a-z0-9-]{4,60}$
  question: string;
  summary: string;
  keyPoints: string[];
  entities: Entity[];
  relations?: Relation[];
  sources: Source[];
  dataShape: DataShape;
  data: Record<string, unknown>;
  confidence: number;
  /** Verified claims; absent on findings written before the evidence backbone. */
  claims?: Claim[];
}

export type EdgeType = 'mentions' | 'shares_entity' | 'supports' | 'contradicts' | 'causes' | 'similar_to';

export interface Edge {
  from: string;
  to: string;
  type: EdgeType;
  via?: string;
}

/* UI spec (sub-UI template) */
export type SpecPath = string; // ^\$(\.[A-Za-z_][A-Za-z0-9_]{0,40}){1,4}$
export type SpecField = string; // ^[A-Za-z_][A-Za-z0-9_]{0,40}$

export interface CompareNode {
  component: 'Compare';
  props: { columns: SpecPath; rows: SpecPath; emphasizeColumn?: number };
}
export interface TimelineNode {
  component: 'Timeline';
  props: { items: SpecPath; label: SpecField; text: SpecField };
}
export interface MetricBarsNode {
  component: 'MetricBars';
  props: { items: SpecPath; label: SpecField; value: SpecField; unit?: SpecField };
}
export interface KeyPointsNode {
  component: 'KeyPoints';
  props: { items: SpecPath };
}
export type UiNode = CompareNode | TimelineNode | MetricBarsNode | KeyPointsNode;
export type UiComponentName = UiNode['component'];

export interface UiSpec {
  specVersion: 1;
  dataShape: DataShape;
  title?: string;
  root: UiNode;
}

/* Projects (project-tools) */
export type ProjectStatus = 'draft' | 'running' | 'completed' | 'failed' | 'stopped' | 'archiving' | 'archived';

export type Depth = 'quick' | 'standard' | 'deep';
export const DEPTHS: readonly Depth[] = ['quick', 'standard', 'deep'];

/** The research brief sent with plan/start and stored with the project. */
export interface Brief {
  depth?: Depth;
  audience?: string;
  startDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  notes?: string;
}

export interface ProjectStats {
  findings: number;
  edges: number;
  uiReady: number;
  elapsedSec: number;
  sources?: number;
  claims?: number;
}

/**
 * The contracts do not spell out Project's fields; these are the ones the UI reads.
 * Everything except projectId/topic/status is optional so a leaner backend still works.
 */
export interface Project {
  projectId: string;
  topic: string;
  status: ProjectStatus;
  parentProjectId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  findingCount?: number;
  stats?: ProjectStats;
  message?: string;
  /** 1 for the first run, +1 per incremental run. */
  version?: number;
  /** Incremental runs search from this date (YYYY-MM-DD). */
  since?: string;
  completedAt?: string;
  stoppedAt?: string;
  brief?: Brief;
  /** The owner asked for an email when the run ends. */
  notify?: boolean;
}

export interface SubQuestion {
  findingId: string;
  question: string;
  dataShape: DataShape;
  /** 1 for the first plan; 2 for follow-up questions added after the supervisor's review. */
  round?: number;
  /** The run this sub-question belongs to (incremental runs). */
  version?: number;
  /** Incremental runs: the earlier findingId this sub-question re-researches. */
  updates?: string;
}

/** A plan waiting for the user's approval (draft project). */
export interface ProposedPlan {
  subQuestions: SubQuestion[];
  requirements: Requirement[];
  brief?: Brief;
  by?: 'agent' | 'user';
  updatedAt?: string;
}

export type SteerKind = 'redirect' | 'finish';
export interface Steer {
  steerId: string;
  kind: SteerKind;
  text: string;
  createdAt: string;
  /** The round that applied it (redirects). */
  appliedRound?: number;
}

/** A follow-up question about the report and its answer. */
export interface QA {
  qaId: string;
  question: string;
  selection?: string;
  answer: string;
  citations: Record<string, CitationRef>;
  needsResearch: boolean;
  researchQuestion?: string;
  createdAt: string;
}

export interface ReportVersion {
  version: number;
  createdAt?: string;
  report: string;
}

/** `[C3]` in the report → the claim it cites. */
export interface CitationRef {
  claimId: string;
  findingId: string;
}

/** Sentence-level check of the report against the claims it cites (counts are sentences). */
export interface Verification {
  citedSentences: number;
  supported: number;
  partial: number;
  unsupported: number;
  revised: number;
  removed: number;
  uncitedSentences: number;
  unknownCitations: number;
  claimsCited: number;
  /** Share of cited sentences supported by their claims before / after revision. */
  precisionBefore?: number | null;
  precisionAfter?: number | null;
  deadUrls?: string[];
}

/** synthesis_write / synthesis.ready / project_get.synthesis */
export interface Synthesis {
  report: string; // markdown; cites claims as [C1], [C2]…
  contradictions: string[];
  gaps: string[];
  followUps: string[];
  createdAt?: string;
  citations?: Record<string, CitationRef>;
  verification?: Verification | null;
  version?: number;
  /** Incremental runs: how many claims are new and how many replaced earlier ones. */
  changes?: { newClaims?: number; updatedClaims?: number };
}

/* Live progress (published by the research runtime, not persisted) */
/** `waiting` is supervisor-only: its sub-agents are running. It is not watched for stalls and the
 *  supervisor is left out of agent.heartbeat's `agents` while waiting. */
export type AgentPhase =
  | 'planning'
  | 'waiting'
  | 'thinking'
  | 'searching'
  | 'reading'
  | 'writing'
  | 'designing'
  | 'reviewing'
  | 'reporting'
  | 'verifying'
  | 'done'
  | 'failed';
export const AGENT_PHASES: readonly AgentPhase[] = ['planning', 'waiting', 'thinking', 'searching', 'reading', 'writing', 'designing', 'reviewing', 'reporting', 'verifying', 'done', 'failed'];
export type StallAction = 'retrying' | 'gave_up';

export interface HeartbeatAgent {
  agentId: string;
  phase: AgentPhase;
  idleSec: number;
}

/* Events (AppSync Events, channel /research/{projectId}) */
interface EventBase<T extends string, D> {
  type: T;
  projectId: string;
  ts: string;
  data: D;
}

export type ProjectCreatedEvent = EventBase<'project.created', { topic: string; parentProjectId: string | null; status?: 'draft' | 'running' }>;
export type PlanReadyEvent = EventBase<'plan.ready', { subQuestions: SubQuestion[]; requirements?: Requirement[]; steerIds?: string[] }>;
export type PlanProposedEvent = EventBase<'plan.proposed', ProposedPlan>;
export type PlanFailedEvent = EventBase<'plan.failed', { message: string }>;
export type ProjectStartedEvent = EventBase<'project.started', { version: number; mode: 'full' | 'incremental'; since: string | null }>;
export type ProjectStoppedEvent = EventBase<'project.stopped', { stats: ProjectStats }>;
export type SteerReceivedEvent = EventBase<'steer.received', { steer: Steer }>;
export type ClaimsUpdatedEvent = EventBase<'claims.updated', { superseded: { claimId: string; findingId: string; supersededBy: string }[] }>;
export type QaReadyEvent = EventBase<'qa.ready', { qa: QA }>;
export type QaFailedEvent = EventBase<'qa.failed', { qaId: string; message: string }>;
export type FindingReadyEvent = EventBase<'finding.ready', { finding: Finding }>;
export type RelationAddedEvent = EventBase<'relation.added', { entities: Entity[]; edges: Edge[] }>;
export type UiReadyEvent = EventBase<'ui.ready', { findingId: string; spec: UiSpec; cache: boolean }>;
export type UiFailedEvent = EventBase<'ui.failed', { findingId: string; reason: string }>;
export type ProjectCompletedEvent = EventBase<'project.completed', { stats: ProjectStats }>;
export type ProjectFailedEvent = EventBase<'project.failed', { message: string }>;
export type ProjectArchivedEvent = EventBase<'project.archived', Record<string, never>>;
export type SynthesisReadyEvent = EventBase<'synthesis.ready', { synthesis: Synthesis }>;
export type AgentActivityEvent = EventBase<'agent.activity', { agentId: string; phase: AgentPhase; detail?: string; round?: number }>;
export type AgentHeartbeatEvent = EventBase<'agent.heartbeat', { elapsedSec: number; agents: HeartbeatAgent[] }>;
export type AgentStalledEvent = EventBase<'agent.stalled', { agentId: string; idleSec: number; action: StallAction }>;
export type SynthesisDeltaEvent = EventBase<'synthesis.delta', { seq: number; text: string }>;
export type SourceAddedEvent = EventBase<'source.added', { doc: SourceDoc }>;
export type CoverageUpdatedEvent = EventBase<'coverage.updated', Coverage>;

export type ResearchEvent =
  | ProjectCreatedEvent
  | PlanReadyEvent
  | FindingReadyEvent
  | RelationAddedEvent
  | UiReadyEvent
  | UiFailedEvent
  | ProjectCompletedEvent
  | ProjectFailedEvent
  | ProjectArchivedEvent
  | SynthesisReadyEvent
  | AgentActivityEvent
  | AgentHeartbeatEvent
  | AgentStalledEvent
  | SynthesisDeltaEvent
  | SourceAddedEvent
  | CoverageUpdatedEvent
  | PlanProposedEvent
  | PlanFailedEvent
  | ProjectStartedEvent
  | ProjectStoppedEvent
  | SteerReceivedEvent
  | ClaimsUpdatedEvent
  | QaReadyEvent
  | QaFailedEvent;

export type ResearchEventType = ResearchEvent['type'];

export const EVENT_TYPES: readonly ResearchEventType[] = [
  'project.created',
  'plan.ready',
  'finding.ready',
  'relation.added',
  'ui.ready',
  'ui.failed',
  'project.completed',
  'project.failed',
  'project.archived',
  'synthesis.ready',
  'agent.activity',
  'agent.heartbeat',
  'agent.stalled',
  'synthesis.delta',
  'source.added',
  'coverage.updated',
  'plan.proposed',
  'plan.failed',
  'project.started',
  'project.stopped',
  'steer.received',
  'claims.updated',
  'qa.ready',
  'qa.failed',
];

/* Tool results (project-tools) */
export interface ProjectListResult {
  projects: Project[];
}

/** One stored sub-UI. project_get's exact uiSpecs shape is not in the contracts, so hydrate() accepts several forms. */
export interface UiSpecRecord {
  findingId: string;
  spec?: unknown;
  status?: 'ready' | 'failed';
  reason?: string;
  cache?: boolean;
}

export interface ProjectGetResult {
  project: Project;
  plan?: { subQuestions: SubQuestion[] } | SubQuestion[] | null;
  findings?: Finding[];
  uiSpecs?: UiSpecRecord[] | Record<string, unknown>;
  entities?: Entity[];
  edges?: Edge[];
  /** null until synthesis_write has run. */
  synthesis?: Synthesis | null;
  requirements?: Requirement[];
  /** Readable project documents (fetch errors are left out). */
  docs?: SourceDoc[];
  /** null until the first review. */
  coverage?: Coverage | null;
  /** The plan a draft proposes (null otherwise). */
  proposedPlan?: ProposedPlan | null;
  /** Earlier versions of the report (incremental runs). */
  history?: ReportVersion[];
  steering?: Steer[];
  qa?: QA[];
}

export interface ProjectRestartResult {
  projectId: string;
  parentProjectId: string;
  topic: string;
}

export interface ProjectCleanupResult {
  projectId: string;
  status: 'archiving';
  executionArn: string;
}

export interface ProjectSaveResult {
  project: Project;
}

/* Runtime config (public/config.json) */
export interface AppConfig {
  mode: 'mock' | 'live';
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  eventsHttpEndpoint: string;
  agentsBaseUrl: string;
  toolsMcpUrl: string;
  /** The deployment can email the owner when a run ends (project_notify). */
  emailNotifications: boolean;
}

export const DEFAULT_TOPIC = '台灣半導體產業導入生成式 AI 的現況';
