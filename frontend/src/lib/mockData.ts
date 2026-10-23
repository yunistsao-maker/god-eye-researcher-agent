/*
 * Simulated content for mock mode, ported from the approved prototype and shaped to the contracts.
 * Every source title carries （模擬） and points at the reserved example.com / .org / .net domains.
 */
import type {
  CitationRef,
  Claim,
  Coverage,
  DataShape,
  Edge,
  Entity,
  EntityType,
  Evidence,
  Finding,
  Relation,
  Requirement,
  SourceDoc,
  SourceType,
  Synthesis,
  UiSpec,
} from '../types';
import { DEFAULT_TOPIC } from '../types';

export const MOCK_TOPIC = DEFAULT_TOPIC;

const ENTITY_DEFS: Record<string, { id: string; type: EntityType }> = {
  '晶圓廠 A': { id: 'e-fab-a', type: 'org' },
  '封測廠 B': { id: 'e-osat-b', type: 'org' },
  'IC 設計 C': { id: 'e-ic-design-c', type: 'org' },
  知識檢索: { id: 'e-knowledge-retrieval', type: 'tech' },
  良率分析: { id: 'e-yield-analysis', type: 'domain' },
  設備維護: { id: 'e-equipment-maintenance', type: 'domain' },
  混合部署: { id: 'e-hybrid-deployment', type: 'concept' },
  資料主權: { id: 'e-data-sovereignty', type: 'concept' },
  生產力: { id: 'e-productivity', type: 'concept' },
  系統整合: { id: 'e-system-integration', type: 'concept' },
  產業公會: { id: 'e-industry-association', type: 'org' },
  '雲端 SaaS': { id: 'e-cloud-saas', type: 'tech' },
};

function entity(name: string): Entity {
  const d = ENTITY_DEFS[name];
  return { id: d.id, type: d.type, name };
}

export interface MockSub {
  n: number; // 1-based plan index
  /** 2 for the follow-up questions added after the supervisor's review. */
  round: 1 | 2;
  question: string;
  dataShape: DataShape;
  /** Two web searches the sub-agent runs (agent.activity `searching`). */
  queries: [string, string];
  at: number; // ms after start (round 1) or after the round-2 plan.ready (round 2) when finding.ready is published (1× speed)
  uiDelay: number; // simulated uigen time
  failReason?: string;
  summary: string;
  keyPoints: string[];
  entities: string[];
  sources: { title: string; path: string }[];
  confidence: number;
  data: Record<string, unknown>;
  /** Explicit relations stated by the sub-agent (by plan index). */
  relations: { to: number; type: Relation['type'] }[];
  /** Embedding similarity edges (phase 2), by plan index. */
  similarTo: number[];
  /** The second source contradicts claim `k` (keyPoints[k]) with this quote. */
  contest?: { k: number; quote: string };
  /** A syndicated copy of source `of`, cited with it for claim `k` (one publisher, two pages). */
  syndicated?: { of: number; k: number; title: string; path: string };
}

