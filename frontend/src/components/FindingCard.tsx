import { memo, useMemo } from 'react';
import { specProblem } from '../lib/spec';
import { claimsOf, showsSubUi, tierOf, type AgentLive, type FindingSlot } from '../state';
import { ActivityLine } from './Activity';
import { ClaimList } from './Evidence';
import { SpecRenderer } from './SpecRenderer';

interface Props {
  slot: FindingSlot;
  label: string; // F1, F2…
  /** Live status of this finding's sub-agent (agentId = findingId). */
  agent?: AgentLive;
  highlight: string | null; // entity id
  onEntity: (entityId: string) => void;
  onToggleView: (findingId: string) => void;
  onApplySwap: (findingId: string) => void;
}

function Skeleton() {
  return (
    <div className="skel" aria-hidden="true">
      <span style={{ width: '92%' }} />
      <span style={{ width: '78%' }} />
      <span style={{ width: '84%' }} />
      <span style={{ width: '40%' }} />
    </div>
  );
}

function FindingCardImpl({ slot, label, agent, highlight, onEntity, onToggleView, onApplySwap }: Props) {
  const f = slot.finding;
  // Defence in depth: the reducer already validates, but never draw a spec that does not fit the data.
  const renderProblem = useMemo(
    () => (slot.ui.status === 'ready' && f ? specProblem(slot.ui.spec, f) : null),
    [slot.ui.status, slot.ui.spec, f],
  );
  const ui = renderProblem ? { ...slot.ui, status: 'failed' as const, reason: renderProblem, pendingSwap: false } : slot.ui;
  const effective: FindingSlot = renderProblem ? { ...slot, ui } : slot;
  const [tierKind, tierText] = tierOf(effective);
  const showSub = showsSubUi(effective);
  const mentions = !!highlight && !!f && f.entities.some((e) => e.id === highlight);
  const cls = 'card' + (highlight ? (mentions ? ' hl' : ' dim') : '');
  const ready = slot.status === 'ready' && !!f;
  const claims = useMemo(() => claimsOf(f), [f]);

  let body: JSX.Element;
  if (slot.status === 'researching') body = <Skeleton />;
  else if (!f) body = <p className="sum">這個子題沒有產出結果。</p>;
  else if (showSub)
    body = (
      <>
        <SpecRenderer spec={ui.spec} finding={f} />
        <ClaimList claims={claims} folded />
      </>
    );
  else
    body = (
      <>
        <p className="sum">{f.summary}</p>
        {/* Verified claims replace the unverified key points when the backend has them. */}
        {claims.length ? (
          <ClaimList claims={claims} />
        ) : f.keyPoints.length ? (
          <ul className="kp">
            {f.keyPoints.map((k, i) => (
              <li key={i}>{k}</li>
            ))}
          </ul>
        ) : null}
        {f.entities.length ? (
          <div className="ents">
            {f.entities.map((e) => (
              <button
                type="button"
                key={e.id}
                className={'ent' + (highlight === e.id ? ' on' : '')}
                aria-pressed={highlight === e.id}
                onClick={() => onEntity(e.id)}
              >
                {e.name}
              </button>
            ))}
          </div>
        ) : null}
        {f.sources.length ? (
          <div className="srcs">
            來源：
            {f.sources.map((s, i) => (
              <span key={i}>
                {i > 0 ? '、' : ''}
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title}
                </a>
              </span>
            ))}
          </div>
        ) : null}
      </>
    );

  let right: JSX.Element | null = null;
  if (ready) {
    if (ui.status === 'generating') right = <span className="gen">sub-UI 生成中 · uigen</span>;
    else if (ui.status === 'failed') right = <span className="fail-note">保留通用卡片</span>;
    else if (ui.status === 'ready')
      right = (
        <>
          {ui.cache ? <span className="cache">模板快取命中</span> : null}
          {!ui.pendingSwap ? (
            <button type="button" className="btn small" onClick={() => onToggleView(slot.findingId)}>
              {slot.view === 'auto' ? '看通用卡片' : '看 sub-UI'}
            </button>
          ) : null}
        </>
      );
  }

  const hasSpec = ui.spec !== null && ui.spec !== undefined;
  const conf = f ? Math.max(0, Math.min(1, f.confidence)) : 0;

  return (
    <article className={cls} id={'card-' + slot.findingId} tabIndex={-1} aria-labelledby={'cq-' + slot.findingId}>
      <header className="card-hd">
        <div className="card-q">
          <span className="fid">{label}</span>
          <div className="card-qt">
            <h3 id={'cq-' + slot.findingId}>{f?.question ?? slot.question}</h3>
            <ActivityLine agent={agent} status={slot.status} />
          </div>
        </div>
        <span className="tags">
          {slot.round >= 2 ? <span className="chip r2">補充研究</span> : null}
          <span className={'tier ' + tierKind}>{tierText}</span>
        </span>
      </header>
      {ui.pendingSwap && ready ? (
        <button type="button" className="swapbar" onClick={() => onApplySwap(slot.findingId)}>
          sub-UI 已就緒 · 點這裡套用新版面
        </button>
      ) : null}
      <div className={'card-body' + (slot.anim > 0 ? ' swap-in' : '')} key={slot.anim}>
        {body}
      </div>
      <footer className="card-ft">
        <span className="ft-l">
          <span className="chip mono">dataShape: {f?.dataShape ?? slot.dataShape}</span>
          {ready ? (
            <span className="conf" title="信心分數">
              <i style={{ ['--w' as string]: Math.round(conf * 100) + '%' }} />
              {conf.toFixed(2)}
            </span>
          ) : null}
        </span>
        <span className="ft-r">{right}</span>
      </footer>
      {ui.status === 'failed' && ui.reason ? (
        <div className="card-ft reason">
          <span className="fail-note">{ui.reason}</span>
        </div>
      ) : null}
      {(ui.status === 'ready' || ui.status === 'failed') && hasSpec ? (
        <details className="spec">
          <summary>sub-UI spec{ui.status === 'failed' ? '（被拒）' : ''}</summary>
          <pre>{JSON.stringify(ui.spec, null, 2)}</pre>
        </details>
      ) : null}
    </article>
  );
}

export const FindingCard = memo(FindingCardImpl);
