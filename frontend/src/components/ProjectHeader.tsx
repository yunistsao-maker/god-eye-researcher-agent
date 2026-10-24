import { useState } from 'react';
import { DEPTH_NAME, progressOf } from '../lib/progress';
import { hm, ymd } from '../lib/evidence';
import { projectPath, type ProjectView } from '../router';
import type { ResearchState } from '../state';
import type { Actions } from '../workspace';
import { LivenessIndicator } from './Activity';
import { useNow } from './useNow';

const STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  running: '研究中',
  completed: '已完成',
  failed: '失敗',
  stopped: '已停止',
  archiving: '封存中',
  archived: '已封存',
};

interface Props {
  state: ResearchState;
  actions: Actions;
  view: ProjectView;
  busy: boolean;
  refreshing: boolean;
}

/** The project's title band: status, the views (進度 · 報告 · 證據台), and while running the step count and controls. */
export function ProjectHeader({ state, actions, view, busy, refreshing }: Props) {
  const p = state.project!;
  const running = p.status === 'running';
  const now = useNow(running);
  const prog = progressOf(state, now);
  const [confirmStop, setConfirmStop] = useState(false);
  const depth = p.brief?.depth ? DEPTH_NAME[p.brief.depth] + '深度' : '';
  const started = state.clock.startedAt;
  const meta = [
    depth,
    started ? `${hm(started)} 開始` : p.createdAt ? `${ymd(p.createdAt)} 建立` : '',
    (p.version ?? 1) > 1 ? `第 ${p.version} 版${p.since ? `（${p.since} 之後的新資料）` : ''}` : '',
    running ? (p.notify ? '可以關掉頁面，完成時會寄 email 通知你。' : '可以關掉頁面，研究會在背景繼續。') : '',
  ].filter(Boolean);
  const tabs: [ProjectView, string][] = [
    ['run', '進度'],
    ['report', '報告'],
    ['evidence', '證據台'],
  ];

  return (
    <div className="runhead">
      <div className="inner">
        <div className="row">
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', alignItems: 'center' }}>
              <h1>{p.topic}</h1>
              <span className={'status-pill ' + p.status}>
                <span className="dot" aria-hidden="true" />
                {STATUS_TEXT[p.status] ?? p.status}
              </span>
            </div>
            <p className="meta">{meta.join('，')}</p>
          </div>
          {running && view === 'run' ? (
            <div className="ctl">
              <span className="steps">
                第 <b className="num">{prog.current}</b> 步，共 <b className="num">{prog.total}</b> 步{prog.etaMin !== null ? `，約剩 ${prog.etaMin} 分鐘` : ''}
              </span>
              {confirmStop ? (
                <>
                  <span className="small">停止後已完成的部分會保留，不會寫報告。</span>
                  <button type="button" className="btn small danger" disabled={busy} onClick={() => void actions.stop().then(() => setConfirmStop(false))}>
                    確定停止
                  </button>
                  <button type="button" className="btn small" onClick={() => setConfirmStop(false)}>
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn small" disabled={busy} onClick={() => setConfirmStop(true)}>
                    停止
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={busy || state.steering.some((s) => s.kind === 'finish') || state.synthesis.status !== 'none'}
                    onClick={() => void actions.finishEarly()}
                  >
                    停止並用目前結果寫報告
                  </button>
                </>
              )}
            </div>
          ) : null}
        </div>
        {running && view === 'run' ? (
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={prog.total} aria-valuenow={prog.done} aria-label="研究進度">
            {Array.from({ length: prog.total }, (_, i) => (
              <i key={i} className={i < prog.done ? 'd' : i === prog.done ? 'c' : ''} />
            ))}
          </div>
        ) : null}
        <div className="row">
          <nav className="ptabs" aria-label="專案">
            {tabs.map(([v, label]) => (
              <a key={v} href={projectPath(p.projectId, v)} aria-current={view === v ? 'page' : undefined}>
                {label}
              </a>
            ))}
          </nav>
          {running ? <LivenessIndicator project={p} live={state.live} refreshing={refreshing} onRefresh={() => void actions.refreshStatus()} /> : null}
        </div>
      </div>
    </div>
  );
}