export const MOCK_SUBS: MockSub[] = [
  {
    n: 1,
    round: 1,
    queries: ['台灣 晶圓廠 生成式 AI 導入 應用場景', 'semiconductor fab generative AI use cases yield analysis'],
    question: '哪些製程與營運環節最早導入生成式 AI？',
    dataShape: 'comparison',
    at: 2600,
    uiDelay: 2200,
    summary: '最早落地的是工程知識檢索與良率異常分析；直接影響製程參數的應用仍停在試驗階段。',
    keyPoints: ['工程知識檢索導入最快，風險最低', '良率異常分析以輔助判讀為主，決策仍由工程師負責', '製程參數建議多半還在 POC'],
    entities: ['晶圓廠 A', '知識檢索', '良率分析', '設備維護'],
    sources: [
      { title: '產業調查報告（模擬）', path: 'reports/semiconductor-genai-survey' },
      { title: '廠務技術研討會簡報（模擬）', path: 'talks/fab-operations-genai' },
    ],
    confidence: 0.82,
    data: {
      columns: ['環節', '階段', '主要用途'],
      rows: [
        ['工程知識檢索', '正式上線', 'SOP 與規格文件問答'],
        ['良率異常分析', '擴大試行', '異常報告摘要、根因建議'],
        ['設備維修', '試行', '維修手冊問答'],
        ['製程參數建議', 'POC', '參數調整建議'],
      ],
    },
    relations: [],
    similarTo: [],
  },
  {
    n: 2,
    round: 1,
    queries: ['半導體 生成式 AI 導入 時程 里程碑', 'fab LLM knowledge base rollout timeline'],
    question: '導入的時程與關鍵里程碑',
    dataShape: 'timeline',
    at: 4300,
    uiDelay: 2000,
    summary: '多數廠商從內部文件問答起步，約一年後才擴展到良率與維修流程，近期開始嘗試多 agent 協作。',
    keyPoints: ['先建知識庫與權限控管，再擴大使用範圍', '部署模式逐步從純雲端轉向混合'],
    entities: ['晶圓廠 A', '封測廠 B', '知識檢索', '混合部署'],
    sources: [
      { title: '企業年報摘要（模擬）', path: 'reports/annual-report-summary' },
      { title: '產業媒體專訪（模擬）', path: 'news/genai-rollout-interview' },
    ],
    confidence: 0.71,
    data: {
      items: [
        { when: '2023 H2', what: '內部試用 LLM 文件問答' },
        { when: '2024 H1', what: '建立內部知識庫與權限控管' },
        { when: '2024 H2', what: '良率分析助理擴大試行' },
        { when: '2025', what: '地端模型與雲端混合部署' },
        { when: '2026', what: '多 agent 協作導入維修流程' },
      ],
    },
    relations: [],
    similarTo: [],
    syndicated: { of: 1, k: 1, title: '產業媒體專訪（轉載，模擬）', path: 'syndication/genai-rollout-interview' },
  },
  {
    n: 3,
    round: 1,
    queries: ['生成式 AI 工程師 生產力 半導體 量化成效', 'GenAI engineering productivity metrics semiconductor'],
    question: '導入後有哪些可量化的成效？',
    dataShape: 'metrics',
    at: 3400,
    uiDelay: 2800,
    summary: '公開數據集中在工程師的時間節省，以文件撰寫與資料查詢下降最多。',
    keyPoints: ['文件撰寫與查詢時間下降最明顯', '良率本身的改善尚缺公開數據'],
    entities: ['良率分析', '封測廠 B', '生產力'],
    sources: [
      { title: '廠商技術部落格（模擬）', path: 'blog/engineering-productivity' },
      { title: '研討會簡報（模擬）', path: 'talks/genai-impact-metrics' },
    ],
    confidence: 0.64,
    data: {
      items: [
        { label: '異常報告撰寫時間', value: -40, unit: '%' },
        { label: '工程師查詢文件時間', value: -35, unit: '%' },
        { label: '根因分析初判時間', value: -28, unit: '%' },
        { label: '新人上手時間', value: -20, unit: '%' },
      ],
    },
    relations: [],
    similarTo: [1],
    contest: { k: 0, quote: '各廠回報的時間節省比例差異很大，難以直接比較' },
  },
  {
    n: 4,
    round: 1,
    queries: ['半導體 地端 LLM 混合雲 部署', 'hybrid on-prem LLM deployment manufacturing data sovereignty'],
    question: '部署模式：雲端、地端還是混合？',
    dataShape: 'comparison',
    at: 5600,
    uiDelay: 2200,
    summary: '製程與良率資料多留在地端，非敏感文件走雲端，混合部署成為主流。',
    keyPoints: ['依資料敏感度分流', '最大挑戰是兩套環境的治理一致性'],
    entities: ['混合部署', '資料主權', '晶圓廠 A', 'IC 設計 C'],
    sources: [
      { title: '雲端服務商案例（模擬）', path: 'cases/hybrid-genai-deployment' },
      { title: '產業顧問報告（模擬）', path: 'reports/deployment-models' },
    ],
    confidence: 0.77,
    data: {
      columns: ['模式', '適合的資料', '主要顧慮'],
      rows: [
        ['雲端', '非敏感文件、快速試行', '資料出境與合規'],
        ['地端', '製程與良率資料', 'GPU 成本與維運人力'],
        ['混合', '依敏感度分流', '治理一致性'],
      ],
    },
    relations: [],
    similarTo: [2],
  },
  {
    n: 5,
    round: 1,
    queries: ['半導體 生成式 AI 風險 資料外洩', 'GenAI adoption barriers MES integration cost'],
    question: '主要風險與導入阻礙',
    dataShape: 'list',
    at: 6500,
    uiDelay: 2400,
    failReason: 'spec 驗證失敗：元件 RiskMatrix 不在白名單內',
    summary: '資料外洩疑慮與系統整合成本是主要阻礙；另外各家成效數據多為自評，缺少一致基準。',
    keyPoints: ['製程資料外洩風險讓多數廠商選擇地端或混合', '成效數據多為內部自評，缺少一致的衡量基準', '既有 MES 與文件系統整合成本高'],
    entities: ['資料主權', 'IC 設計 C', '生產力', '系統整合'],
    sources: [
      { title: '產業公會調查（模擬）', path: 'surveys/genai-adoption-barriers' },
      { title: '資安顧問報告（模擬）', path: 'reports/genai-security-risks' },
    ],
    confidence: 0.69,
    data: {},
    relations: [{ to: 3, type: 'contradicts' }],
    similarTo: [],
  },
];

