/*
 * 報告閱讀器: a table of contents with the strength of each section, the report in a serif reading
 * column with numbered citations, and an evidence margin beside every paragraph. A citation opens the
 * quote it rests on (and links to the highlighted passage on the page). Below: limits, sources, earlier
 * versions, and follow-up questions answered only from this report's claims.
 */
import { Fragment, useCallback, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Bars, BarsFor, MarkLegend } from '../components/Bars';
import { Markdown, renderInline, type CiteRenderer } from '../components/Markdown';
import { SourceList } from '../components/Sources';
import { useNow } from '../components/useNow';
import { CLAIM_STATUS_LABEL, STRENGTH_LABEL, pct, quoteHref, relTime, strengthLine, strengthOf, ymd, type StrengthSummary } from '../lib/evidence';
import { parseInline, parseMarkdown, type Block, type Inline } from '../lib/markdown';
import { navigate, projectPath } from '../router';
import { claimIndex, sourceTypeLabel, type ClaimRef, type ResearchState } from '../state';
import type { CitationRef, Claim, Verification } from '../types';
import type { ScreenProps } from '../workspace';

const SUMMARY_HEADING = /摘要|總結|summary/i;

function labelsIn(list: Inline[], out: string[] = []): string[] {
  for (const n of list) {
    if (n.t === 'cite') out.push(n.label);
    else if (n.t === 'b') labelsIn(n.c, out);
  }
  return out;
}

function blockLabels(b: Block): string[] {
  if ('items' in b) return b.items.flatMap((it) => labelsIn(it));
  return labelsIn(b.c);
}

function plainText(list: Inline[]): string {
  return list.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'a' ? n.v : n.t === 'b' ? plainText(n.c) : '')).join('');
}

interface Section {
  id: string;
  title: string;
  heading: Block | null;
  blocks: { block: Block; index: number }[];
}

function sectionsOf(blocks: Block[]): Section[] {
  const out: Section[] = [];
  let cur: Section = { id: 'sec-0', title: '', heading: null, blocks: [] };
  blocks.forEach((b, index) => {
    if (b.t === 'h' && b.level === 3) {
      if (cur.heading || cur.blocks.length) out.push(cur);
      cur = { id: `sec-${out.length + 1}`, title: plainText(b.c), heading: b, blocks: [] };
    } else {
      cur.blocks.push({ block: b, index });
    }
  });
  if (cur.heading || cur.blocks.length) out.push(cur);
  return out;
}

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

/* ---------------- citation card ---------------- */

interface OpenCite {
  block: number;
  label: string;
  idx: number;
}

