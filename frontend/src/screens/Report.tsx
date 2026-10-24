/*
 * 報告閱讀器. Reading mode (the default) is laid out like a research survey: a title, the scope line,
 * a byline, an executive summary (the bottom line, then labelled key points), and sections that open
 * with their conclusion, with tables where the report compares things. Citations are small numbers;
 * one opens the quote it rests on and links to the highlighted passage. 查證模式 adds the evidence
 * margin, coloured citations and the sentence check. Below: sources grouped by kind, earlier versions,
 * and follow-up questions answered only from this report's claims.
 */
import { Fragment, useCallback, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { Bars, BarsFor, MarkLegend } from '../components/Bars';
import { Markdown, MdTable, renderInline, type CiteRenderer } from '../components/Markdown';
import { SourceList } from '../components/Sources';
import { useNow } from '../components/useNow';
import { CLAIM_STATUS_LABEL, STRENGTH_LABEL, TYPE_GROUP_LABEL, pct, quoteHref, relTime, strengthLine, strengthOf, typeGroup, ymd, type StrengthSummary } from '../lib/evidence';
import { parseInline, parseMarkdown, type Block, type Inline } from '../lib/markdown';
import { DEPTH_NAME } from '../lib/progress';
import { navigate, projectPath } from '../router';
import { claimIndex, sourceTypeLabel, type ClaimRef, type ResearchState } from '../state';
import type { CitationRef, Claim, SourceDoc, Verification } from '../types';
import type { ScreenProps } from '../workspace';

type Mode = 'read' | 'verify';
const MODE_KEY = 'godeye.reportMode';

function loadMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'verify' ? 'verify' : 'read';
  } catch {
    return 'read';
  }
}
function saveMode(m: Mode) {
  try {
    window.localStorage.setItem(MODE_KEY, m);
  } catch {
    /* private mode: the choice lasts for this visit */
  }
}

const SUMMARY_HEADING = /摘要|總結|summary/i;
/** Sections that already discuss limits and open questions (then the review's lists are not repeated). */
const OPEN_HEADING = /矛盾|不確定|限制|待追蹤|尚待|未解|limitation|uncertaint|open question|follow-up|to watch/i;
const TAKEAWAY = /^(結論|小結|重點|bottom line|key takeaway|takeaway)\s*[：:]?$/i;

/* ---------------- reading the report's structure ---------------- */

function plainText(list: Inline[]): string {
  return list.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'a' ? n.v : n.t === 'b' ? plainText(n.c) : '')).join('');
}

function labelsIn(list: Inline[], out: string[] = []): string[] {
  for (const n of list) {
    if (n.t === 'cite') out.push(n.label);
    else if (n.t === 'b') labelsIn(n.c, out);
  }
  return out;
}

function blockLabels(b: Block): string[] {
  if (b.t === 'table') return [...b.head, ...b.rows.flat()].flatMap((c) => labelsIn(c));
  if ('items' in b) return b.items.flatMap((it) => labelsIn(it));
  return labelsIn(b.c);
}

/** Drops leading whitespace and a colon left after a bold label. */
function trimLead(list: Inline[]): Inline[] {
  const out = list.slice();
  while (out.length && out[0].t === 'text') {
    const v = (out[0] as { v: string }).v.replace(/^[\s：:]+/, '');
    if (v) {
      out[0] = { t: 'text', v };
      break;
    }
    out.shift();
  }
  return out;
}

/** "**結論：** …" → the label and the rest; also "**現況：** …" in a list item (short labels only). */
function leadLabel(c: Inline[], pattern?: RegExp): { label: string; rest: Inline[] } | null {
  const first = c[0];
  if (!first || first.t !== 'b') return null;
  const raw = plainText(first.c).trim();
  const next = c[1];
  const colonAfter = next?.t === 'text' && /^\s*[：:]/.test(next.v);
  if (!/[：:]$/.test(raw) && !colonAfter) return null;
  const label = raw.replace(/[：:]$/, '').trim();
  if (!label || Array.from(label).length > 14 || (pattern && !pattern.test(label))) return null;
  return { label, rest: trimLead(c.slice(1)) };
}

