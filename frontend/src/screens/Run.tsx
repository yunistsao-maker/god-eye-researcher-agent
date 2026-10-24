/*
 * 研究進行中: sub-questions and coverage on the left, the stream of findings in the middle (each with
 * its evidence strength and custom view), the activity log on the right, and a box to redirect the
 * research while it runs.
 */
import { memo, useMemo, useState, type FormEvent } from 'react';
import { ActivityLine, SupervisorLine } from '../components/Activity';
import { BarsFor } from '../components/Bars';
import { ClaimList } from '../components/Evidence';
import { SpecRenderer } from '../components/SpecRenderer';
import { useNow } from '../components/useNow';
import { activityLabel } from '../lib/activity';
import { COVERAGE_LABEL, STRENGTH_LABEL, hm, relTime, splitLead, strengthLine, strengthOf } from '../lib/evidence';
import { specProblem } from '../lib/spec';
import { projectPath } from '../router';
import { claimsOf, findingLabel, showsSubUi, type FindingSlot, type ResearchState } from '../state';
import type { ScreenProps } from '../workspace';

const SHAPE_VIEW: Record<string, string> = { comparison: '比較表', timeline: '時間軸', metrics: '數字長條圖' };

function docDates(state: ResearchState): Map<string, string | null | undefined> {
  return new Map(state.docs.map((d) => [d.docId, d.publishedDate]));
}

/* ---------------- left rail ---------------- */

function railDetail(slot: FindingSlot, state: ResearchState): string {
  const agent = state.agents[slot.findingId];
  if (slot.status === 'ready') {
    const n = claimsOf(slot.finding).filter((c) => c.status !== 'superseded').length;
    return n ? `完成，${n} 個主張` : '完成';
  }
  if (slot.status === 'missing') return agent?.detail ?? '沒有產出結果';
  if (!agent) return '排隊中';
  if (agent.stalled) return agent.stalled.action === 'gave_up' ? '停滯，已放棄' : '停滯，重新嘗試中';
  return activityLabel(agent.phase, agent.detail, agent.round);
}