/** Round 2: follow-up questions the supervisor adds after reviewing round 1 (F3 vs F5, and a gap). */
export const MOCK_FOLLOWUPS: MockSub[] = [
  {
    n: 6,
    round: 2,
    queries: ['生成式 AI 導入成效 衡量基準 跨廠商', 'cross-company GenAI productivity benchmark manufacturing'],
    question: '有沒有跨廠商一致的成效衡量基準？',
    dataShape: 'comparison',
    at: 2300,
    uiDelay: 1800,
    summary: '目前沒有公開的跨廠商基準。產業公會與顧問報告各有衡量框架，但指標定義不同，數據仍以自評為主。',
    keyPoints: ['公開數據多為單一廠商自評', '產業公會的框架以工時節省為主，沒有涵蓋良率', '多數廠商沒有導入前的基準值，難以比較'],
    entities: ['產業公會', '生產力', '良率分析'],
    sources: [
      { title: '產業公會白皮書（模擬）', path: 'whitepapers/genai-productivity-framework' },
      { title: '顧問公司衡量方法（模擬）', path: 'reports/genai-roi-methodology' },
    ],
    confidence: 0.58,
    data: {
      columns: ['來源', '衡量方式', '涵蓋範圍'],
      rows: [
        ['廠商自評', '導入前後工時比較', '單一廠區'],
        ['產業公會框架', '問卷加工時抽樣', '會員廠商'],
        ['顧問報告', 'ROI 模型', '個案'],
      ],
    },
    relations: [{ to: 5, type: 'supports' }],
    similarTo: [3],
  },
  {
    n: 7,
    round: 2,
    queries: ['中小型 IC 設計公司 生成式 AI 導入 限制', 'fabless startup LLM adoption NDA constraints'],
    question: '中小型 IC 設計公司的導入狀況與限制',
    dataShape: 'list',
    at: 3000,
    uiDelay: 0,
    summary: '中小型 IC 設計公司多從雲端 SaaS 工具起步，用在規格文件與程式碼輔助；受限於客戶保密條款與人力，很少自建模型。',
    keyPoints: ['以雲端 SaaS 起步，少有自建模型', '客戶保密條款限制可上傳的設計資料', '缺少專職的 MLOps 人力'],
    entities: ['IC 設計 C', '資料主權', '雲端 SaaS'],
    sources: [
      { title: '新創社群訪談（模擬）', path: 'interviews/fabless-genai-adoption' },
      { title: 'EDA 廠商部落格（模擬）', path: 'blog/eda-genai-assistants' },
    ],
    confidence: 0.61,
    data: {},
    relations: [],
    similarTo: [4],
  },
];

/** What the plan commits to answering (plan.ready requirements). */
export const MOCK_REQUIREMENTS: Requirement[] = [
  { id: 'q1', text: '最早導入的製程與營運環節' },
  { id: 'q2', text: '導入時程與部署模式' },
  { id: 'q3', text: '可量化的成效與衡量方式' },
  { id: 'q4', text: '風險、阻礙與資料安全' },
  { id: 'q5', text: '不同規模廠商的差異' },
];

/**
 * The supervisor's report. ⟦n.k⟧ cites claim k of sub-question n (keyPoints[k]); numberCitations()
 * turns them into [C1], [C2]… in order of first use, as the backend's catalog does.
 */
