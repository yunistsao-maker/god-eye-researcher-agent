/*
 * 專案庫: every project with its status and freshness. Completed projects open their report or re-run
 * for newer data; drafts continue planning; running ones show progress; anything not running can be
 * archived (the cleanup workflow).
 */
import { useState } from 'react';
import { ymd } from '../lib/evidence';
import { projectPath } from '../router';
import { CLEANUP_STEPS } from '../state';
import type { Project } from '../types';
import type { ScreenProps } from '../workspace';

type Tab = 'all' | 'running' | 'draft' | 'stale' | 'done' | 'ended';
const STALE_DAYS = 30;

function isStale(p: Project, now: number): boolean {
  const at = Date.parse(p.completedAt ?? p.updatedAt ?? p.createdAt ?? '');
  return p.status === 'completed' && Number.isFinite(at) && now - at > STALE_DAYS * 86400_000;
}

function statusLine(p: Project, now: number): [string, '' | 'warn' | 'bad'] {
  switch (p.status) {
    case 'draft':
      return ['草稿：計畫等你確認', ''];
    case 'running':
      return [(p.version ?? 1) > 1 ? `研究中：第 ${p.version} 版增量重跑` : '研究中', ''];
    case 'completed': {
      const day = ymd(p.completedAt ?? p.updatedAt);
      const v = (p.version ?? 1) > 1 ? `（第 ${p.version} 版）` : '';
      return isStale(p, now) ? [`資料截至 ${day}${v}；超過 ${STALE_DAYS} 天，建議增量重跑`, 'warn'] : [`資料截至 ${day}${v}`, ''];
    }
    case 'failed':
      return [`沒有完成${p.message ? '：' + p.message : ''}`, 'bad'];
    case 'stopped':
      return [`已停止${p.stoppedAt ? '於 ' + ymd(p.stoppedAt) : ''}；已完成的部分保留`, ''];
    case 'archiving':
      return ['封存中…', ''];
    default:
      return ['已封存；報告與來源快照保留在 S3', ''];
  }
}

export function Library({ state, actions, busy, loading }: ScreenProps & { loading: boolean }) {
  const [tab, setTab] = useState<Tab>('all');
  const now = Date.now();
  const list = state.projects.filter((p) => p.status !== 'archived');
  const groups: Record<Tab, Project[]> = {
    all: list,
    running: list.filter((p) => p.status === 'running'),
    draft: list.filter((p) => p.status === 'draft'),
    stale: list.filter((p) => isStale(p, now)),
    done: list.filter((p) => p.status === 'completed'),
    ended: list.filter((p) => p.status === 'stopped' || p.status === 'failed'),
  };
  const labels: [Tab, string][] = [
    ['all', '全部'],
    ['running', '進行中'],
    ['draft', '草稿'],
    ['done', '已完成'],
    ['stale', '需要更新'],
    ['ended', '已停止或失敗'],
  ];
  const shown = groups[tab];


  return (
    <main className="page narrow" id="main">
      <div className="libhead">
        <div>
          <h1>專案庫</h1>
          <p>每個專案都保留完整的主張與證據。增量重跑只搜尋上次之後的新資料，並標出改變了的主張。</p>
        </div>
        <a className="btn primary" href="#/new">
          新研究
        </a>
      </div>
      <div className="libtabs" role="tablist" aria-label="篩選專案">
        {labels
          .filter(([t]) => t === 'all' || groups[t].length)
          .map(([t, label]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {label} {groups[t].length}
            </button>
          ))}
      </div>
      {loading ? <p className="empty">讀取專案…</p> : null}
      {!loading && !shown.length ? (
        <div className="panel empty">
          {tab === 'all' ? (
            <>
              還沒有專案。<a href="#/new">開始第一個研究</a>
            </>
          ) : (
            '這一類沒有專案。'
          )}
        </div>
      ) : null}
      <ul className="plist">
        {shown.map((p) => {
          const [line, tone] = statusLine(p, now);
          const c = state.cleanup[p.projectId];
          const claims = p.stats?.claims;
          const view = p.status === 'draft' ? 'plan' : p.status === 'running' ? 'run' : 'report';
          return (
            <li key={p.projectId} className={'panel prow ' + p.status}>
              <div style={{ minWidth: 0 }}>
                <h2>
                  <a href={projectPath(p.projectId, view)}>{p.topic || p.projectId}</a>
                </h2>
                <p className={'line ' + tone}>{line}</p>
              </div>
              <span className="cnt">{typeof claims === 'number' ? `${claims} 個主張` : p.findingCount ? `${p.findingCount} 個發現` : ''}</span>
              <div className="acts">
                {p.status === 'running' ? (
                  <a className="btn small" href={projectPath(p.projectId, 'run')}>
                    查看進度
                  </a>
                ) : null}
                {p.status === 'draft' ? (
                  <a className="btn small primary" href={projectPath(p.projectId, 'plan')}>
                    繼續規劃
                  </a>
                ) : null}
                {p.status === 'completed' ? (
                  <>
                    <a className="btn small" href={projectPath(p.projectId, 'report')}>
                      開啟報告
                    </a>
                    <button type="button" className={'btn small' + (isStale(p, now) ? ' primary' : '')} disabled={busy} onClick={() => void actions.rerun([], p.projectId)}>
                      增量重跑
                    </button>
                  </>
                ) : null}
                {p.status === 'stopped' || p.status === 'failed' ? (
                  <>
                    <a className="btn small" href={projectPath(p.projectId, 'run')}>
                      開啟
                    </a>
                    <a className="btn small" href={`#/new?from=${p.projectId}`}>
                      重新研究
                    </a>
                  </>
                ) : null}
                {p.status !== 'running' && p.status !== 'archiving' && !c ? (
                  <button type="button" className="btn small" onClick={() => actions.askCleanup(p.projectId)}>
                    封存
                  </button>
                ) : null}
              </div>
              {c?.phase === 'confirm' ? (
                <div className="confirm">
                  <span>封存後報告與來源快照會留在 S3 封存檔，專案會從清單移除。</span>
                  <button type="button" className="btn small danger" onClick={() => void actions.confirmCleanup(p.projectId)}>
                    確定封存
                  </button>
                  <button type="button" className="btn small" onClick={() => actions.cancelCleanup(p.projectId)}>
                    取消
                  </button>
                </div>
              ) : null}
              {c && c.phase !== 'confirm' ? (
                <ol className="steps-list" aria-live="polite">
                  {CLEANUP_STEPS.map((s, i) => (
                    <li key={s} className={i < c.step ? 'done' : i === c.step && c.phase === 'running' ? 'now' : ''}>
                      {i < c.step ? '✓ ' : ''}
                      {s}
                    </li>
                  ))}
                  {c.phase === 'error' ? <li className="err">封存失敗：{c.error}</li> : null}
                </ol>
              ) : null}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
