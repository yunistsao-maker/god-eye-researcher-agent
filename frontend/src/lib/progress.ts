/*
 * Run progress as the header shows it: "第 7 步，共 18 步，約剩 9 分鐘". Steps are the plan, each
 * sub-question, each review, the report and its check. Pure, so it is tested without a DOM.
 */
import type { ResearchState } from '../state';
import type { Depth } from '../types';

export const DEPTH_NAME: Record<Depth, string> = { quick: '快速', standard: '標準', deep: '深入' };

export interface Progress {
  done: number;
  total: number;
  /** 1-based step in progress (equals done + 1 until everything is done). */
  current: number;
  etaMin: number | null;
}

type Slice = Pick<ResearchState, 'plan' | 'order' | 'slots' | 'coverage' | 'synthesis' | 'agents' | 'clock' | 'project'>;

export function progressOf(state: Slice, now: number): Progress {
  const version = state.project?.version ?? 1;
  const slots = state.order.map((id) => state.slots[id]).filter((s) => s && s.version === version);
  const rounds = Math.max(1, ...slots.map((s) => s.round));
  const plan = state.plan ? 1 : 0;
  const finished = slots.filter((s) => s.status !== 'researching').length;
  const reviewsDone = Math.min(rounds, state.coverage?.round ?? 0);
  const sup = state.agents.supervisor?.phase;
  const reportDone = state.synthesis.status === 'ready' ? 2 : state.synthesis.status === 'streaming' || sup === 'verifying' ? 1 : 0;
  // A review per round, the report and its check; at least one round of sub-questions even before the plan.
  const total = 1 + Math.max(slots.length, 3) + rounds + 2;
  const done = Math.min(total, plan + finished + reviewsDone + reportDone);
  let etaMin: number | null = null;
  const started = state.clock.startedAt;
  if (started && done >= 2 && done < total) {
    const perStep = ((now - started) * (state.clock.scale || 1)) / done;
    etaMin = Math.max(1, Math.round((perStep * (total - done)) / 60_000));
  }
  return { done, total, current: Math.min(total, done + 1), etaMin };
}
