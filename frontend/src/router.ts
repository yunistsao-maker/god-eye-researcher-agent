/*
 * Hash routes, so the app works from a static S3/CloudFront origin and links survive a reload:
 *   #/new                         new research (question, brief, plan)
 *   #/library                     專案庫
 *   #/p/{projectId}               a project, in the view that fits its status
 *   #/p/{projectId}/plan|run|report|evidence[?claim=…&tab=…&q=…]
 */
import { useEffect, useState } from 'react';

export type ProjectView = 'plan' | 'run' | 'report' | 'evidence';
export type Route =
  | { name: 'home' }
  | { name: 'new'; from?: string }
  | { name: 'library' }
  | { name: 'project'; id: string; view: ProjectView | null; params: Record<string, string> };

const PROJECT_ID = /^p-[a-z0-9-]{4,60}$/;
const VIEWS: readonly ProjectView[] = ['plan', 'run', 'report', 'evidence'];

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [path, query = ''] = raw.split('?');
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'new') return params.from && PROJECT_ID.test(params.from) ? { name: 'new', from: params.from } : { name: 'new' };
  if (parts[0] === 'library') return { name: 'library' };
  if (parts[0] === 'p' && parts[1] && PROJECT_ID.test(parts[1])) {
    const view = (VIEWS as readonly string[]).includes(parts[2] ?? '') ? (parts[2] as ProjectView) : null;
    return { name: 'project', id: parts[1], view, params };
  }
  return { name: 'home' };
}

export function projectPath(id: string, view?: ProjectView, params?: Record<string, string>): string {
  const q = params && Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '';
  return `#/p/${id}${view ? '/' + view : ''}${q}`;
}

export function navigate(hash: string, replace = false): void {
  const target = hash.startsWith('#') ? hash : '#' + hash;
  if (window.location.hash === target) return;
  if (replace) {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