/** A paragraph that is bold as a whole (citations included): the executive summary's bottom line. */
function boldParagraph(b: Block): Inline[] | null {
  if (b.t !== 'p' || !b.c.length || b.c[0].t !== 'b') return null;
  const rest = b.c.slice(1);
  if (!rest.every((n) => n.t === 'cite' || (n.t === 'text' && /^[\s。．.!！?？]*$/.test(n.v)))) return null;
  return [...b.c[0].c, ...rest];
}

interface Section {
  id: string;
  title: string;
  blocks: { block: Block; index: number }[];
}

interface Doc {
  title: string;
  dek: Inline[] | null;
  sections: Section[];
}

function docOf(blocks: Block[], topic: string): Doc {
  let title = topic;
  let dek: Inline[] | null = null;
  const sections: Section[] = [];
  let cur: Section = { id: 'sec-0', title: '', blocks: [] };
  let start = 0;
  if (blocks[0]?.t === 'h' && blocks[0].level === 2) {
    title = plainText(blocks[0].c) || topic;
    start = 1;
  }
  for (let index = start; index < blocks.length; index++) {
    const b = blocks[index];
    if (b.t === 'h' && b.level <= 3) {
      if (cur.title || cur.blocks.length) sections.push(cur);
      cur = { id: `sec-${sections.length + 1}`, title: plainText(b.c), blocks: [] };
      continue;
    }
    // The first paragraph under the title (before any section) is the scope line.
    if (!dek && !sections.length && !cur.title && !cur.blocks.length && b.t === 'p' && start === 1) {
      dek = b.c;
      continue;
    }
    cur.blocks.push({ block: b, index });
  }
  if (cur.title || cur.blocks.length) sections.push(cur);
  return { title, dek, sections };
}

/** Citation labels numbered 1, 2, … in order of first use. */
function citeNumbers(blocks: Block[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of blocks) for (const l of blockLabels(b)) if (!out.has(l)) out.set(l, out.size + 1);
  return out;
}

/* ---------------- pieces ---------------- */

function VerificationBar({ v }: { v: Verification }) {
  const items: [string, number, string][] = [
    ['有據', v.supported, 'ok'],
    ['部分有據', v.partial, 'part'],
    ['已修正', v.revised, 'fix'],
    ['已刪除', v.removed, 'del'],
    ['未引用', v.uncitedSentences, ''],
  ];
  const dead = v.deadUrls ?? [];
  return (
    <div className="verify" aria-label="逐句查核結果">
      <span className="h">逐句查核</span>
      <span>
        引用句 <b>{v.citedSentences}</b>
      </span>
      {items
        .filter(([, n]) => n > 0)
        .map(([label, n, cls]) => (
          <span key={label} className={cls}>
            {label} <b>{n}</b>
          </span>
        ))}
      {v.precisionBefore != null ? (
        <span title="引用句中，被所引主張支持的比例：修正前 → 修正後">
          引用精確度 <b>{pct(v.precisionBefore)}</b>
          {v.precisionAfter != null && v.precisionAfter !== v.precisionBefore ? (
            <>
              {' → '}
              <b>{pct(v.precisionAfter)}</b>
            </>
          ) : null}
        </span>
      ) : null}
      {dead.length ? (
        <span className="del" title={dead.join('\n')}>
          失效連結 <b>{dead.length}</b>
        </span>
      ) : null}
    </div>
  );
}

/** One line for reading mode: how much of the report was checked against its sources. */
function checkLine(v: Verification): string {
  const fixes = [v.revised ? `修正 ${v.revised} 句` : '', v.removed ? `刪除 ${v.removed} 句` : ''].filter(Boolean).join('、');
  const precision = v.precisionAfter ?? v.precisionBefore;
  return `已逐句查核 ${v.citedSentences} 句引用${precision != null ? `，引用精確度 ${pct(precision)}` : ''}${fixes ? `（${fixes}）` : ''}`;
}

interface OpenCite {
  block: number;
  label: string;
  idx: number;
}