const REPORT_TEMPLATE = [
  '## 總結（模擬報告）',
  '',
  '這份報告由 mock 模式產生，內容是**模擬資料**，不是真實研究結果。',
  '',
  '台灣半導體業導入生成式 AI 的路徑相當一致：先從**工程知識檢索**起步 ⟦1.0⟧，再擴展到良率異常分析與設備維修，決策仍由工程師負責 ⟦1.1⟧；直接影響製程參數的應用仍停在 POC ⟦1.2⟧。',
  '',
  '## 主要發現',
  '',
  '- 多數廠商先建知識庫與權限控管，再擴大使用範圍 ⟦2.0⟧。',
  '- 部署以**混合模式**為主，依資料敏感度分流 ⟦4.0⟧；製程資料外洩的疑慮是主因 ⟦5.0⟧。',
  '- 可量化的成效集中在文件撰寫與查詢時間，例如異常報告撰寫時間約 -40% ⟦3.0⟧。',
  '- 主要阻礙還包括與既有 `MES` 和文件系統整合的成本 ⟦5.2⟧。',
  '',
  '## 矛盾與限制',
  '',
  '成效數字多為內部自評，缺少一致的衡量基準 ⟦5.1⟧。補充研究也找不到跨廠商的公開衡量方式 ⟦6.0⟧，因此這些數字只能當作方向參考。',
  '',
  '### 中小型廠商',
  '',
  '中小型 IC 設計公司多從雲端 SaaS 起步 ⟦7.0⟧，受限於客戶保密條款，很少把設計資料交給外部模型 ⟦7.1⟧。',
  '',
  '## 建議',
  '',
  '1. 先建立權限控管完整的知識庫，再擴大到良率與維修流程。',
  '2. 依資料敏感度分流，採混合部署。',
  '3. 導入前先定義可比較的成效指標與基準值。',
  '',
  '參考：[產業調查報告（模擬）](https://example.com/reports/semiconductor-genai-survey)',
].join('\n');

function numberCitations(template: string): { report: string; cites: [number, number][] } {
  const cites: [number, number][] = [];
  const report = template.replace(/⟦(\d+)\.(\d+)⟧/g, (_, n: string, k: string) => {
    let i = cites.findIndex(([a, b]) => a === Number(n) && b === Number(k));
    if (i < 0) i = cites.push([Number(n), Number(k)]) - 1;
    return `[C${i + 1}]`;
  });
  return { report, cites };
}

const NUMBERED = numberCitations(REPORT_TEMPLATE);

/** The supervisor's report (streamed as synthesis.delta, then synthesis.ready). Simulated content. */
export const MOCK_SYNTHESIS: Omit<Synthesis, 'createdAt' | 'citations' | 'verification'> = {
  report: NUMBERED.report,
  contradictions: ['F3 的時間節省數字與 F5「成效多為自評、缺少基準」的觀察不一致（模擬）'],
  gaps: ['良率本身的改善沒有公開數據（模擬）', '中小型廠商的導入資料很少，只有訪談（模擬）'],
  followUps: ['不同部署模式的總持有成本比較（模擬）', '多 agent 維修流程的實際成效（模擬）'],
};

/** synthesis_write for a project: the report plus its citation map and sentence-level check. */
export function buildSynthesis(projectId: string, createdAt: string): Synthesis {
  const citations: Record<string, CitationRef> = {};
  NUMBERED.cites.forEach(([n, k], i) => {
    citations[`C${i + 1}`] = { claimId: claimIdFor(projectId, n, k), findingId: findingIdFor(projectId, n) };
  });
  return {
    ...structuredClone(MOCK_SYNTHESIS),
    createdAt,
    citations,
    // Simulated: one sentence was only partly supported and one was rewritten by the reviser.
    verification: {
      citedSentences: 8,
      supported: 6,
      partial: 1,
      unsupported: 1,
      revised: 1,
      removed: 0,
      uncitedSentences: 5,
      unknownCitations: 0,
      claimsCited: NUMBERED.cites.length,
      precisionBefore: 0.75,
      precisionAfter: 0.875,
      deadUrls: [],
    },
  };
}

