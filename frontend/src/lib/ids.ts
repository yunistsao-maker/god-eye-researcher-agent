export function randomHex(chars: number): string {
  const bytes = new Uint8Array(Math.ceil(chars / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, chars);
}

/** p-YYYYMMDD-xxxxxxxx (local date, 8 hex chars). Matches ^p-[a-z0-9-]{4,60}$. */
export function newProjectId(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `p-${y}${m}${d}-${randomHex(8)}`;
}

/** AgentCore runtime session id, 33–256 chars. */
export function newSessionId(projectId: string): string {
  return `sess-${projectId}-${randomHex(32)}`;
}
