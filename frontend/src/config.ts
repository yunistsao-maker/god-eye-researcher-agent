import type { AppConfig } from './types';

export const DEFAULT_CONFIG: AppConfig = {
  mode: 'mock',
  region: 'us-west-2',
  userPoolId: '',
  userPoolClientId: '',
  eventsHttpEndpoint: '',
  agentsBaseUrl: '',
  toolsMcpUrl: '/mcp',
};

const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v.trim() : fallback);

export function normalizeConfig(raw: unknown): AppConfig {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    mode: r.mode === 'live' ? 'live' : 'mock',
    region: str(r.region, DEFAULT_CONFIG.region) || DEFAULT_CONFIG.region,
    userPoolId: str(r.userPoolId, ''),
    userPoolClientId: str(r.userPoolClientId, ''),
    eventsHttpEndpoint: str(r.eventsHttpEndpoint, ''),
    agentsBaseUrl: str(r.agentsBaseUrl, ''),
    toolsMcpUrl: str(r.toolsMcpUrl, DEFAULT_CONFIG.toolsMcpUrl) || DEFAULT_CONFIG.toolsMcpUrl,
  };
}

/** Fields live mode cannot run without. agentsBaseUrl may be empty (same origin, e.g. the dev proxy). */
export function missingLiveFields(cfg: AppConfig): string[] {
  const out: string[] = [];
  if (!cfg.userPoolId) out.push('userPoolId');
  if (!cfg.userPoolClientId) out.push('userPoolClientId');
  if (!cfg.eventsHttpEndpoint) out.push('eventsHttpEndpoint');
  if (!cfg.toolsMcpUrl) out.push('toolsMcpUrl');
  return out;
}

export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`config.json HTTP ${res.status}`);
  return normalizeConfig(await res.json());
}