/** coverage.updated after round 1 (before the follow-ups) and round 2 (final). */
export function mockCoverage(projectId: string, round: 1 | 2): Coverage {
  const c = (n: number, k: number) => claimIdFor(projectId, n, k);
  const requirements: Coverage['requirements'] =
    round === 1
      ? [
          { id: 'q1', status: 'covered', claimIds: [c(1, 0), c(1, 1), c(1, 2)] },
          { id: 'q2', status: 'covered', claimIds: [c(2, 0), c(4, 0)] },
          { id: 'q3', status: 'weak', claimIds: [c(3, 0)], note: '成效數字多為自評，來源說法不一（模擬）' },
          { id: 'q4', status: 'covered', claimIds: [c(5, 0), c(5, 2)] },
          { id: 'q5', status: 'missing', claimIds: [], note: '沒有中小型廠商的資料（模擬）' },
        ]
      : [
          { id: 'q1', status: 'covered', claimIds: [c(1, 0), c(1, 1), c(1, 2)] },
          { id: 'q2', status: 'covered', claimIds: [c(2, 0), c(4, 0)] },
          { id: 'q3', status: 'weak', claimIds: [c(3, 0), c(6, 0)], note: '仍沒有跨廠商的衡量基準（模擬）' },
          { id: 'q4', status: 'covered', claimIds: [c(5, 0), c(5, 2)] },
          { id: 'q5', status: 'covered', claimIds: [c(7, 0), c(7, 1)], note: '只有訪談資料（模擬）' },
        ];
  return { round, requirements, updatedAt: '2026-10-22T06:12:1' + (round === 1 ? '0' : '8') + '.000Z' };
}

/* ---------------- documents and claims ---------------- */

const HOSTS = ['example.com', 'example.org'];
const SYNDICATION_HOST = 'example.net';
const TYPE_BY_DIR: Record<string, SourceType> = {
  reports: 'research',
  surveys: 'research',
  talks: 'reference',
  news: 'news',
  interviews: 'news',
  syndication: 'news',
  blog: 'community',
  cases: 'official',
  whitepapers: 'official',
};
const TYPE_SCORE: Partial<Record<SourceType, number>> = { official: 0.8, research: 0.75, news: 0.6, reference: 0.6, community: 0.4 };

