/*
 * 證據台: every atomic claim of the project in one table, filterable by status, sub-question, source
 * type and evidence year; the selected claim's neighbourhood (sources and entities); a queue of what
 * needs the reader's judgement; contested claims side by side; the topic map; and all sources.
 */
import { useMemo, useState } from 'react';
import { Bars } from '../components/Bars';
import { EvidenceList } from '../components/Evidence';
import { Graph, GraphLegend } from '../components/Graph';
import { SourceList } from '../components/Sources';
import { CLAIM_STATUS_LABEL, TYPE_GROUP_LABEL, typeGroup } from '../lib/evidence';
import { navigate, projectPath } from '../router';
import { claimsOf, findingLabel, type ResearchState } from '../state';
import type { Claim, ClaimStatus } from '../types';
import type { ScreenProps } from '../workspace';

type Tab = 'claims' | 'conflicts' | 'map' | 'sources';
const STATUSES: ClaimStatus[] = ['corroborated', 'contested', 'asserted', 'superseded'];

interface Row {
  claim: Claim;
  findingId: string;
  label: string;
  latest: string | null;
  groups: Set<string>;
  haystack: string;
}

function rowsOf(state: ResearchState): Row[] {
  const dates = new Map(state.docs.map((d) => [d.docId, d.publishedDate]));
  const rows: Row[] = [];
  for (const id of state.order) {
    const f = state.slots[id]?.finding;
    for (const c of claimsOf(f)) {
      const ds = c.evidence.map((e) => dates.get(e.docId)).filter((d): d is string => !!d);
      rows.push({
        claim: c,
        findingId: id,
        label: findingLabel(state, id),
        latest: ds.length ? ds.sort().slice(-1)[0].slice(0, 7) : null,
        groups: new Set(c.evidence.map((e) => typeGroup(e.sourceType))),
        haystack: [c.text, ...c.evidence.map((e) => `${e.publisher} ${e.title} ${e.quote}`), ...(f?.entities.map((e) => e.name) ?? [])].join(' ').toLowerCase(),
      });
    }
  }
  return rows;
}

function csv(rows: Row[]): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['claimId', '主張', '狀態', '支持', '反對', '獨立來源', '最新證據', '子題', '來源'];
  const lines = rows.map((r) =>
    [r.claim.claimId, r.claim.text, CLAIM_STATUS_LABEL[r.claim.status], r.claim.supporting, r.claim.contradicting, r.claim.independentSources, r.latest ?? '', r.label, r.claim.evidence.map((e) => e.url).join(' ')].map(esc).join(','),
  );
  return '﻿' + [head.map(esc).join(','), ...lines].join('\n');
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The selected claim at the centre, its sources around it and the entities of its finding below. */
function Neighbourhood({ row, state }: { row: Row; state: ResearchState }) {
  const W = 300;
  const H = 210;
  const pubs = [...new Map(row.claim.evidence.map((e) => [e.publisher || e.url, e])).values()].slice(0, 4);
  const ents = (state.slots[row.findingId]?.finding?.entities ?? []).slice(0, 4);
  const cx = W / 2;
  const cy = 92;
  const at = (i: number, n: number, y: number) => ({ x: n === 1 ? cx : 40 + (i * (W - 80)) / Math.max(1, n - 1), y });
  return (
    <div className="mini-graph">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`主張連到 ${pubs.length} 個來源與 ${ents.length} 個實體`}>
        {pubs.map((e, i) => {
          const p = at(i, pubs.length, 24);
          return <line key={'l' + i} x1={cx} y1={cy} x2={p.x} y2={p.y + 10} stroke={e.stance === 'contradicts' ? 'var(--contest)' : 'var(--line-strong)'} strokeWidth="1.2" />;
        })}
        {ents.map((_e, i) => {
          const p = at(i, ents.length, 172);
          return <line key={'m' + i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="var(--line-strong)" strokeWidth="1.2" />;
        })}
        {pubs.map((e, i) => {
          const p = at(i, pubs.length, 24);
          const label = (e.publisher || '來源').slice(0, 14);
          return (
            <g key={'p' + i}>
              <rect x={p.x - 42} y={p.y - 2} width="84" height="22" rx="4" fill="var(--surface)" stroke={e.stance === 'contradicts' ? 'var(--contest)' : 'var(--ink-2)'} />
              <text x={p.x} y={p.y + 13} textAnchor="middle">
                {label}
              </text>
            </g>
          );
        })}
        <rect x={cx - 74} y={cy - 18} width="148" height="36" rx="6" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1.5" />
        <text x={cx} y={cy - 2} textAnchor="middle" style={{ fontWeight: 600, fill: 'var(--ink)' }}>
          {Array.from(row.claim.text).slice(0, 13).join('')}
          {Array.from(row.claim.text).length > 13 ? '…' : ''}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle">
          選取的主張
        </text>
        {ents.map((e, i) => {
          const p = at(i, ents.length, 172);
          return (
            <g key={'e' + i}>
              <circle cx={p.x} cy={p.y} r="15" fill="var(--surface)" stroke="var(--ink-2)" />
              <text x={p.x} y={p.y + 28} textAnchor="middle">
                {e.name.slice(0, 8)}
              </text>
            </g>
          );
        })}
      </svg>
      <ul className="marks" style={{ marginTop: 6 }}>
        <li>▭ 來源</li>
        <li>○ 實體</li>
        <li style={{ color: 'var(--contest)' }}>— 反對的來源</li>
      </ul>
    </div>
  );
}

