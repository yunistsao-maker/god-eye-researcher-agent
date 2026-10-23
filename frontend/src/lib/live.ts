/*
 * Live transport: Cognito (Amplify Auth) + AppSync Events + agents gateway + tools gateway (MCP).
 */
import { Amplify } from 'aws-amplify';
import { fetchAuthSession } from 'aws-amplify/auth';
import { events } from 'aws-amplify/data';
import type { AppConfig, ResearchEvent } from '../types';
import { parseEvent } from './events';
import { newSessionId } from './ids';
import { McpClient } from './mcp';
import { wireToolName, type LogFn, type StartResearchArgs, type Transport } from './transport';

let configured = false;

export function configureAmplify(cfg: AppConfig): void {
  if (configured) return;
  Amplify.configure({
    Auth: { Cognito: { userPoolId: cfg.userPoolId, userPoolClientId: cfg.userPoolClientId } },
    API: { Events: { endpoint: cfg.eventsHttpEndpoint, region: cfg.region, defaultAuthMode: 'userPool' } },
  });
  configured = true;
}

export async function accessToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken?.toString();
  if (!token) throw new Error('尚未登入，取不到 access token');
  return token;
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

function brief(args: Record<string, unknown>): string {
  const id = args.projectId ?? args.parentProjectId;
  return typeof id === 'string' ? ' · ' + id : '';
}

export class LiveTransport implements Transport {
  readonly mode = 'live' as const;
  private readonly mcp: McpClient;
  private readonly channels = new Set<{ close(): void }>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly log: LogFn,
  ) {
    configureAmplify(cfg);
    this.mcp = new McpClient(cfg.toolsMcpUrl || '/mcp', accessToken);
  }

  async subscribe(projectId: string, onEvent: (event: ResearchEvent) => void): Promise<() => void> {
    const path = '/research/' + projectId;
    const channel = await events.connect(path);
    this.channels.add(channel);
    const deliver = (raw: unknown) => {
      const ev = parseEvent(raw);
      if (ev) onEvent(ev);
      else this.log('note', '收到無法解析的事件，已忽略');
    };
    const sub = channel.subscribe({
      next: (data: unknown) => {
        // Batched publishes may arrive as an array of events.
        const payload = typeof data === 'object' && data !== null && 'event' in data ? (data as { event: unknown }).event : data;
        if (Array.isArray(payload)) payload.forEach(deliver);
        else deliver(data);
      },
      error: (err: unknown) => this.log('note', '訂閱錯誤 ' + path + '：' + (err instanceof Error ? err.message : String(err))),
    });
    // Wait for the server ACK so research is not invoked before the subscription is live.
    try {
      await Promise.race([sub.ready, new Promise((resolve) => setTimeout(resolve, 8000))]);
    } catch (err) {
      this.channels.delete(channel);
      channel.close();
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.log('note', '已訂閱 ' + path);
    return () => {
      sub.unsubscribe();
      channel.close();
      this.channels.delete(channel);
    };
  }

  async startResearch(args: StartResearchArgs): Promise<void> {
    const token = await accessToken();
    const sessionId = newSessionId(args.projectId);
    this.log('gw', `POST **research**/invocations · session ${args.projectId}`);
    const res = await fetch(`${trimSlash(this.cfg.agentsBaseUrl)}/research/invocations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
      },
      body: JSON.stringify({ action: 'start', projectId: args.projectId, topic: args.topic, parentProjectId: args.parentProjectId }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`research HTTP ${res.status}${text ? '：' + text.slice(0, 200) : ''}`);
    let status = '';
    try {
      status = (JSON.parse(text) as { status?: string }).status ?? '';
    } catch {
      /* body is optional */
    }
    this.log('note', 'research 已受理' + (status ? `（${status}）` : ''));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const wire = wireToolName(name);
    this.log('gw', `tools/call **${wire}**${brief(args)}`);
    return this.mcp.callTool(wire, args);
  }

  dispose(): void {
    this.channels.forEach((c) => c.close());
    this.channels.clear();
  }
}