function CiteCard({ refd, num, idx, setIdx, onClose, state }: { refd: ClaimRef; num: number; idx: number; setIdx: (i: number) => void; onClose: () => void; state: ResearchState }) {
  const c = refd.claim;
  const ev = c.evidence[Math.min(idx, c.evidence.length - 1)];
  const doc = state.docs.find((d) => d.docId === ev?.docId);
  const href = ev ? quoteHref(ev.url, ev.quote) : null;
  return (
    <div className="panel citecard rise" role="region" aria-label={`引用 ${num}`}>
      <div className="hd">
        <span className="n">{num}</span>
        <b>{ev?.title || ev?.publisher || '來源'}</b>
        <span className="muted small num">
          {Math.min(idx, c.evidence.length - 1) + 1}／{c.evidence.length}
        </span>
      </div>
      <p className="claimtext">
        <Bars strength={c.status} support={c.independentSources} against={c.contradicting} /> <span className={'strength ' + c.status}>{CLAIM_STATUS_LABEL[c.status]}</span>：{c.text}
      </p>
      {ev ? <blockquote>「{ev.quote}」</blockquote> : null}
      {ev ? (
        <div className="tags">
          <span className={'tag ' + (ev.stance === 'contradicts' ? 'contest' : 'accent')}>{ev.stance === 'contradicts' ? '反對' : '支持'}</span>
          <span className="tag">{ev.publisher}</span>
          <span className="tag">{sourceTypeLabel(ev.sourceType)}</span>
          {doc?.publishedDate ? <span className="tag">發布 {doc.publishedDate}</span> : null}
          {ev.duplicateOf ? <span className="tag contest">轉載</span> : null}
        </div>
      ) : null}
      <div className="acts">
        {href ? (
          <a className="btn small primary" href={href} target="_blank" rel="noopener noreferrer">
            開啟原文並高亮
          </a>
        ) : null}
        {c.evidence.length > 1 ? (
          <button type="button" className="btn small" onClick={() => setIdx((idx + 1) % c.evidence.length)}>
            下一個來源
          </button>
        ) : null}
        <a className="linkbtn" href={projectPath(state.project!.projectId, 'evidence', { claim: c.claimId })}>
          在證據台查看
        </a>
        <button type="button" className="linkbtn" onClick={onClose}>
          關閉
        </button>
      </div>
    </div>
  );
}

function ConflictBox({ claim }: { claim: Claim }) {
  const pro = claim.evidence.filter((e) => e.stance !== 'contradicts');
  const con = claim.evidence.filter((e) => e.stance === 'contradicts');
  if (!con.length) return null;
  const pubs = (list: typeof pro) => [...new Set(list.map((e) => e.publisher))].join('、');
  return (
    <div className="conflict">
      <h3>這一點來源說法不同</h3>
      <div className="sides">
        <div className="side">
          <span className="k">說法一，{new Set(pro.map((e) => e.publisher)).size} 個獨立來源</span>
          <q>{pro[0]?.quote ?? claim.text}</q>
          <span className="k">來自 {pubs(pro) || '—'}</span>
        </div>
        <div className="side">
          <span className="k">說法二，{new Set(con.map((e) => e.publisher)).size} 個獨立來源</span>
          <q>{con[0].quote}</q>
          <span className="k">來自 {pubs(con)}</span>
        </div>
      </div>
      <p className="small">兩種說法都列出來，不替你選邊；差異常來自範圍、時間或計算方式不同。</p>
    </div>
  );
}