function Toggle({ on, onChange, label, count }: { on: boolean; onChange: () => void; label: string; count: number }) {
  return (
    <li>
      <label>
        <input type="checkbox" checked={on} onChange={onChange} />
        <span className="lbl" title={label}>
          {label}
        </span>
        <span className="c">{count}</span>
      </label>
    </li>
  );
}

export function EvidenceDesk({ state, actions, params }: ScreenProps & { params: Record<string, string> }) {
  const p = state.project!;
  const { order, slots, docs } = state;
  const rows = useMemo(() => rowsOf({ ...state, order, slots, docs }), [order, slots, docs]); // the rest of state does not change rows
  const tab: Tab = (['claims', 'conflicts', 'map', 'sources'] as Tab[]).includes(params.tab as Tab) ? (params.tab as Tab) : 'claims';
  const [q, setQ] = useState(params.q ?? '');
  const [statuses, setStatuses] = useState<Set<string>>(() => new Set(params.status ? [params.status] : ['corroborated', 'contested', 'asserted', 'superseded']));
  const [findings, setFindings] = useState<Set<string> | null>(() => (params.finding ? new Set([params.finding]) : null));
  const [groups, setGroups] = useState<Set<string>>(() => new Set(['primary', 'research', 'news', 'other']));
  const [years, setYears] = useState<Set<string> | null>(null);
  const [sortBy, setSortBy] = useState<'sources' | 'latest'>('sources');
  const selected = params.claim ?? null;
  const setParam = (patch: Record<string, string | null>) => {
    const next: Record<string, string> = { ...params };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    navigate(projectPath(p.projectId, 'evidence', next), true);
  };

  const fids = state.order.filter((id) => rows.some((r) => r.findingId === id));
  const allYears = [...new Set(rows.map((r) => r.latest?.slice(0, 4)).filter((y): y is string => !!y))].sort();
  const query = q.trim().toLowerCase();
  const visible = rows
    .filter((r) => statuses.has(r.claim.status))
    .filter((r) => !findings || findings.has(r.findingId))
    .filter((r) => [...r.groups].some((g) => groups.has(g)))
    .filter((r) => !years || (r.latest && years.has(r.latest.slice(0, 4))))
    .filter((r) => !query || r.haystack.includes(query))
    .sort((a, b) =>
      sortBy === 'latest'
        ? (b.latest ?? '').localeCompare(a.latest ?? '')
        : Number(a.claim.status === 'superseded') - Number(b.claim.status === 'superseded') || b.claim.independentSources - a.claim.independentSources,
    );
  const sel = rows.find((r) => r.claim.claimId === selected) ?? null;
  const contested = rows.filter((r) => r.claim.status === 'contested');
  const superseded = rows.filter((r) => r.claim.status === 'superseded');
  const count = (pred: (r: Row) => boolean) => rows.filter(pred).length;
  const flip = (set: Set<string>, v: string) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };
  const tabs: [Tab, string][] = [
    ['claims', `主張 ${rows.filter((r) => r.claim.status !== 'superseded').length}`],
    ['conflicts', `衝突 ${contested.length}`],
    ['map', '主題地圖'],
    ['sources', `來源 ${state.docs.length}`],
  ];
  const questions = Object.fromEntries(state.order.map((id) => [id, state.slots[id]?.question ?? '']));

  return (
    <>
      <div className="deskhead">
        <div className="inner">
          <div className="row">
            <div>
              <h1>證據台</h1>
              <p className="muted">{p.topic}。每一列是一個原子主張，背後都有原文段落。</p>
            </div>
            <label className="search">
              搜尋主張、實體或來源
              <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="例如：邊緣推論" />
            </label>
          </div>
          <div className="tabs" role="tablist" aria-label="證據台">
            {tabs.map(([t, label]) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setParam({ tab: t === 'claims' ? null : t })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'claims' ? (
        <main className="deskbody" id="main">
          <aside className="facets" aria-label="篩選">
            <section>
              <h3>狀態</h3>
              <ul className="facet">
                {STATUSES.map((s) => (
                  <Toggle key={s} on={statuses.has(s)} onChange={() => setStatuses(flip(statuses, s))} label={CLAIM_STATUS_LABEL[s]} count={count((r) => r.claim.status === s)} />
                ))}
              </ul>
            </section>
            <section>
              <h3>子題</h3>
              <ul className="facet">
                {fids.map((id) => (
                  <Toggle
                    key={id}
                    on={!findings || findings.has(id)}
                    onChange={() => setFindings(flip(findings ?? new Set(fids), id))}
                    label={`${findingLabel(state, id)} ${state.slots[id]?.question ?? ''}`}
                    count={count((r) => r.findingId === id)}
                  />
                ))}
              </ul>
            </section>
            <section>
              <h3>來源類型</h3>
              <ul className="facet">
                {(['primary', 'research', 'news', 'other'] as const).map((g) => (
                  <Toggle key={g} on={groups.has(g)} onChange={() => setGroups(flip(groups, g))} label={TYPE_GROUP_LABEL[g]} count={count((r) => r.groups.has(g))} />
                ))}
              </ul>
            </section>
            {allYears.length ? (
              <section>
                <h3>證據時間</h3>
                <div className="choices">
                  {allYears.map((y) => (
                    <button key={y} type="button" className="choice" style={{ minHeight: 36 }} aria-pressed={!years || years.has(y)} onClick={() => setYears(flip(years ?? new Set(allYears), y))}>
                      {y}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </aside>

          <section aria-label="主張列表">
            <div className="tablebar">
              <span>
                {query ? `符合「${q.trim()}」的主張 ${visible.length} 個` : `顯示 ${visible.length} 個主張`}，依{sortBy === 'sources' ? '獨立來源數' : '最新證據'}排序
              </span>
              <button type="button" className="btn small" onClick={() => download(`${p.projectId}-claims.csv`, csv(visible))} disabled={!visible.length}>
                匯出 CSV
              </button>
            </div>
            <div className="panel ctable-wrap">
              <table className="ctable">
                <thead>
                  <tr>
                    <th scope="col">主張</th>
                    <th scope="col">狀態</th>
                    <th scope="col" className="n">
                      支持
                    </th>
                    <th scope="col" className="n">
                      反對
                    </th>
                    <th scope="col" className="n">
                      <button type="button" onClick={() => setSortBy('sources')} aria-pressed={sortBy === 'sources'}>
                        獨立來源{sortBy === 'sources' ? ' ↓' : ''}
                      </button>
                    </th>
                    <th scope="col">
                      <button type="button" onClick={() => setSortBy('latest')} aria-pressed={sortBy === 'latest'}>
                        最新證據{sortBy === 'latest' ? ' ↓' : ''}
                      </button>
                    </th>
                    <th scope="col">子題</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr
                      key={r.claim.claimId}
                      className={r.claim.status}
                      aria-selected={selected === r.claim.claimId}
                      tabIndex={0}
                      onClick={() => setParam({ claim: selected === r.claim.claimId ? null : r.claim.claimId })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setParam({ claim: r.claim.claimId });
                        }
                      }}
                    >
                      <td className="ct">
                        {r.claim.text}
                        {r.claim.status === 'superseded' ? <small>已被較新的證據取代</small> : r.claim.updates ? <small>取代了一個較舊的主張</small> : null}
                      </td>
                      <td>
                        <span className={'stat strength ' + r.claim.status}>
                          <Bars strength={r.claim.status} support={1} against={1} label="" />
                          {CLAIM_STATUS_LABEL[r.claim.status]}
                        </span>
                      </td>
                      <td className="n">{r.claim.supporting}</td>
                      <td className="n">{r.claim.contradicting}</td>
                      <td className="n">{r.claim.independentSources}</td>
                      <td className="num">{r.latest ?? '—'}</td>
                      <td>{r.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!visible.length ? <p className="empty">{rows.length ? '沒有符合篩選的主張。' : '這個專案還沒有查證過的主張。'}</p> : null}
            </div>
          </section>

          <aside className="rcol" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {sel ? (
              <section className="panel sidepanel" aria-labelledby="sel-h">
                <h2 id="sel-h">這個主張連到哪裡</h2>
                <Neighbourhood row={sel} state={state} />
                <p className="claim-t">{sel.claim.text}</p>
                <EvidenceList evidence={sel.claim.evidence} />
                <a className="linkbtn" href={projectPath(p.projectId, 'run') + ''} onClick={(e) => { e.preventDefault(); navigate(projectPath(p.projectId, 'run')); setTimeout(() => document.getElementById('card-' + sel.findingId)?.scrollIntoView({ block: 'start' }), 300); }}>
                  看 {sel.label} 這則發現
                </a>
              </section>
            ) : (
              <section className="panel sidepanel">
                <h2>選一個主張</h2>
                <p className="small muted">點表格中的一列，看它的原文引述、來源與相關實體。</p>
              </section>
            )}
            <section className="panel sidepanel" aria-labelledby="judge-h">
              <h2 id="judge-h">需要你判斷</h2>
              <div className="queue">
                {contested.slice(0, 4).map((r) => (
                  <div className="item" key={r.claim.claimId}>
                    <span className="k">衝突：{r.claim.supporting} 支持、{r.claim.contradicting} 反對</span>
                    <span>「{r.claim.text}」的來源說法不同。報告會並列兩種說法，不替你選邊。</span>
                    <span style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <button type="button" className="linkbtn" onClick={() => setParam({ tab: 'conflicts', claim: r.claim.claimId })}>
                        比對原文
                      </button>
                      <a className="linkbtn" href={projectPath(p.projectId, 'report')}>
                        在報告中查看
                      </a>
                    </span>
                  </div>
                ))}
                {superseded.slice(0, 3).map((r) => (
                  <div className="item" key={r.claim.claimId}>
                    <span className="k done">已自動處理：時效</span>
                    <span>「{r.claim.text}」被較新的證據取代，保留在歷史中。</span>
                  </div>
                ))}
                {!contested.length && !superseded.length ? <p className="small muted">目前沒有需要你判斷的衝突。</p> : null}
              </div>
            </section>
          </aside>
        </main>
      ) : null}

      {tab === 'conflicts' ? (
        <main className="deskbody full" id="main">
          <div className="conflicts">
            {state.synthesis.contradictions.length ? (
              <div className="panel pad stack">
                <h2 className="sec-h">Supervisor 整理的矛盾</h2>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {state.synthesis.contradictions.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {contested.length ? (
              contested.map((r) => {
                const pro = r.claim.evidence.filter((e) => e.stance !== 'contradicts');
                const con = r.claim.evidence.filter((e) => e.stance === 'contradicts');
                return (
                  <section key={r.claim.claimId} className={'panel pad stack' + (selected === r.claim.claimId ? ' hl' : '')} style={selected === r.claim.claimId ? { borderColor: 'var(--accent)' } : undefined}>
                    <p className="small muted">
                      {r.label} {state.slots[r.findingId]?.question}
                    </p>
                    <h2 className="sec-h">{r.claim.text}</h2>
                    <div className="sides">
                      <div className="side" style={{ background: 'var(--accent-soft)' }}>
                        <span className="k">支持（{pro.length}）</span>
                        <EvidenceList evidence={pro} />
                      </div>
                      <div className="side" style={{ background: 'var(--contest-soft)' }}>
                        <span className="k">反對（{con.length}）</span>
                        <EvidenceList evidence={con} />
                      </div>
                    </div>
                  </section>
                );
              })
            ) : (
              <p className="panel empty">沒有來源互相矛盾的主張。</p>
            )}
          </div>
        </main>
      ) : null}

      {tab === 'map' ? (
        <main className="deskbody full" id="main">
          <section className="panel pad graph" aria-label="主題地圖" style={{ maxWidth: 980 }}>
            <p className="small muted" style={{ marginBottom: 8 }}>
              方塊是子題的發現，圓點是它們提到的實體。點實體會在「進度」標示提到它的發現。
            </p>
            <Graph
              nodes={state.nodes}
              edges={state.edges}
              order={state.order}
              questions={questions}
              highlight={state.highlight}
              onEntity={(id) => actions.highlight(id)}
              onFinding={(id) => {
                navigate(projectPath(p.projectId, 'run'));
                setTimeout(() => document.getElementById('card-' + id)?.scrollIntoView({ block: 'start' }), 300);
              }}
            />
            <GraphLegend edges={state.edges} />
          </section>
        </main>
      ) : null}

      {tab === 'sources' ? (
        <main className="deskbody full" id="main">
          <section className="panel pad" aria-label="來源" style={{ maxWidth: 980 }}>
            <SourceList docs={state.docs} preview={1000} />
          </section>
        </main>
      ) : null}
    </>
  );
}
