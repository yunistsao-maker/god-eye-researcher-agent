import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configure = vi.fn();
const subscribeSpy = vi.fn();
const connectSpy = vi.fn();
let observer: { next: (v: unknown) => void; error: (e: unknown) => void } | null = null;

vi.mock('aws-amplify', () => ({ Amplify: { configure: (...a: unknown[]) => configure(...a) } }));
vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: async () => ({ tokens: { accessToken: { toString: () => 'access-token-123' } } }),
}));
vi.mock('aws-amplify/data', () => ({
  events: {
    connect: async (path: string) => {
      connectSpy(path);
      return {
        subscribe: (obs: typeof observer) => {
          observer = obs;
          subscribeSpy();
          return { ready: Promise.resolve({ subscriptionId: 's1' }), unsubscribe: vi.fn() };
        },
        close: vi.fn(),
      };
    },
  },
}));

import { LiveTransport } from './live';
import { McpClient } from './mcp';
import type { AppConfig, ResearchEvent } from '../types';

const cfg: AppConfig = {
  mode: 'live',
  region: 'us-west-2',
  userPoolId: 'us-west-2_AbCdEfGhI',
  userPoolClientId: 'client123',
  eventsHttpEndpoint: 'https://abc.appsync-api.us-west-2.amazonaws.com/event',
  agentsBaseUrl: 'https://agents.example.com/',
  toolsMcpUrl: 'https://tools.example.com/mcp',
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(responder: (body: Record<string, unknown>, n: number) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    return responder(body, calls.length);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const rpc = (id: unknown, result: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result });

beforeEach(() => {
  observer = null;
  configure.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('McpClient', () => {
  it('initializes once, keeps Mcp-Session-Id, and parses JSON and SSE tool results', async () => {
    const calls = fakeFetch((body) => {
      if (body.method === 'initialize') {
        return new Response(rpc(body.id, { protocolVersion: '2025-06-18', capabilities: {} }), {
          headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-abc' },
        });
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = { content: [{ type: 'text', text: JSON.stringify({ projects: [{ projectId: 'p-1234', topic: 't', status: 'completed' }] }) }] };
      if ((body.params as { name: string }).name.endsWith('project_get')) {
        return new Response(`event: message\ndata: ${rpc(body.id, result)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(rpc(body.id, result), { headers: { 'Content-Type': 'application/json' } });
    });
    const client = new McpClient('/mcp', async () => 'tok');
    const a = (await client.callTool('project-tools___project_list', {})) as { projects: unknown[] };
    const b = (await client.callTool('project-tools___project_get', { projectId: 'p-1234' })) as { projects: unknown[] };
    expect(a.projects).toHaveLength(1);
    expect(b.projects).toHaveLength(1);
    expect(calls.map((c) => c.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
    const init = calls[0].body.params as Record<string, unknown>;
    expect(init.protocolVersion).toBe('2025-06-18');
    expect(init.capabilities).toEqual({});
    expect(init.clientInfo).toEqual({ name: 'god-eye-web', version: '0.1.0' });
    expect(calls[0].headers.Accept).toBe('application/json, text/event-stream');
    expect(calls[0].headers['Mcp-Session-Id']).toBeUndefined();
    expect(calls[1].headers['Mcp-Session-Id']).toBe('sess-abc');
    expect(calls[2].headers['Mcp-Session-Id']).toBe('sess-abc');
    expect(calls[2].headers.Authorization).toBe('Bearer tok');
    expect(calls[2].body.params).toEqual({ name: 'project-tools___project_list', arguments: {} });
  });

  it('throws the tool text when isError is set', async () => {
    fakeFetch((body) => {
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'initialize') return new Response(rpc(body.id, {}), { headers: { 'Content-Type': 'application/json' } });
      return new Response(rpc(body.id, { isError: true, content: [{ type: 'text', text: 'project not found' }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    const client = new McpClient('/mcp', async () => 'tok');
    await expect(client.callTool('project-tools___project_get', { projectId: 'p-x' })).rejects.toThrow('project not found');
  });
});

describe('LiveTransport', () => {
  it('configures Amplify, subscribes to /research/{id}, and parses envelope or string payloads', async () => {
    const t = new LiveTransport(cfg, () => undefined);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure.mock.calls[0][0]).toEqual({
      Auth: { Cognito: { userPoolId: cfg.userPoolId, userPoolClientId: cfg.userPoolClientId } },
      API: { Events: { endpoint: cfg.eventsHttpEndpoint, region: 'us-west-2', defaultAuthMode: 'userPool' } },
    });
    const got: ResearchEvent[] = [];
    const unsub = await t.subscribe('p-20261022-1a2b3c4d', (e) => got.push(e));
    expect(connectSpy).toHaveBeenLastCalledWith('/research/p-20261022-1a2b3c4d');
    const e = { type: 'project.created', projectId: 'p-20261022-1a2b3c4d', ts: '2026-10-22T00:00:00Z', data: { topic: 't', parentProjectId: null } };
    observer!.next({ id: 'x', type: 'data', event: e });
    observer!.next({ id: 'x', type: 'data', event: JSON.stringify(e) });
    observer!.next(JSON.stringify(e));
    observer!.next(e);
    expect(got.map((g) => g.type)).toEqual(['project.created', 'project.created', 'project.created', 'project.created']);
    unsub();
  });

  it('startResearch posts to the agents gateway with the bearer token and a session id', async () => {
    const calls = fakeFetch(() => new Response(JSON.stringify({ projectId: 'p-20261022-1a2b3c4d', status: 'accepted' }), { status: 200 }));
    const t = new LiveTransport(cfg, () => undefined);
    await t.startResearch({ projectId: 'p-20261022-1a2b3c4d', topic: '主題', parentProjectId: null });
    expect(calls[0].url).toBe('https://agents.example.com/research/invocations');
    expect(calls[0].headers.Authorization).toBe('Bearer access-token-123');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    const sid = calls[0].headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'];
    expect(sid.length).toBeGreaterThanOrEqual(33);
    expect(sid.length).toBeLessThanOrEqual(256);
    expect(calls[0].body).toEqual({ action: 'start', projectId: 'p-20261022-1a2b3c4d', topic: '主題', parentProjectId: null });
  });
});