function Rail({ state }: { state: ResearchState }) {
  const version = state.project?.version ?? 1;
  const ids = state.order.filter((id) => (state.slots[id]?.version ?? 1) === version);
  const reqs = state.requirements;
  const cov = new Map((state.coverage?.requirements ?? []).map((c) => [c.id, c]));
  const covered = reqs.filter((r) => cov.get(r.id)?.status === 'covered').length;
  return (
    <section aria-labelledby="rail-h">
      <div className="colh">
        <h2 id="rail-h">子題{version > 1 ? `（第 ${version} 版）` : ''}</h2>
      </div>
      {!ids.length ? <p className="small muted">Supervisor 正在擬定子題…</p> : null}
      <ol className="rail">
        {ids.map((id) => {
          const s = state.slots[id]!;
          const busy = s.status === 'researching' && !!state.agents[id] && state.agents[id].phase !== 'done';
          const st = s.status === 'ready' ? 'done' : s.status === 'missing' ? 'miss' : busy ? 'busy' : s.round >= 2 ? 'add' : '';
          return (
            <li key={id} className={(busy ? 'active ' : '') + (s.round >= 2 ? 'gap' : '')}>
              <span className={'st ' + st} aria-hidden="true" />
              <a className="t" href={'#card-' + id} onClick={(e) => { e.preventDefault(); document.getElementById('card-' + id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>
                <span className="fid">{findingLabel(state, id)}</span>
                {s.question}
              </a>
              <span className="d">
                {s.round >= 2 ? '補充研究：' : ''}
                {railDetail(s, state)}
              </span>
            </li>
          );
        })}
      </ol>
      {reqs.length ? (
        <div className="panel covbox">
          <h3>涵蓋率</h3>
          <p className="small muted">
            計畫的 {reqs.length} 個重點中，已有充分證據的有 {covered} 個
            {state.coverage ? `（第 ${state.coverage.round} 輪檢查）` : '（子題完成後檢查）'}
          </p>
          <div className="squares" aria-hidden="true">
            {reqs.map((r) => (
              <i key={r.id} className={cov.get(r.id)?.status ?? ''} title={r.text} />
            ))}
          </div>
          <ul className="cov-items">
            {reqs.map((r) => {
              const c = cov.get(r.id);
              return (
                <li key={r.id}>
                  <i className={c?.status ?? ''} aria-hidden="true" />
                  <span>
                    {r.text}
                    <span className="n">
                      {' · '}
                      {COVERAGE_LABEL[c?.status ?? 'pending']}
                      {c?.claimIds.length ? `，${c.claimIds.length} 個主張` : ''}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/* ---------------- the stream of findings ---------------- */

type Filter = 'all' | 'contested' | 'thin';

function FindingCardImpl({ slot, state, now }: { slot: FindingSlot; state: ResearchState; now: number }) {
  const f = slot.finding;
  const label = findingLabel(state, slot.findingId);
  if (!f) {
    return (
      <article className="panel fcard skeleton" id={'card-' + slot.findingId}>
        <div className="lab">
          <span>
            子題 {label.slice(1)} {slot.question}
          </span>
        </div>
        <ActivityLine agent={state.agents[slot.findingId]} status={slot.status} />
        {slot.status === 'missing' ? <p className="small muted">這個子題沒有產出結果。</p> : (
          <div className="skel" aria-hidden="true">
            <span style={{ width: '80%' }} />
            <span style={{ width: '64%' }} />
          </div>
        )}
      </article>
    );
  }
  const claims = claimsOf(f);
  const s = strengthOf(claims, docDates(state));
  const [title, body] = splitLead(f.summary);
  const renderProblem = slot.ui.status === 'ready' ? specProblem(slot.ui.spec, f) : null;
  const showSub = showsSubUi(slot) && !renderProblem;
  const view = SHAPE_VIEW[f.dataShape];
  const hl = !!state.highlight && f.entities.some((e) => e.id === state.highlight);
  return (
    <article className={'panel fcard rise' + (hl ? ' hl' : '')} id={'card-' + slot.findingId} tabIndex={-1} aria-labelledby={'ft-' + slot.findingId}>
      <div className="lab">
        <span>
          子題 {label.slice(1)} {slot.question}
        </span>
        <span>{relTime(slot.readyAt, now)}</span>
        {slot.round >= 2 ? <span className="tag accent">補充研究</span> : null}
        {slot.version > 1 ? <span className="tag accent">第 {slot.version} 版</span> : null}
      </div>
      <h3 id={'ft-' + slot.findingId}>{title}</h3>
      {body ? <p className="body">{body}</p> : null}
      {showSub ? (
        <div>
          <SpecRenderer spec={slot.ui.spec} finding={f} />
          <p className="view-note">
            客製檢視：{view ?? '重點'}，由元件目錄產生{slot.ui.cache ? '（套用模板）' : ''}。資料來自這則發現的 {claims.length} 個主張。
          </p>
        </div>
      ) : slot.ui.status === 'generating' ? (
        <div className="gen dashed" aria-busy="true">
          <span>正在產生客製檢視：{view ?? '重點'}</span>
          <div className="skel" aria-hidden="true">
            <span style={{ width: '70%' }} />
            <span style={{ width: '50%' }} />
          </div>
        </div>
      ) : !claims.length && f.keyPoints.length ? (
        <ul className="kp">
          {f.keyPoints.map((k, i) => (
            <li key={i}>{k}</li>
          ))}
        </ul>
      ) : null}
      {claims.length ? (
        <details className="claims-fold">
          <summary>看 {claims.length} 個主張與原文</summary>
          <div style={{ marginTop: 12 }}>
            <ClaimList claims={claims} />
          </div>
        </details>
      ) : null}
      <div className="foot">
        {s.strength === 'none' ? (
          <span className="muted">{f.summary.includes('沒有找到') ? '沒有新的資料' : '沒有查證過的主張'}</span>
        ) : (
          <>
            <BarsFor s={s} size="md" />
            <span className={'strength ' + s.strength}>{STRENGTH_LABEL[s.strength]}</span>
            <span className="muted">
              {strengthLine(s)}
              {s.duplicates ? `；另有 ${s.duplicates} 篇轉載已合併` : ''}
              {s.strength === 'asserted' ? '；待補證' : ''}
            </span>
          </>
        )}
        <span className="sp" />
        {claims.length ? <a href={projectPath(f.projectId, 'evidence', { finding: f.findingId })}>到證據台比對</a> : null}
      </div>
    </article>
  );
}

const FindingCard = memo(FindingCardImpl);

function Stream({ state }: { state: ResearchState }) {
  const [filter, setFilter] = useState<Filter>('all');
  const now = useNow(state.project?.status === 'running');
  const slots = state.order.map((id) => state.slots[id]).filter(Boolean);
  const docs = state.docs;
  const dates = useMemo(() => new Map(docs.map((d) => [d.docId, d.publishedDate])), [docs]);
  const strength = (s: FindingSlot) => strengthOf(claimsOf(s.finding), dates).strength;
  const ready = slots.filter((s) => s.finding);
  const counts = { all: slots.length, contested: ready.filter((s) => strength(s) === 'contested').length, thin: ready.filter((s) => strength(s) === 'asserted').length };
  const shown = (filter === 'all' ? slots : ready.filter((s) => strength(s) === (filter === 'contested' ? 'contested' : 'asserted')))
    .slice()
    .sort((a, b) => (b.readyAt ?? (b.finding ? 1 : Infinity)) - (a.readyAt ?? (a.finding ? 1 : Infinity)));
  return (
    <section aria-labelledby="stream-h">
      <div className="colh">
        <h2 id="stream-h">最新發現</h2>
        <div className="filters" role="group" aria-label="篩選發現">
          {(
            [
              ['all', '全部'],
              ['contested', '有爭議'],
              ['thin', '待補證'],
            ] as [Filter, string][]
          ).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label} {counts[k]}
            </button>
          ))}
        </div>
      </div>
      <SupervisorLine agent={state.agents.supervisor} running={state.project?.status === 'running'} />
      <div className="stream" style={{ marginTop: 12 }}>
        {shown.length ? shown.map((s) => <FindingCard key={s.findingId} slot={s} state={state} now={now} />) : <p className="empty panel">還沒有符合的發現。</p>}
      </div>
    </section>
  );
}

/* ---------------- steering ---------------- */

function SteerBox({ state, actions, busy }: Pick<ScreenProps, 'state' | 'actions' | 'busy'>) {
  const [text, setText] = useState('');
  const running = state.project?.status === 'running';
  const late = state.synthesis.status !== 'none';
  const finishing = state.steering.some((s) => s.kind === 'finish');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim().length < 3) return;
    if (await actions.redirect(text.trim())) setText('');
  };
  const steers = state.steering.filter((s) => s.kind === 'redirect');
  if (!running && !steers.length) return null;
  return (
    <section className={'panel steerbox' + (running ? ' live' : '')} aria-labelledby="steer-h">
      <h3 id="steer-h">{running ? '改方向' : '你給過的方向'}</h3>
      {running ? (
        <form onSubmit={(e) => void submit(e)}>
          <label className="sr-only" htmlFor="steer">
            新的方向
          </label>
          <input
            id="steer"
            className="input"
            maxLength={500}
            disabled={late || finishing}
            placeholder={late ? '報告已在撰寫，這次研究不再改方向' : '例如：多看半導體封測，少看 PCB；加入日本與韓國的比較'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="btn primary" type="submit" disabled={busy || late || finishing || text.trim().length < 3}>
            送出
          </button>
        </form>
      ) : null}
      {steers.length ? (
        <ul className="steer-list">
          {steers.map((s) => (
            <li key={s.steerId}>
              <span className={'s' + (s.appliedRound ? ' ok' : '')}>{s.appliedRound ? `第 ${s.appliedRound} 輪已套用` : running ? '等待套用' : '未套用'}</span>
              <span>{s.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {running ? <p className="hint">已完成的子題會保留；新的方向從下一輪檢查開始生效（約 15 秒內送達）。</p> : null}
    </section>
  );
}

/* ---------------- activity ---------------- */

function ActivityPanel({ state, config, actions }: Pick<ScreenProps, 'state' | 'config' | 'actions'>) {
  const cited = new Set(state.order.flatMap((id) => claimsOf(state.slots[id]?.finding).flatMap((c) => c.evidence.map((e) => e.docId))));
  const counters: [string, number][] = [
    ['已讀頁面', state.docs.length],
    ['保留為證據', state.docs.filter((d) => cited.has(d.docId)).length],
    ['轉載合併', state.docs.filter((d) => d.duplicateOf).length],
    ['降權來源', state.docs.filter((d) => (d.score ?? 1) < 0.45).length],
  ];
  const p = state.project!;
  return (
    <section aria-labelledby="act-h">
      <div className="colh">
        <h2 id="act-h">活動紀錄</h2>
      </div>
      <dl className="panel counters">
        {counters.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {state.activity.length ? (
        <ol className="timeline" aria-label="最近的活動">
          {state.activity.slice(0, 40).map((a) => (
            <li key={a.id}>
              <time>{hm(a.at)}</time>
              {a.text}
            </li>
          ))}
        </ol>
      ) : (
        <p className="small muted" style={{ marginTop: 12 }}>
          {p.status === 'running' ? '搜尋、閱讀與抽出主張的步驟會列在這裡。' : '這次開啟頁面後沒有新的活動。'}
        </p>
      )}
      {config.emailNotifications && (p.status === 'running' || p.status === 'draft') ? (
        <label className="panel notify">
          <input type="checkbox" checked={!!p.notify} onChange={(e) => void actions.setNotify(e.target.checked)} />
          完成時用 email 通知我
        </label>
      ) : null}
    </section>
  );
}

export function Run({ state, config, actions, busy }: ScreenProps) {
  const p = state.project!;
  return (
    <main className="runbody" id="main">
      <div>
        <Rail state={state} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        {p.status === 'completed' && state.synthesis.status === 'ready' ? (
          <div className="banner">
            <span>研究已完成，報告寫好了。</span>
            <a className="btn small" href={projectPath(p.projectId, 'report')}>
              看報告
            </a>
          </div>
        ) : null}
        {p.status === 'stopped' ? <div className="banner warn">研究已停止。已完成的子題保留在下面，沒有寫報告。</div> : null}
        {p.status === 'failed' ? <div className="banner bad">研究沒有完成：{p.message ?? '發生錯誤'}</div> : null}
        <Stream state={state} />
        <SteerBox state={state} actions={actions} busy={busy} />
      </div>
      <div className="rcol">
        <ActivityPanel state={state} config={config} actions={actions} />
      </div>
    </main>
  );
}