function hex8(s: string, seed: number): string {
  let h = seed >>> 0;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A stable `d-` + 12 hex id for a URL (the backend uses sha1 of the canonical URL). */
export function docIdFor(url: string): string {
  return 'd-' + (hex8(url, 2166136261) + hex8(url, 0x9747b28c)).slice(0, 12);
}

export function claimIdFor(projectId: string, n: number, k: number): string {
  return `c-${suffixOf(projectId)}-${n}-${k + 1}`;
}

function mockDoc(sub: MockSub, title: string, path: string, host: string, i: number, duplicateOf: string | null): SourceDoc {
  const url = `https://${host}/${path}`;
  const sourceType = TYPE_BY_DIR[path.split('/')[0]] ?? 'unknown';
  const score = duplicateOf ? 0.5 : Math.round(((TYPE_SCORE[sourceType] ?? 0.5) - i * 0.03) * 100) / 100;
  return {
    docId: docIdFor(url),
    url,
    canonicalUrl: url,
    title,
    publisher: host,
    publishedDate: `2026-${String(3 + (sub.n % 6)).padStart(2, '0')}-${String(8 + i * 9).padStart(2, '0')}`,
    sourceType,
    score,
    duplicateOf,
    via: 'direct',
  };
}

/** The pages a sub-agent reads: its two sources (on different publishers) and, if any, a syndicated copy. */
export function mockDocs(sub: MockSub): SourceDoc[] {
  const docs = sub.sources.map((s, i) => mockDoc(sub, s.title, s.path, HOSTS[i % HOSTS.length], i, null));
  if (sub.syndicated) {
    const of = docs[sub.syndicated.of];
    docs.push(mockDoc(sub, sub.syndicated.title, sub.syndicated.path, SYNDICATION_HOST, docs.length, of.docId));
  }
  return docs;
}

function evidence(doc: SourceDoc, quote: string, stance: Evidence['stance'], docs: SourceDoc[]): Evidence {
  // As in the backend, a syndicated copy carries the publisher of the page it copies.
  const original = doc.duplicateOf ? docs.find((d) => d.docId === doc.duplicateOf) : undefined;
  return {
    docId: doc.docId,
    quote,
    stance,
    url: doc.url,
    title: doc.title,
    publisher: original?.publisher ?? doc.publisher,
    duplicateOf: doc.duplicateOf ?? null,
    sourceType: doc.sourceType,
    score: doc.score,
  };
}

/** finding_write's verified claims, one per key point, with the backend's status rules. */
export function mockClaims(projectId: string, sub: MockSub): Claim[] {
  const docs = mockDocs(sub);
  return sub.keyPoints.map((text, k) => {
    let ev: Evidence[];
    if (sub.syndicated?.k === k) ev = [evidence(docs[sub.syndicated.of], text, 'supports', docs), evidence(docs[docs.length - 1], text, 'supports', docs)];
    else if (sub.contest?.k === k) ev = [evidence(docs[0], text, 'supports', docs), evidence(docs[1], sub.contest.quote, 'contradicts', docs)];
    else if (k === 0) ev = [evidence(docs[0], text, 'supports', docs), evidence(docs[1], text, 'supports', docs)];
    else ev = [evidence(docs[k % 2], text, 'supports', docs)];
    const supporting = ev.filter((e) => e.stance === 'supports');
    const contradicting = ev.length - supporting.length;
    const independent = new Set(supporting.map((e) => e.publisher)).size;
    return {
      claimId: claimIdFor(projectId, sub.n, k),
      text,
      status: contradicting ? 'contested' : independent >= 2 ? 'corroborated' : 'asserted',
      independentSources: independent,
      supporting: supporting.length,
      contradicting,
      evidence: ev,
    };
  });
}

/** Splits text into ~`size`-character chunks (synthesis.delta). */
export function chunkText(text: string, size = 40): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

export function suffixOf(projectId: string): string {
  const tail = projectId.split('-').pop() ?? 'x';
  return tail.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'x';
}

export function findingIdFor(projectId: string, n: number): string {
  return `f-${suffixOf(projectId)}-${n}`;
}

export function buildFinding(projectId: string, sub: MockSub): Finding {
  const findingId = findingIdFor(projectId, sub.n);
  const f: Finding = {
    findingId,
    projectId,
    question: sub.question,
    summary: sub.summary,
    keyPoints: [...sub.keyPoints],
    entities: sub.entities.map(entity),
    sources: mockDocs(sub)
      .filter((d) => !d.duplicateOf)
      .map((d) => ({ title: d.title, url: d.url })),
    dataShape: sub.dataShape,
    data: structuredClone(sub.data),
    confidence: sub.confidence,
    claims: mockClaims(projectId, sub),
  };
  if (sub.relations.length) {
    f.relations = sub.relations.map((r) => ({ from: findingId, to: findingIdFor(projectId, r.to), type: r.type }));
  }
  return f;
}

/** Edges that finding_write would publish for `f`, given the findings already written before it. */
export function relationEdges(f: Finding, sub: MockSub, earlier: Finding[]): Edge[] {
  const edges: Edge[] = f.entities.map((e) => ({ from: f.findingId, to: e.id, type: 'mentions' as const }));
  for (const other of earlier) {
    for (const e of f.entities) {
      if (other.entities.some((x) => x.id === e.id)) edges.push({ from: f.findingId, to: other.findingId, type: 'shares_entity', via: e.id });
    }
  }
  const ready = new Set(earlier.map((x) => x.findingId));
  for (const r of f.relations ?? []) if (ready.has(r.to)) edges.push({ from: r.from, to: r.to, type: r.type });
  for (const n of sub.similarTo) {
    const to = findingIdFor(f.projectId, n);
    if (ready.has(to)) edges.push({ from: f.findingId, to, type: 'similar_to' });
  }
  return edges;
}

/** The spec uigen "generates" per dataShape. The list shape asks for a component outside the whitelist. */
export function generatedSpec(shape: DataShape): unknown {
  switch (shape) {
    case 'comparison':
      return { specVersion: 1, dataShape: 'comparison', root: { component: 'Compare', props: { columns: '$.data.columns', rows: '$.data.rows', emphasizeColumn: 1 } } } satisfies UiSpec;
    case 'timeline':
      return { specVersion: 1, dataShape: 'timeline', root: { component: 'Timeline', props: { items: '$.data.items', label: 'when', text: 'what' } } } satisfies UiSpec;
    case 'metrics':
      return {
        specVersion: 1,
        dataShape: 'metrics',
        title: '導入前後的時間變化',
        root: { component: 'MetricBars', props: { items: '$.data.items', label: 'label', value: 'value', unit: 'unit' } },
      } satisfies UiSpec;
    default:
      return { specVersion: 1, dataShape: shape, root: { component: 'RiskMatrix', props: { items: '$.keyPoints' } } };
  }
}
