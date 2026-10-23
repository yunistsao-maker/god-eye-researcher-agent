import { memo } from 'react';
import { activityLabel, ago, secs } from '../lib/activity';
import { agentIdleMs, liveness, livenessRef, type AgentLive, type FindingStatus, type LiveClock, type OpenProject } from '../state';
import { useNow } from './useNow';

function stallText(agent: AgentLive, now: number): string {
  const st = agent.stalled!;
  if (st.action === 'gave_up') return '停滯，已放棄';
  return `停滯 ${Math.max(Math.round(st.idleSec), secs(agentIdleMs(agent, now)))} 秒，重新嘗試中`;
}

/** One line under a sub-question while its sub-agent works (plan rows and finding cards). */
function ActivityLineImpl({ agent, status }: { agent: AgentLive | undefined; status: FindingStatus }) {
  const gaveUp = agent?.stalled?.action === 'gave_up';
  // A sub-agent that gave up keeps its note after the run ends, so the empty card explains itself.
  const show = !!agent && (status === 'researching' || (gaveUp && status !== 'ready'));
  const now = useNow(show && !gaveUp);
  if (!show || !agent) return null;
  if (agent.stalled) {
    return (
      <div className={'act ' + (gaveUp ? 'bad' : 'warn')}>
        <span className="act-t">{stallText(agent, now)}</span>
      </div>
    );
  }
  return (
    <div className="act">
      <span className="act-t">{activityLabel(agent.phase, agent.detail, agent.round)}</span>
      <span className="act-ago">{ago(agentIdleMs(agent, now))}</span>
    </div>
  );
}

export const ActivityLine = memo(ActivityLineImpl);

/** 「Supervisor：規劃中」 at the top of 研究計畫, while the run is going. */
function SupervisorLineImpl({ agent, running }: { agent: AgentLive | undefined; running: boolean }) {
  const show = running && !!agent && agent.phase !== 'done';
  // `waiting` is a normal state with no stall watch, so it shows no idle time.
  const now = useNow(show && agent!.phase !== 'waiting');
  if (!show || !agent) return null;
  const warn = agent.stalled ? (agent.stalled.action === 'gave_up' ? ' bad' : ' warn') : agent.phase === 'failed' ? ' bad' : '';
  const text = agent.stalled ? stallText(agent, now) : activityLabel(agent.phase, agent.detail, agent.round);
  const showAgo = !agent.stalled && agent.phase !== 'waiting' && agent.phase !== 'failed';
  return (
    <div className={'sup-line' + warn}>
      <b>Supervisor</b>：<span className="act-t">{text}</span>
      {showAgo ? <span className="act-ago">{ago(agentIdleMs(agent, now))}</span> : null}
    </div>
  );
}

export const SupervisorLine = memo(SupervisorLineImpl);

interface LivenessProps {
  project: OpenProject | null;
  live: LiveClock;
  refreshing: boolean;
  onRefresh: () => void;
}

/** Status-bar indicator for the liveness rule in contracts/events.md. Re-renders every second on its own. */
export function LivenessIndicator({ project, live, refreshing, onRefresh }: LivenessProps) {
  const now = useNow(project?.status === 'running');
  const slice = { project, live };
  const lv = liveness(slice, now);
  if (lv === 'idle') return null;
  const ref = livenessRef(slice);
  const n = ref === null ? null : secs(now - ref);
  let text: string;
  let sr: string;
  if (lv === 'alive') {
    text = live.lastHeartbeatAt !== null ? `Agent 運作中 · ${n} 秒前更新` : 'Agent 啟動中 · 等待心跳';
    sr = 'Agent 運作中';
  } else if (lv === 'quiet') {
    text = n === null ? '暫時沒有回應' : `已 ${n} 秒沒有回應`;
    sr = 'Agent 已超過 15 秒沒有回應';
  } else {
    text = '超過 30 秒沒有心跳，agent 可能已停止';
    sr = text;
  }
  return (
    <span className="liveness">
      <span className={'live-ind ' + lv} data-liveness={lv}>
        <span className="beat" key={live.lastHeartbeatAt ?? 'none'} aria-hidden="true" />
        <span className="live-t">{text}</span>
      </span>
      <span className="sr-only" role="status">
        {sr}
      </span>
      {lv === 'stale' ? (
        <button className="btn small" type="button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? '讀取中…' : '重新整理狀態'}
        </button>
      ) : null}
    </span>
  );
}
