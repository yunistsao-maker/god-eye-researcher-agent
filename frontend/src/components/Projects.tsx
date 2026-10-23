import { CLEANUP_STEPS, type CleanupState } from '../state';
import type { Project } from '../types';

interface Props {
  projects: Project[];
  currentId: string | null;
  running: boolean;
  cleanup: Record<string, CleanupState>;
  loading: boolean;
  onAsk: (projectId: string) => void;
  onCancel: (projectId: string) => void;
  onConfirm: (projectId: string) => void;
}

function meta(p: Project, c: CleanupState | undefined): string {
  let s: string;
  if (c && (c.phase === 'running' || c.phase === 'done')) s = '清理中';
  else if (p.status === 'running') s = '研究中';
  else if (p.status === 'failed') s = '失敗';
  else if (p.status === 'archiving') s = '清理中';
  else s = `${p.findingCount ?? p.stats?.findings ?? 0} findings · 已完成`;
  if (p.parentProjectId) s += ' · parent ' + p.parentProjectId;
  return s;
}

export function Projects({ projects, currentId, running, cleanup, loading, onAsk, onCancel, onConfirm }: Props) {
  if (!projects.length) {
    return <div className="projects"><div className="pmeta">{loading ? '讀取專案清單…' : '沒有已儲存的專案。'}</div></div>;
  }
  return (
    <div className="projects">
      {projects.map((p) => {
        const cur = p.projectId === currentId;
        const c = cleanup[p.projectId];
        const inFlight = c && (c.phase === 'running' || c.phase === 'done');
        const blocked = p.status === 'running' || p.status === 'archiving' || (cur && running);
        let acts: JSX.Element | null = null;
        if (!inFlight) {
          acts =
            c?.phase === 'confirm' ? (
              <>
                <button type="button" className="btn small danger" onClick={() => onConfirm(p.projectId)}>
                  確認清理
                </button>
                <button type="button" className="btn small" onClick={() => onCancel(p.projectId)}>
                  取消
                </button>
              </>
            ) : (
              <button type="button" className="btn small" disabled={blocked} onClick={() => onAsk(p.projectId)} aria-label={`清理 ${p.projectId}`}>
                {c?.phase === 'error' ? '再試一次' : '清理'}
              </button>
            );
        }
        return (
          <div key={p.projectId} className={'proj' + (cur ? ' current' : '')}>
            <div className="top">
              <span className="pid">{p.projectId}</span>
              {cur ? <span className="chip">目前開啟</span> : null}
            </div>
            <div className="ptopic">{p.topic}</div>
            <div className="pmeta">{meta(p, c)}</div>
            {c?.phase === 'error' && c.error ? <div className="pmeta err">清理失敗：{c.error}</div> : null}
            {acts ? <div className="acts">{acts}</div> : null}
            {inFlight ? (
              <ol className="steps" aria-label="清理進度">
                {CLEANUP_STEPS.map((t, i) => (
                  <li key={i} className={i < c.step ? 'done' : i === c.step ? 'doing' : ''}>
                    {t.replace('{id}', p.projectId)}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
