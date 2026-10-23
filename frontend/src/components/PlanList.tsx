import type { AgentLive, FindingSlot } from '../state';
import type { SubQuestion } from '../types';
import { ActivityLine } from './Activity';

interface Props {
  hasProject: boolean;
  plan: SubQuestion[] | null;
  order: string[];
  slots: Record<string, FindingSlot>;
  agents: Record<string, AgentLive>;
}

export function PlanList({ hasProject, plan, order, slots, agents }: Props) {
  if (!hasProject) return <ul className="plan" />;
  if (!plan && !order.length) {
    return (
      <ul className="plan">
        <li className="empty-plan">Supervisor 正在拆解研究主題…</li>
      </ul>
    );
  }
  return (
    <ul className="plan">
      {order.map((id, i) => {
        const s = slots[id];
        if (!s) return null;
        const done = s.status === 'ready';
        const cls = done ? 's-done' : s.status === 'researching' ? 's-researching' : '';
        return (
          <li key={id} className={cls}>
            <span className="ps" aria-hidden="true" />
            <span className="pq">
              <span className="pq-q">
                <span className="fid">F{i + 1}</span>
                {s.question}
                <span className="sr-only">{done ? '（完成）' : s.status === 'researching' ? '（研究中）' : '（未完成）'}</span>
              </span>
              <ActivityLine agent={agents[id]} status={s.status} />
            </span>
            <span className="tags">
              {s.round >= 2 ? <span className="chip r2">補充研究</span> : null}
              <span className="chip mono">{s.dataShape}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