function CiteCard({ refd, label, idx, setIdx, onClose, state }: { refd: ClaimRef; label: string; idx: number; setIdx: (i: number) => void; onClose: () => void; state: ResearchState }) {
  const c = refd.claim;
  const ev = c.evidence[Math.min(idx, c.evidence.length - 1)];
  const doc = state.docs.find((d) => d.docId === ev?.docId);
  const href = ev ? quoteHref(ev.url, ev.quote) : null;
  return (
    <div className="panel citecard rise" role="region" aria-label={`引用 ${label.slice(1)}`}>
      <div className="hd">
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

/* ---------------- the report ---------------- */

export function Report({ state, actions, busy }: ScreenProps) {
  const p = state.project!;
  const syn = state.synthesis;
  const { order, slots } = state;
  const claims = useMemo(() => claimIndex({ order, slots }), [order, slots]);
  const dates = useMemo(() => new Map(state.docs.map((d) => [d.docId, d.publishedDate])), [state.docs]);
  const [open, setOpen] = useState<OpenCite | null>(null);
  const [selection, setSelection] = useState('');
  const [showVersion, setShowVersion] = useState<number | null>(null);
  const article = useRef<HTMLElement>(null);

  const blocks = useMemo(() => (syn.status === 'ready' ? parseMarkdown(syn.text) : []), [syn.status, syn.text]);
  const sections = useMemo(() => sectionsOf(blocks), [blocks]);

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
    function CiteChip(label: string) {
      const ref = resolve(label);
      if (!ref) return <span className="cite plain">{label.slice(1)}</span>;
      const on = open?.block === blockIndex && open.label === label;
      return (
        <button
          type="button"
          className={'cite ' + ref.claim.status + (on ? ' on' : '')}
          aria-expanded={on}
          aria-label={`引用 ${label.slice(1)}：${CLAIM_STATUS_LABEL[ref.claim.status]}`}
          title={ref.claim.text}
          onClick={() => setOpen(on ? null : { block: blockIndex, label, idx: 0 })}
        >
          {label.slice(1)}
        </button>
      );
    };
  const qaCite = (citations: Record<string, CitationRef>): CiteRenderer =>
    function QaChip(label: string) {
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

  const publishers = new Set(state.docs.filter((d) => !d.duplicateOf).map((d) => d.publisher)).size;
  const version = syn.version || p.version || 1;

  if (syn.status !== 'ready') {
    return (
      <main className="page narrow" id="main">
        {syn.status === 'streaming' ? (
          <div className="panel streaming">
            <p className="small muted" style={{ marginBottom: 12 }}>
              Supervisor 正在撰寫報告，寫完後會逐句查核再定稿…
            </p>
            <Markdown source={syn.text} caret={p.status === 'running'} />
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

  const summary = sections.find((s) => SUMMARY_HEADING.test(s.title)) ?? null;
  const rest = sections.filter((s) => s !== summary);

  const renderBlock = (b: Block, index: number): ReactNode => {
    const labels = blockLabels(b);
    const cite = citeFor(index);
    const s = labels.length ? strengthFor(labels) : null;
    const content =
      b.t === 'p' ? (
        <p className="rtext">{renderInline(b.c, cite)}</p>
      ) : b.t === 'h' ? (
        <h3 className="r-h4">{renderInline(b.c, cite)}</h3>
      ) : (
        (() => {
          const Tag = b.t === 'ul' ? 'ul' : 'ol';
          return (
            <Tag className="rtext">
              {b.items.map((it, i) => (
                <li key={i}>{renderInline(it, cite)}</li>
              ))}
            </Tag>
          );
        })()
      );
    const openRef = open?.block === index ? resolve(open.label) : null;
    const contested = s?.strength === 'contested' ? labels.map((l) => resolve(l)?.claim).find((c) => c?.status === 'contested') : undefined;
    return (
      <Fragment key={index}>
        <div className="rblock">
          <div className="txt">
            {content}
            {openRef && open ? <CiteCard refd={openRef} label={open.label} idx={open.idx} setIdx={(i) => setOpen({ ...open, idx: i })} onClose={() => setOpen(null)} state={state} /> : null}
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

  const summaryItems = (s: Section): { inline: Inline[]; index: number }[] =>
    s.blocks.flatMap(({ block, index }) => {
      if (block.t === 'ul' || block.t === 'ol') return block.items.map((it) => ({ inline: it, index }));
      if (block.t === 'p') {
        // one line per sentence, so each statement carries its own mark
        const text = plainText(block.c).length > 0 ? block.c : [];
        const out: Inline[][] = [[]];
        for (const n of text) {
          if (n.t === 'text') {
            const parts = n.v.split(/(?<=[。！？!?])/u);
            parts.forEach((part, i) => {
              if (i > 0) out.push([]);
              if (part) out[out.length - 1].push({ t: 'text', v: part });
            });
          } else out[out.length - 1].push(n);
        }
        // a citation right after a sentence end belongs to that sentence
        for (let i = 1; i < out.length; i++) {
          while (out[i].length && out[i][0].t === 'cite') out[i - 1].push(out[i].shift()!);
        }
        return out.filter((x) => plainText(x).trim()).map((inline) => ({ inline, index }));
      }
      return [];
    });

  const tocStrength = (s: Section) => strengthFor(s.blocks.flatMap(({ block }) => blockLabels(block)));
  const prev = state.history[state.history.length - 1];

  return (
    <div className="reader">
      <nav className="toc" aria-label="報告目錄">
        <h2>目錄</h2>
        <ol>
          {sections.map((s) => {
            const st = tocStrength(s);
            return (
              <li key={s.id}>
                <a href={'#' + s.id} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
                  <span>{s === summary ? '執行摘要' : s.title || '前言'}</span>
                  {st.strength !== 'none' ? <BarsFor s={st} /> : null}
                </a>
              </li>
            );
          })}
          {syn.contradictions.length || syn.gaps.length ? (
            <li>
              <a href="#limits" onClick={(e) => { e.preventDefault(); document.getElementById('limits')?.scrollIntoView({ behavior: 'smooth' }); }}>
                限制與未解衝突
              </a>
            </li>
          ) : null}
          <li>
            <a href="#sources" onClick={(e) => { e.preventDefault(); document.getElementById('sources')?.scrollIntoView({ behavior: 'smooth' }); }}>
              來源（{state.docs.length}）
            </a>
          </li>
          <li>
            <a href="#followup" onClick={(e) => { e.preventDefault(); document.getElementById('followup')?.scrollIntoView({ behavior: 'smooth' }); }}>
              追問{state.qa.length ? `（${state.qa.length}）` : ''}
            </a>
          </li>
        </ol>
        <div className="ver">
          <span>
            第 {version} 版，{ymd(syn.createdAt)}
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

      <article className="article" ref={article} onMouseUp={onSelect} onKeyUp={onSelect} id="main">
        <header>
          <h1>{p.topic}</h1>
          <div className="meta-row">
            <span>{ymd(syn.createdAt)} 完成</span>
            <span>
              {state.docs.length} 個來源，其中 {publishers} 個獨立發布者
            </span>
            {p.brief?.audience ? <span>給{p.brief.audience}</span> : null}
          </div>
          <MarkLegend />
        </header>
        {version > 1 && syn.changes ? (
          <div className="banner update-note">
            第 {version} 版：只找 {p.since ?? '上一版'} 之後的資料，新增 {syn.changes.newClaims} 個主張、取代 {syn.changes.updatedClaims} 個舊主張。
          </div>
        ) : null}
        {syn.verification ? <VerificationBar v={syn.verification} /> : null}

        {summary ? (
          <section id={summary.id} className="panel summary" aria-labelledby="sum-h">
            <h2 id="sum-h">執行摘要</h2>
            <ol>
              {summaryItems(summary).map(({ inline, index }, i) => {
                const s = strengthFor(labelsIn(inline));
                return (
                  <li key={i}>
                    {s.strength !== 'none' ? <BarsFor s={s} size="md" /> : <Bars strength="none" size="md" label="沒有引用" />}
                    <span>{renderInline(inline, citeFor(index))}</span>
                  </li>
                );
              })}
            </ol>
            {open && summary.blocks.some((b) => b.index === open.block) && resolve(open.label) ? (
              <CiteCard refd={resolve(open.label)!} label={open.label} idx={open.idx} setIdx={(i) => setOpen({ ...open, idx: i })} onClose={() => setOpen(null)} state={state} />
            ) : null}
          </section>
        ) : null}

        {rest.map((s) => (
          <section key={s.id} className="stack-lg" aria-labelledby={s.heading ? s.id : undefined}>
            {s.heading ? (
              <h2 id={s.id} className="r-h">
                {s.title}
              </h2>
            ) : null}
            {s.blocks.map(({ block, index }) => renderBlock(block, index))}
          </section>
        ))}

        {syn.contradictions.length || syn.gaps.length || syn.followUps.length ? (
          <section id="limits" className="panel lists" aria-label="限制與未解衝突">
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
                  <h3>{h}</h3>
                  <ul>
                    {l.map((t, i) => (
                      <li key={i}>{renderInline(parseInline(t))}</li>
                    ))}
                  </ul>
                </div>
              ))}
          </section>
        ) : null}

        <section id="sources" className="stack" aria-labelledby="src-h" style={{ maxWidth: 720 }}>
          <h2 id="src-h" className="r-h">
            來源
          </h2>
          <SourceList docs={state.docs} />
        </section>

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
                  <div style={{ marginTop: 12 }}>
                    <Markdown source={h.report} />
                  </div>
                </details>
              ))}
          </section>
        ) : null}

        <FollowUps state={state} actions={actions} busy={busy} selection={selection} clearSelection={() => setSelection('')} cite={qaCite} />
      </article>
    </div>
  );
}
