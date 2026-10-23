import { EVENT_TYPES, type ResearchEvent } from '../types';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function maybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Accepts whatever a transport hands over and returns a ResearchEvent, or null.
 * Handles: the event object itself, a JSON string of it (also double-encoded),
 * and Amplify's subscription envelope `{ id, type: 'data', event }`.
 */
export function parseEvent(raw: unknown): ResearchEvent | null {
  let v = maybeJson(raw);
  if (isObj(v) && !(typeof v.type === 'string' && (EVENT_TYPES as readonly string[]).includes(v.type)) && 'event' in v) {
    v = v.event;
  }
  v = maybeJson(v);
  v = maybeJson(v);
  if (!isObj(v)) return null;
  if (typeof v.type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(v.type)) return null;
  if (typeof v.projectId !== 'string' || !v.projectId) return null;
  const data = maybeJson(v.data ?? {});
  if (!isObj(data)) return null;
  return {
    type: v.type,
    projectId: v.projectId,
    ts: typeof v.ts === 'string' ? v.ts : new Date().toISOString(),
    data,
  } as ResearchEvent;
}
