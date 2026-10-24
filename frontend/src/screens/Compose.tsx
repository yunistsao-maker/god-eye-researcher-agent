/*
 * 新研究與計畫: the question, three quick choices (reader, time range, what to cover), depth and source
 * preferences on the left; the plan on the right. "產生計畫" asks the supervisor for a plan (the project
 * becomes a draft); the user edits it and starts the research with exactly that plan.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { SupervisorLine } from '../components/Activity';
import type { Brief, DataShape, Depth, Requirement } from '../types';
import type { ScreenProps } from '../workspace';

const AUDIENCES = ['技術團隊', '管理層決策', '客戶提案'] as const;
const RANGES: { label: string; months: number | null }[] = [
  { label: '近 12 個月', months: 12 },
  { label: '近 3 年', months: 36 },
  { label: '不限', months: null },
];
const DEPTH_INFO: Record<Depth, { name: string; text: string; reads: number; minutesPerSub: number; fixed: number }> = {
  quick: { name: '快速', text: '2–3 個子題、不做補充研究，約 3–5 分鐘，適合查證單一事實', reads: 4, minutesPerSub: 0.8, fixed: 1.5 },
  standard: { name: '標準', text: '3–5 個子題平行研究、補充一輪，約 10–15 分鐘，適合比較與現況盤點', reads: 8, minutesPerSub: 1.8, fixed: 4 },
  deep: { name: '深入', text: '4–7 個子題、補充兩輪，約 25–40 分鐘，適合完整的產業研究', reads: 12, minutesPerSub: 3.2, fixed: 8 },
};
const SHAPES: { v: DataShape; label: string }[] = [
  { v: 'list', label: '文字重點' },
  { v: 'comparison', label: '比較表' },
  { v: 'timeline', label: '時間軸' },
  { v: 'metrics', label: '數字' },
];
const SUGGESTED_DOMAINS = ['gov.tw', 'mops.twse.com.tw', 'arxiv.org'];

interface Item {
  key: string;
  question: string;
  dataShape: DataShape;
}
interface Aspect {
  text: string;
  on: boolean;
}

let keySeq = 0;
const nextKey = () => 'k' + ++keySeq;

function startDateFor(months: number | null): string | undefined {
  if (months === null) return undefined;
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function rangeOf(startDate: string | undefined): number | null {
  if (!startDate) return null;
  const months = (Date.now() - Date.parse(startDate)) / (30.4 * 86400_000);
  return months < 18 ? 12 : 36;
}

function cleanDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
}

export function Compose({ state, config, actions, busy, from, fresh = false }: ScreenProps & { from?: string; fresh?: boolean }) {
  // #/new starts from a blank form even when a draft is open; #/p/{id}/plan edits that draft.
  const p = fresh ? null : state.project;
  const draft = p?.status === 'draft' ? p : null;
  const parent = from ? state.projects.find((x) => x.projectId === from) : undefined;

  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState<string>('');
  const [months, setMonths] = useState<number | null>(36);
  const [depth, setDepth] = useState<Depth>('standard');
  const [include, setInclude] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [aspects, setAspects] = useState<Aspect[]>([]);
  const [newAspect, setNewAspect] = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [newExclude, setNewExclude] = useState('');
  const [notify, setNotify] = useState(false);
  const [planFor, setPlanFor] = useState('');   // the question + settings the current plan was made for
  const loadedFor = useRef<string | null>(null);
  const loadedSig = useRef<string | null>(null); // the signature of a draft loaded from the backend

  // Load the open draft (or the project being re-researched) once.
  useEffect(() => {
    const id = draft?.projectId ?? (parent ? 'from:' + parent.projectId : 'new');
    if (loadedFor.current === id) return;
    loadedFor.current = id;
    const src = draft ?? parent;
    if (!src) return;
    if (draft) loadedSig.current = signature(draft.topic, draft.brief ?? {});
    setTopic(src.topic);
    const b = src.brief ?? {};
    setAudience(b.audience ?? '');
    setMonths(b.startDate ? rangeOf(b.startDate) : src.brief ? null : 36);
    setDepth(b.depth ?? 'standard');
    setInclude(b.includeDomains ?? []);
    setExclude(b.excludeDomains ?? []);
    setNotes(b.notes ?? '');
    setNotify(!!src.notify);
  }, [draft, parent]);

  // A newly proposed plan replaces the editor's items (our own saved edits come back as by: user).
  const proposal = fresh ? null : state.proposal;
  useEffect(() => {
    if (!proposal) return;
    if (proposal.by === 'user' && items.length) return;
    setItems(proposal.subQuestions.map((q) => ({ key: nextKey(), question: q.question, dataShape: q.dataShape })));
    setAspects(proposal.requirements.map((r) => ({ text: r.text, on: true })));
    // A draft's proposal arrives with the draft itself, before the form state above is committed.
    setPlanFor(loadedSig.current ?? signature(topic, briefNow()));
    loadedSig.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal]);

  function briefNow(): Brief {
    const b: Brief = { depth };
    if (audience) b.audience = audience;
    const sd = startDateFor(months);
    if (sd) b.startDate = sd;
    if (include.length) b.includeDomains = include;
    if (exclude.length) b.excludeDomains = exclude;
    if (notes.trim()) b.notes = notes.trim();
    return b;
  }
  const brief = briefNow();
  const planning = fresh ? 'idle' : state.planning.status;
  const showPlan = planning === 'ready' || !!proposal;
  const hasPlan = showPlan && items.length > 0;
  const stale = hasPlan && planFor !== '' && planFor !== signature(topic, brief);
  const topicOk = topic.trim().length >= 3 && topic.trim().length <= 300;
  const requirements: Requirement[] = aspects.filter((a) => a.on && a.text.trim().length >= 3).map((a, i) => ({ id: `q${i + 1}`, text: a.text.trim() }));
  const plan = { topic: topic.trim(), brief, subQuestions: items.filter((i) => i.question.trim().length >= 3).map((i) => ({ question: i.question.trim(), dataShape: i.dataShape })), requirements };

  const est = useMemo(() => {
    const info = DEPTH_INFO[depth];
    const n = Math.max(1, items.length || (depth === 'quick' ? 3 : depth === 'deep' ? 6 : 4));
    const rounds = depth === 'quick' ? 1 : depth === 'deep' ? 1.6 : 1.35;
    const low = Math.round(n * info.reads * 0.6 * rounds);
    const high = Math.round(n * info.reads * rounds);
    const minutes = Math.round(info.fixed + n * info.minutesPerSub * rounds);
    return { sources: `${low}–${high} 篇`, minutes: `約 ${minutes} 分鐘`, subs: n };
  }, [depth, items.length]);

  const move = (i: number, d: -1 | 1) =>
    setItems((list) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return list;
      const copy = list.slice();
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  const addDomain = (e: FormEvent, value: string, set: (v: string[]) => void, list: string[], reset: () => void) => {
    e.preventDefault();
    const d = cleanDomain(value);
    if (d && d.includes('.') && !list.includes(d)) set([...list, d]);
    reset();
  };

  const generate = () => {
    if (!topicOk) return;
    setPlanFor(signature(topic, brief));
    loadedSig.current = null;
    void actions.proposePlan(topic.trim(), brief, parent?.projectId ?? draft?.parentProjectId ?? null);
  };
  const start = async () => {
    if (!topicOk) return;
    if (hasPlan && plan.subQuestions.length) await actions.startPlan(plan);
    else await actions.startDirect(topic.trim(), brief, parent?.projectId ?? null);
    if (notify) void actions.setNotify(true);
  };

  return (
    <main className="page compose" id="main">
      <section className="ask" aria-labelledby="ask-title">
        <div className="hero">
          <h1 id="ask-title">你想研究什麼？</h1>
          <p>像交代給一位資深分析師那樣寫下問題。寫得越具體，右邊的計畫就越準。</p>
          {parent ? <p className="small">以「{parent.topic}」為基礎重新研究，會帶入它已完成的發現。</p> : null}
        </div>

        <div className="stack">
          <label htmlFor="question" className="field-label">
            研究問題
          </label>
          <textarea
            id="question"
            className="textarea"
            rows={4}
            value={topic}
            maxLength={300}
            placeholder="例如：台灣電子製造業導入 AI 視覺檢測的現況如何？成本結構與投資回收期大概落在哪裡？主要的導入障礙是什麼？"
            onChange={(e) => setTopic(e.target.value)}
          />
          <span className="hint">{Array.from(topic).length}/300</span>
        </div>

        <div className="panel pad stack-lg">
          <div className="confirm-hd">
            <h2>開始前先確認三件事</h2>
            <button
              type="button"
              className="linkbtn"
              onClick={() => {
                setAudience('');
                setMonths(null);
                setAspects((a) => a.map((x) => ({ ...x, on: true })));
              }}
            >
              跳過，全部納入
            </button>
          </div>
          <fieldset>
            <legend>報告主要給誰看？</legend>
            <div className="choices">
              {AUDIENCES.map((a) => (
                <button key={a} type="button" className="choice" aria-pressed={audience === a} onClick={() => setAudience(audience === a ? '' : a)}>
                  {a}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>資料時間範圍？</legend>
            <div className="choices">
              {RANGES.map((r) => (
                <button key={r.label} type="button" className="choice" aria-pressed={months === r.months} onClick={() => setMonths(r.months)}>
                  {r.label}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="aspects">
            <legend>要涵蓋哪些面向？可複選</legend>
            {aspects.length ? (
              <div className="choices">
                {aspects.map((a, i) => (
                  <button
                    key={a.text + i}
                    type="button"
                    className="choice"
                    aria-pressed={a.on}
                    onClick={() => setAspects((list) => list.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))}
                  >
                    {a.text}
                  </button>
                ))}
              </div>
            ) : (
              <p className="hint">產生計畫後，這裡會列出計畫要涵蓋的面向；也可以先自己加。</p>
            )}
            <form
              className="domain-add"
              style={{ marginTop: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                const t = newAspect.trim();
                if (t.length >= 3 && aspects.length < 12) setAspects((a) => [...a, { text: t.slice(0, 120), on: true }]);
                setNewAspect('');
              }}
            >
              <label className="sr-only" htmlFor="aspect">
                新增面向
              </label>
              <input id="aspect" className="input" value={newAspect} placeholder="新增面向，例如：法規與標準" onChange={(e) => setNewAspect(e.target.value)} />
              <button className="btn small" type="submit" disabled={newAspect.trim().length < 3}>
                加入
              </button>
            </form>
          </fieldset>
        </div>

        <fieldset className="stack">
          <legend className="sec-h">研究深度</legend>
          <div className="depths">
            {(Object.keys(DEPTH_INFO) as Depth[]).map((d) => (
              <button key={d} type="button" className="depth" aria-pressed={depth === d} onClick={() => setDepth(d)}>
                <b>{DEPTH_INFO[d].name}</b>
                <span>{DEPTH_INFO[d].text}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <section className="stack" aria-labelledby="prefs-h">
          <h2 id="prefs-h" className="sec-h">
            來源偏好
          </h2>
          <div className="prefs">
            <span className="k">優先</span>
            <div className="v">
              {include.map((d) => (
                <span key={d} className="chip">
                  {d}
                  <button type="button" aria-label={'移除 ' + d} onClick={() => setInclude(include.filter((x) => x !== d))}>
                    ×
                  </button>
                </span>
              ))}
              {SUGGESTED_DOMAINS.filter((d) => !include.includes(d)).map((d) => (
                <button key={d} type="button" className="chip neutral" style={{ border: 0 }} onClick={() => setInclude([...include, d])}>
                  + {d}
                </button>
              ))}
              <form className="domain-add" onSubmit={(e) => addDomain(e, newDomain, setInclude, include, () => setNewDomain(''))}>
                <label className="sr-only" htmlFor="inc">
                  新增優先網域
                </label>
                <input id="inc" className="input" placeholder="新增網域" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} />
              </form>
            </div>
            <span className="k">排除</span>
            <div className="v">
              <span className="chip neutral">內容農場與 SEO 文章（部署預設）</span>
              {exclude.map((d) => (
                <span key={d} className="chip warn">
                  {d}
                  <button type="button" aria-label={'移除 ' + d} onClick={() => setExclude(exclude.filter((x) => x !== d))}>
                    ×
                  </button>
                </span>
              ))}
              <form className="domain-add" onSubmit={(e) => addDomain(e, newExclude, setExclude, exclude, () => setNewExclude(''))}>
                <label className="sr-only" htmlFor="exc">
                  新增排除網域
                </label>
                <input id="exc" className="input" placeholder="排除網域" value={newExclude} onChange={(e) => setNewExclude(e.target.value)} />
              </form>
            </div>
            <label className="k" htmlFor="notes">
              其他要求
            </label>
            <input id="notes" className="input" maxLength={1000} placeholder="選填，例如：多看半導體封測，少看 PCB" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <p className="hint">語言：繁體中文與英文來源都會搜尋，報告以問題的語言撰寫。</p>
        </section>
      </section>

      <aside className="plan-col" aria-labelledby="plan-title">
        <div className="panel planbox">
          <div className="stack">
            <h2 id="plan-title">研究計畫</h2>
            <p className="muted small">{hasPlan ? '依你的問題產生。可以改寫、調整順序、刪除或新增子題。' : '依你的問題與設定產生；產生後可以先修改再開始。'}</p>
          </div>

          {planning === 'drafting' ? (
            <div className="plan-wait" aria-busy="true">
              <SupervisorLine agent={state.agents.supervisor} running />
              <p className="small muted">Supervisor 正在擬定子題與要涵蓋的重點…</p>
              <div className="skel" aria-hidden="true">
                <span style={{ width: '88%' }} />
                <span style={{ width: '70%' }} />
                <span style={{ width: '80%' }} />
                <span style={{ width: '55%' }} />
              </div>
            </div>
          ) : null}
          {planning === 'failed' ? (
            <div className="banner bad" role="alert">
              <span>無法產生計畫：{state.planning.error}</span>
              <button type="button" className="btn small" onClick={generate} disabled={busy || !topicOk}>
                再試一次
              </button>
            </div>
          ) : null}

          {showPlan ? (
            <>
              <ol className="plan-items" aria-label="子題">
                {items.map((it, i) => (
                  <li key={it.key} className="plan-item">
                    <span className="move">
                      <button type="button" aria-label={`第 ${i + 1} 題上移`} disabled={i === 0} onClick={() => move(i, -1)}>
                        ▲
                      </button>
                      <button type="button" aria-label={`第 ${i + 1} 題下移`} disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                        ▼
                      </button>
                    </span>
                    <span className="no">{i + 1}</span>
                    <span>
                      <label className="sr-only" htmlFor={'q-' + it.key}>
                        子題 {i + 1}
                      </label>
                      <textarea
                        id={'q-' + it.key}
                        className="q"
                        rows={2}
                        maxLength={300}
                        value={it.question}
                        onChange={(e) => setItems((list) => list.map((x) => (x.key === it.key ? { ...x, question: e.target.value } : x)))}
                      />
                      <label className="sr-only" htmlFor={'s-' + it.key}>
                        子題 {i + 1} 的呈現方式
                      </label>
                      <select
                        id={'s-' + it.key}
                        className="shape"
                        value={it.dataShape}
                        onChange={(e) => setItems((list) => list.map((x) => (x.key === it.key ? { ...x, dataShape: e.target.value as DataShape } : x)))}
                      >
                        {SHAPES.map((s) => (
                          <option key={s.v} value={s.v}>
                            呈現：{s.label}
                          </option>
                        ))}
                      </select>
                    </span>
                    <button type="button" className="rm" aria-label={`刪除第 ${i + 1} 題`} onClick={() => setItems((list) => list.filter((x) => x.key !== it.key))}>
                      ×
                    </button>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                className="add-sub"
                disabled={items.length >= 12}
                onClick={() => setItems((list) => [...list, { key: nextKey(), question: '', dataShape: 'list' }])}
              >
                新增子題
              </button>
              {stale ? (
                <div className="banner warn">
                  <span>問題或設定改過了，計畫可能不再合適。</span>
                  <button type="button" className="linkbtn" onClick={generate} disabled={busy || !topicOk}>
                    依新設定重新產生
                  </button>
                </div>
              ) : null}
            </>
          ) : planning === 'idle' ? (
            <div className="plan-empty">
              <button type="button" className="btn primary" onClick={generate} disabled={busy || !topicOk}>
                產生計畫
              </button>
              <p className="small">先看計畫再開始，可以刪掉不需要的子題、補上你在意的面向。</p>
            </div>
          ) : null}

          <dl className="estimate">
            <div>
              <dt>預估來源</dt>
              <dd>{est.sources}</dd>
            </div>
            <div>
              <dt>預估時間</dt>
              <dd>{est.minutes}</dd>
            </div>
            <div>
              <dt>子題</dt>
              <dd>{est.subs} 個</dd>
            </div>
            <div>
              <dt>完成通知</dt>
              <dd>
                {config.emailNotifications ? (
                  <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontWeight: 500 }}>
                    <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> email 通知我
                  </label>
                ) : (
                  '在專案庫查看'
                )}
              </dd>
            </div>
          </dl>

          <div className="plan-actions">
            <button type="button" className="btn primary" onClick={() => void start()} disabled={busy || !topicOk || planning === 'drafting'}>
              開始研究
            </button>
            {draft && hasPlan ? (
              <button type="button" className="btn" disabled={busy || !plan.subQuestions.length} onClick={() => void actions.saveProposal(plan)}>
                儲存計畫
              </button>
            ) : null}
          </div>
          {!hasPlan && planning !== 'drafting' ? <p className="hint">也可以直接開始：Supervisor 會自己擬定計畫，不先給你看。</p> : null}
          <p className="hint">研究開始後仍可隨時改方向；可以關掉頁面，完成時會通知你。</p>
        </div>
      </aside>
    </main>
  );
}

/** What a plan depends on: the question and the settings (not the free-text notes). */
function signature(topic: string, b: Brief): string {
  return JSON.stringify([topic.trim(), b.depth ?? 'standard', b.audience ?? '', rangeOf(b.startDate), b.includeDomains ?? [], b.excludeDomains ?? []]);
}
