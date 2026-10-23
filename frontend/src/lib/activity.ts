/*
 * Text for live agent activity (agent.activity phases, see contracts/events.md). Pure helpers,
 * shared by the reducer's log lines and the UI.
 */
import type { AgentPhase } from '../types';

/** Cuts to `max` characters (code points) with a trailing ellipsis. */
export function truncate(s: string, max: number): string {
  const chars = Array.from(s.trim());
  return chars.length > max ? chars.slice(0, Math.max(1, max - 1)).join('') + '…' : chars.join('');
}

function decodePath(p: string): string {
  try {
    return decodeURI(p);
  } catch {
    return p;
  }
}

/** "example.com/reports/x" from a URL: host (without www.) + path, truncated. Falls back to the raw text. */
export function shortUrl(raw: string, max = 48): string {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname === '/' ? '' : decodePath(u.pathname).replace(/\/$/, '');
    return truncate(host + path, max);
  } catch {
    return truncate(raw, max);
  }
}

/** One-line description of what an agent is doing right now. */
export function activityLabel(phase: AgentPhase, detail?: string | null, round?: number | null): string {
  const d = (detail ?? '').trim();
  switch (phase) {
    case 'searching':
      return d ? '搜尋：' + truncate(d, 80) : '搜尋中';
    case 'reading':
      return d ? '閱讀：' + shortUrl(d) : '閱讀網頁';
    case 'thinking':
      return '思考中…';
    case 'writing':
      return '寫入 finding';
    case 'designing':
      return '設計 sub-UI';
    case 'planning':
      return round && round >= 2 ? '規劃補充研究' : '規劃中';
    case 'waiting':
      return d ? truncate(d, 80) : '等待 sub-agent 完成';
    case 'reviewing':
      return '檢查矛盾與缺口';
    case 'reporting':
      return '撰寫報告';
    case 'verifying':
      return '逐句查核報告';
    case 'done':
      return '完成';
    case 'failed':
      return d ? '失敗：' + truncate(d, 80) : '失敗';
    default:
      return '思考中…';
  }
}

/** "3 秒前" / "2 分鐘前". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} 秒前` : `${Math.floor(s / 60)} 分鐘前`;
}

/** Whole seconds, never negative. */
export function secs(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000));
}