/** Sources grouped by kind, like a survey's reference list; 查證模式 shows the scored list instead. */
function SourcesByKind({ docs }: { docs: SourceDoc[] }) {
  const originals = docs.filter((d) => !d.duplicateOf).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const groups = (['primary', 'research', 'news', 'other'] as const)
    .map((g) => [g, originals.filter((d) => typeGroup(d.sourceType) === g)] as const)
    .filter(([, list]) => list.length);
  return (
    <div className="refgroups">
      {groups.map(([g, list]) => (
        <div key={g} className="refgroup">
          <h3>{TYPE_GROUP_LABEL[g]}</h3>
          <ul>
            {list.map((d) => (
              <li key={d.docId}>
                <a href={d.url} target="_blank" rel="noopener noreferrer">
                  {d.title || d.publisher}
                </a>
                <span className="refmeta">
                  {d.publisher}
                  {d.publishedDate ? ` · ${d.publishedDate}` : ''}
                  {d.sourceType ? ` · ${sourceTypeLabel(d.sourceType)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ---------------- follow-up questions ---------------- */

function FollowUps({ state, actions, busy, selection, clearSelection, cite }: Pick<ScreenProps, 'state' | 'actions' | 'busy'> & { selection: string; clearSelection: () => void; cite: (citations: Record<string, CitationRef>) => CiteRenderer }) {
  const [q, setQ] = useState('');
  const now = useNow(Object.keys(state.qaPending).length > 0);
  const p = state.project!;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    void actions.ask(q.trim(), selection || undefined);
    setQ('');
    clearSelection();
  };
  const suggestions = state.synthesis.followUps.slice(0, 2);
  const pending = Object.values(state.qaPending);
  return (
    <section className="stack-lg" aria-labelledby="fu-h" id="followup">
      {state.qa.length || pending.length ? (
        <ol className="qa-list">
          {state.qa.map((a) => (
            <li key={a.qaId} className="panel qa">
              <p className="q">
                問：{a.question}
                <small>{relTime(Date.parse(a.createdAt), now)}</small>
              </p>
              {a.selection ? <p className="small muted">針對：「{a.selection.slice(0, 120)}」</p> : null}
              <div className="a">
                <Markdown source={a.answer} cite={cite(a.citations)} />
              </div>
              {a.needsResearch ? (
                <div className="need">
                  <span>這需要新的資料{a.researchQuestion ? `：${a.researchQuestion}` : ''}</span>
                  {p.status === 'completed' ? (
                    <button type="button" className="btn small" disabled={busy} onClick={() => void actions.rerun(a.researchQuestion ? [a.researchQuestion] : [])}>
                      補搜（增量重跑）
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
          {pending.map((x) => (
            <li key={x.qaId} className="panel qa" aria-busy={!x.error}>
              <p className="q">問：{x.question}</p>
              {x.error ? (
                <p className="err">
                  沒有回答：{x.error}{' '}
                  <button type="button" className="linkbtn" onClick={() => void actions.ask(x.question, x.selection)}>
                    再問一次
                  </button>
                </p>
              ) : (
                <div className="skel" aria-hidden="true">
                  <span style={{ width: '86%' }} />
                  <span style={{ width: '60%' }} />
                </div>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      <div className="panel followup">
        <h2 id="fu-h">追問這份報告</h2>
        {selection ? (
          <p className="sel">
            <span>針對選取的段落：「{selection.slice(0, 80)}{selection.length > 80 ? '…' : ''}」</span>
            <button type="button" className="linkbtn" onClick={clearSelection}>
              取消
            </button>
          </p>
        ) : null}
        <form onSubmit={submit}>
          <label className="sr-only" htmlFor="ask">
            追問
          </label>
          <input id="ask" className="input" maxLength={1000} value={q} placeholder="選取一段文字，或直接問：只看半導體封測時，結論會不同嗎？" onChange={(e) => setQ(e.target.value)} />
          <button type="submit" className="btn primary" disabled={busy || q.trim().length < 2}>
            送出
          </button>
        </form>
        <div className="chips">
          <button type="button" onClick={() => navigate(projectPath(p.projectId, 'evidence', { status: 'asserted' }))}>
            列出所有單一來源的主張
          </button>
          {suggestions.map((s) => (
            <button key={s} type="button" disabled={busy} onClick={() => void actions.ask(s)}>
              {s}
            </button>
          ))}
          {p.status === 'completed' ? (
            <button type="button" disabled={busy} onClick={() => void actions.rerun()}>
              用新資料重跑（增量）
            </button>
          ) : null}
        </div>
        <p className="hint">回答只引用這份報告的來源；需要新資料時，會先問你要不要補搜。</p>
      </div>
    </section>
  );
}

/* ---------------- export ---------------- */

/** The report as Markdown with numbered references to the claims and their sources. */
function exportMarkdown(text: string, nums: Map<string, number>, resolve: (label: string) => ClaimRef | null, docs: SourceDoc[], checked: string): string {
  const body = text.replace(/\[(C\d{1,3})\]/g, (m, label: string) => (nums.has(label) ? `[${nums.get(label)}]` : m));
  const refs = [...nums.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([label, n]) => {
      const c = resolve(label)?.claim;
      if (!c) return `${n}. （找不到這個主張）`;
      const urls = [...new Set(c.evidence.map((e) => e.url))].slice(0, 3);
      return `${n}. ${c.text}（${CLAIM_STATUS_LABEL[c.status]}）${urls.length ? ' — ' + urls.join('、') : ''}`;
    });
  const sources = docs.filter((d) => !d.duplicateOf).map((d) => `- [${d.title || d.publisher}](${d.url}) — ${d.publisher}${d.publishedDate ? '，' + d.publishedDate : ''}`);
  return [body, '', '## 引用', '', ...refs, '', '## 參考資料', '', `資料查證日期：${checked}。`, '', ...sources, ''].join('\n');
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- the report ---------------- */

export function Report({ state, actions, busy }: ScreenProps) {
  const p = state.project!;
  const syn = state.synthesis;
  const { order, slots } = state;
  const claims = useMemo(() => claimIndex({ order, slots }), [order, slots]);
  const dates = useMemo(() => new Map(state.docs.map((d) => [d.docId, d.publishedDate])), [state.docs]);
  const [mode, setModeState] = useState<Mode>(loadMode);
  const [open, setOpen] = useState<OpenCite | null>(null);
  const [selection, setSelection] = useState('');
  const [showVersion, setShowVersion] = useState<number | null>(null);
  const article = useRef<HTMLElement>(null);
  const setMode = (m: Mode) => {
    setModeState(m);
    saveMode(m);
  };
  const verify = mode === 'verify';

  const blocks = useMemo(() => (syn.status === 'ready' ? parseMarkdown(syn.text) : []), [syn.status, syn.text]);
  const doc = useMemo(() => docOf(blocks, p.topic), [blocks, p.topic]);
  const nums = useMemo(() => citeNumbers(blocks), [blocks]);

  const resolve = useCallback(
    (label: string, citations: Record<string, CitationRef> = syn.citations): ClaimRef | null => {
      const ref = citations[label];
      return ref ? claims.get(ref.claimId) ?? null : null;
    },
    [syn.citations, claims],
  );
  const strengthFor = (labels: string[]): StrengthSummary =>
    strengthOf(labels.map((l) => resolve(l)?.claim).filter((c): c is Claim => !!c), dates);

  const citeFor = (blockIndex: number): CiteRenderer =>
    function Cite(label: string) {
      const ref = resolve(label);
      const n = nums.get(label) ?? Number(label.slice(1));
      if (!ref) return <span className={verify ? 'cite plain' : 'ref plain'}>{n}</span>;
      const on = open?.block === blockIndex && open.label === label;
      return (
        <button
          type="button"
          className={verify ? 'cite ' + ref.claim.status + (on ? ' on' : '') : 'ref' + (on ? ' on' : '')}
          aria-expanded={on}
          aria-label={`引用 ${n}：${CLAIM_STATUS_LABEL[ref.claim.status]}`}
          title={ref.claim.text}
          onClick={() => setOpen(on ? null : { block: blockIndex, label, idx: 0 })}
        >
          {n}
        </button>
      );
    };
  const qaCite = (citations: Record<string, CitationRef>): CiteRenderer =>
    function QaCite(label: string) {
      const ref = resolve(label, citations);
      return ref ? (
        <a className={'cite ' + ref.claim.status} href={projectPath(p.projectId, 'evidence', { claim: ref.claim.claimId })} title={ref.claim.text}>
          {label.slice(1)}
        </a>
      ) : (
        <span className="cite plain">{label.slice(1)}</span>
      );
    };

  const onSelect = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!text || !sel?.anchorNode || !article.current?.contains(sel.anchorNode)) return;
    setSelection(text.slice(0, 500));
  };

  const originals = state.docs.filter((d) => !d.duplicateOf);
  const publishers = new Set(originals.map((d) => d.publisher)).size;
  const duplicates = state.docs.length - originals.length;
  const version = syn.version || p.version || 1;

  if (syn.status !== 'ready') {
    return (
      <main className="page narrow" id="main">
        {syn.status === 'streaming' ? (
          <div className="paper streaming">
            <p className="small muted" style={{ marginBottom: 16 }}>
              Supervisor 正在撰寫報告，寫完後會逐句查核再定稿…
            </p>
            <div className="report-md streaming-refs">
              <Markdown source={syn.text} caret={p.status === 'running'} cite={(label) => <span className="ref plain">{label.slice(1)}</span>} />
            </div>
          </div>
        ) : (
          <div className="panel pad stack">
            <h1 className="sec-h">{p.status === 'running' ? '報告還沒寫好' : '這個專案沒有報告'}</h1>
            <p className="muted">
              {p.status === 'running'
                ? '所有子題完成、涵蓋率檢查過後，Supervisor 會開始撰寫，並逐句查核引用。'
                : p.status === 'stopped'
                  ? '研究在寫報告之前就停止了。已完成的子題可以在「進度」與「證據台」查看。'
                  : '研究沒有寫出報告。已完成的子題可以在「進度」與「證據台」查看。'}
            </p>
            <div className="plan-actions">
              <a className="btn" href={projectPath(p.projectId, 'run')}>
                看進度
              </a>
            </div>
            {state.history.length ? (
              <p className="small">
                上一版的報告：
                <button type="button" className="linkbtn" onClick={() => setShowVersion(state.history[state.history.length - 1].version)}>
                  第 {state.history[state.history.length - 1].version} 版
                </button>
              </p>
            ) : null}
            {showVersion !== null ? <Markdown source={state.history.find((h) => h.version === showVersion)?.report ?? ''} /> : null}
          </div>
        )}
      </main>
    );
  }

  const summary = doc.sections.find((s) => SUMMARY_HEADING.test(s.title)) ?? null;
  const hasOpenSection = doc.sections.some((s) => OPEN_HEADING.test(s.title));

  // A contested claim gets its side-by-side box once, after the first body block that cites it.
  const conflictAt = new Map<number, Claim>();
  {
    const seen = new Set<string>();
    for (const s of doc.sections) {
      if (s === summary) continue;
      for (const { block, index } of s.blocks) {
        for (const l of blockLabels(block)) {
          const c = resolve(l)?.claim;
          if (c?.status === 'contested' && !seen.has(c.claimId) && !conflictAt.has(index)) {
            seen.add(c.claimId);
            conflictAt.set(index, c);
          }
        }
      }
    }
  }

  const content = (b: Block, index: number): ReactNode => {
    const cite = citeFor(index);
    switch (b.t) {
      case 'h':
        return <h3 className="r-h3">{renderInline(b.c, cite)}</h3>;
      case 'table':
        return (
          <div className="rtable">
            <MdTable b={b} cite={cite} />
          </div>
        );
      case 'ul':
      case 'ol': {
        const Tag = b.t;
        const labelled = b.items.map((it) => leadLabel(it));
        return (
          <Tag className={'rlist' + (labelled.every(Boolean) ? ' labelled' : '')}>
            {b.items.map((it, i) => {
              const l = labelled[i];
              return (
                <li key={i}>
                  {l ? (
                    <>
                      <strong className="lbl">{l.label}</strong>
                      <span>{renderInline(l.rest, cite)}</span>
                    </>
                  ) : (
                    renderInline(it, cite)
                  )}
                </li>
              );
            })}
          </Tag>
        );
      }
      case 'p': {
        const bottom = boldParagraph(b);
        if (bottom) return <p className="bottomline">{renderInline(bottom, cite)}</p>;
        const take = leadLabel(b.c, TAKEAWAY);
        if (take)
          return (
            <div className="takeaway">
              <span className="tk">{take.label}</span>
              <p>{renderInline(take.rest, cite)}</p>
            </div>
          );
        return <p className="rtext">{renderInline(b.c, cite)}</p>;
      }
    }
  };

  const renderBlock = (b: Block, index: number): ReactNode => {
    const openRef = open?.block === index ? resolve(open.label) : null;
    const card =
      openRef && open ? <CiteCard refd={openRef} num={nums.get(open.label) ?? 0} idx={open.idx} setIdx={(i) => setOpen({ ...open, idx: i })} onClose={() => setOpen(null)} state={state} /> : null;
    const contested = conflictAt.get(index);
    if (!verify) {
      return (
        <Fragment key={index}>
          {content(b, index)}
          {card}
          {contested ? <ConflictBox claim={contested} /> : null}
        </Fragment>
      );
    }
    const labels = blockLabels(b);
    const s = labels.length ? strengthFor(labels) : null;
    return (
      <Fragment key={index}>
        <div className="rblock">
          <div className="txt">
            {content(b, index)}
            {card}
          </div>
          {s && s.strength !== 'none' ? (
            <aside className="margin" aria-label="這段的證據">
              <BarsFor s={s} size="lg" />
              <span>
                <strong className={'strength ' + s.strength}>{STRENGTH_LABEL[s.strength]}</strong>，{strengthLine(s)}
              </span>
              <span className="sub">
                {[s.latest ? `最新證據 ${s.latest}` : '', s.duplicates ? `另有 ${s.duplicates} 篇轉載已合併` : ''].filter(Boolean).join('，') || `${s.claims} 個主張`}
              </span>
              {s.strength === 'contested' ? (
                <a className="linkbtn" href={projectPath(p.projectId, 'evidence', { tab: 'conflicts' })}>
                  在證據台比對原文
                </a>
              ) : null}
            </aside>
          ) : null}
        </div>
        {contested ? <ConflictBox claim={contested} /> : null}
      </Fragment>
    );
  };

  const jump = (id: string) => (e: MouseEvent) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const tocStrength = (s: Section) => strengthFor(s.blocks.flatMap(({ block }) => blockLabels(block)));
  const prev = state.history[state.history.length - 1];
  const checked = ymd(syn.createdAt);
  const showLimits = !hasOpenSection && (syn.contradictions.length || syn.gaps.length || syn.followUps.length);

  return (
    <div className={'reader mode-' + mode}>
      <nav className="toc" aria-label="報告目錄">
        <h2>目錄</h2>
        <ol>
          {doc.sections.map((s) => {
            const st = verify ? tocStrength(s) : null;
            return (
              <li key={s.id}>
                <a href={'#' + s.id} onClick={jump(s.id)}>
                  <span>{s.title || '前言'}</span>
                  {st && st.strength !== 'none' ? <BarsFor s={st} /> : null}
                </a>
              </li>
            );
          })}
          {showLimits ? (
            <li>
              <a href="#limits" onClick={jump('limits')}>
                限制與未解衝突
              </a>
            </li>
          ) : null}
          <li>
            <a href="#sources" onClick={jump('sources')}>
              參考資料（{originals.length}）
            </a>
          </li>
          <li>
            <a href="#followup" onClick={jump('followup')}>
              追問{state.qa.length ? `（${state.qa.length}）` : ''}
            </a>
          </li>
        </ol>
        <div className="ver">
          <span>
            第 {version} 版，{checked}
          </span>
          {prev ? (
            <button type="button" className="linkbtn" style={{ textAlign: 'left' }} onClick={() => { setShowVersion(showVersion === prev.version ? null : prev.version); setTimeout(() => document.getElementById('versions')?.scrollIntoView({ behavior: 'smooth' }), 0); }}>
              與第 {prev.version} 版比較
            </button>
          ) : null}
          {p.status === 'completed' ? (
            <button type="button" className="linkbtn" style={{ textAlign: 'left' }} disabled={busy} onClick={() => void actions.rerun()}>
              用新資料重跑（增量）
            </button>
          ) : null}
        </div>
      </nav>

      <article className="paper article" ref={article} onMouseUp={onSelect} onKeyUp={onSelect} id="main">
        <header className="rhead">
          <p className="crumb">
            研究報告 <span aria-hidden="true">/</span> 第 {version} 版
          </p>
          <h1>{doc.title}</h1>
          {doc.dek ? <p className="dek">{renderInline(doc.dek, citeFor(-1))}</p> : null}
          {doc.title !== p.topic ? <p className="question">研究問題：{p.topic}</p> : null}
          <p className="byline">
            <span>God Eye Researcher</span>
            <span>{checked}</span>
            {p.brief?.depth ? <span>{DEPTH_NAME[p.brief.depth]}深度</span> : null}
            <span>
              {originals.length} 個來源、{publishers} 個獨立發布者
            </span>
            {p.brief?.audience ? <span>給{p.brief.audience}</span> : null}
          </p>
          <div className="rtools">
            <button type="button" className={'btn small' + (verify ? ' primary' : '')} aria-pressed={verify} onClick={() => setMode(verify ? 'read' : 'verify')}>
              {verify ? '回到閱讀模式' : '查證模式'}
            </button>
            <button type="button" className="btn small" onClick={() => download(`${p.projectId}-v${version}.md`, exportMarkdown(syn.text, nums, (l) => resolve(l), state.docs, checked))}>
              下載 Markdown
            </button>
            {!verify && syn.verification ? <span className="checkline">{checkLine(syn.verification)}</span> : null}
          </div>
          {verify ? (
            <>
              <MarkLegend />
              {syn.verification ? <VerificationBar v={syn.verification} /> : null}
            </>
          ) : null}
        </header>

        {version > 1 && syn.changes ? (
          <div className="banner update-note">
            第 {version} 版：只找 {p.since ?? '上一版'} 之後的資料，新增 {syn.changes.newClaims} 個主張、取代 {syn.changes.updatedClaims} 個舊主張。
          </div>
        ) : null}

        {doc.sections.map((s) => (
          <section key={s.id} id={s.id} className={'rsec' + (s === summary ? ' exec' : '')} aria-labelledby={s.title ? s.id + '-h' : undefined}>
            {s.title ? (
              <h2 id={s.id + '-h'} className="r-h">
                {s.title}
              </h2>
            ) : null}
            {s.blocks.map(({ block, index }) => renderBlock(block, index))}
          </section>
        ))}

        {showLimits ? (
          <section id="limits" className="rsec" aria-labelledby="limits-h">
            <h2 id="limits-h" className="r-h">
              限制與未解衝突
            </h2>
            {(
              [
                ['矛盾', syn.contradictions],
                ['缺口', syn.gaps],
                ['後續問題', syn.followUps],
              ] as const
            )
              .filter(([, l]) => l.length)
              .map(([h, l]) => (
                <div key={h}>
                  <h3 className="r-h3">{h}</h3>
                  <ul className="rlist">
                    {l.map((t, i) => (
                      <li key={i}>{renderInline(parseInline(t))}</li>
                    ))}
                  </ul>
                </div>
              ))}
          </section>
        ) : null}

        <section id="sources" className="rsec refs" aria-labelledby="src-h">
          <h2 id="src-h" className="r-h">
            參考資料
          </h2>
          <p className="refnote">
            資料查證日期：{checked}。共 {originals.length} 個來源、{publishers} 個獨立發布者{duplicates ? `；另有 ${duplicates} 篇轉載已合併` : ''}。
          </p>
          {verify ? <SourceList docs={state.docs} /> : <SourcesByKind docs={state.docs} />}
        </section>
      </article>

      <div className="reader-after">
        {state.history.length ? (
          <section id="versions" className="history-box" aria-label="較早的版本">
            <h2 className="sec-h">較早的版本</h2>
            {state.history
              .slice()
              .reverse()
              .map((h) => (
                <details key={h.version} open={showVersion === h.version} onToggle={(e) => (e.currentTarget.open ? setShowVersion(h.version) : showVersion === h.version && setShowVersion(null))}>
                  <summary>
                    第 {h.version} 版{h.createdAt ? `，${ymd(h.createdAt)}` : ''}
                  </summary>
                  <div className="report-md" style={{ marginTop: 12 }}>
                    <Markdown source={h.report} />
                  </div>
                </details>
              ))}
          </section>
        ) : null}

        <FollowUps state={state} actions={actions} busy={busy} selection={selection} clearSelection={() => setSelection('')} cite={qaCite} />
      </div>
    </div>
  );
}
