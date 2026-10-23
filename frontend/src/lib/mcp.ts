/*
 * Minimal MCP (JSON-RPC over Streamable HTTP) client for the tools gateway.
 * initialize -> notifications/initialized -> tools/call. Handles JSON and SSE bodies.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const CLIENT_INFO = { name: 'god-eye-web', version: '0.1.0' } as const;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function isRpcResponse(v: unknown): v is JsonRpcResponse {
  return typeof v === 'object' && v !== null && 'jsonrpc' in v && ('result' in v || 'error' in v);
}

/** Picks the JSON-RPC response with the given id out of a JSON body or an SSE stream body. */
export function parseRpcBody(text: string, contentType: string | null, id: number): JsonRpcResponse | null {
  const pick = (v: unknown): JsonRpcResponse | null => {
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) if (isRpcResponse(v[i]) && v[i].id === id) return v[i];
      return null;
    }
    return isRpcResponse(v) && (v.id === id || v.id === null) ? v : null;
  };
  const trimmed = text.trim();
  const looksSse = (contentType ?? '').includes('text/event-stream') || /^(event|data|id|retry):/m.test(trimmed.slice(0, 200));
  if (!looksSse) {
    try {
      return pick(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  // SSE: events are separated by blank lines; data lines of one event are joined with "\n".
  let found: JsonRpcResponse | null = null;
  for (const block of trimmed.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      const r = pick(JSON.parse(data));
      if (r) found = r; // keep the last match
    } catch {
      /* not JSON, ignore */
    }
  }
  return found;
}

export interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}

/** Unwraps an MCP tool result: parses `content[0].text` as JSON; throws when `isError`. */
export function unwrapToolResult(result: unknown): unknown {
  const r = (result ?? {}) as ToolResult;
  const text = r.content?.find((c) => c.type === 'text' && typeof c.text === 'string')?.text ?? r.content?.[0]?.text;
  if (r.isError) throw new Error(text || '工具回傳錯誤');
  let value: unknown = text === undefined ? (r.structuredContent ?? null) : text;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  // The tool Lambdas report business errors as a normal result: { ok: false, error | errors | reason }.
  if (value && typeof value === 'object' && (value as { ok?: unknown }).ok === false) {
    const v = value as { error?: string; errors?: string[]; reason?: string };
    throw new Error(v.error || v.reason || (v.errors ?? []).join('；') || '工具執行失敗');
  }
  return value;
}

export class McpClient {
  private sessionId: string | null = null;
  private initializing: Promise<void> | null = null;
  private seq = 0;

  constructor(
    private readonly url: string,
    private readonly getToken: () => Promise<string>,
  ) {}

  private async post(body: unknown, expectResponse: boolean): Promise<JsonRpcResponse | null> {
    const token = await this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
      headers['MCP-Protocol-Version'] = MCP_PROTOCOL_VERSION;
    }
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 404 && this.sessionId) this.reset(); // session expired: re-initialize next time
      throw new Error(`MCP HTTP ${res.status}${text ? ': ' + text.slice(0, 300) : ''}`);
    }
    if (!expectResponse) return null;
    const id = (body as { id: number }).id;
    const parsed = parseRpcBody(text, res.headers.get('Content-Type'), id);
    if (!parsed) throw new Error('MCP 回應格式無法解析');
    if (parsed.error) throw new Error(`MCP ${parsed.error.code}: ${parsed.error.message}`);
    return parsed;
  }

  private reset() {
    this.sessionId = null;
    this.initializing = null;
  }

  private ensureInit(): Promise<void> {
    if (!this.initializing) {
      this.initializing = (async () => {
        await this.post(
          {
            jsonrpc: '2.0',
            id: ++this.seq,
            method: 'initialize',
            params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
          },
          true,
        );
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
      })().catch((err) => {
        this.reset();
        throw err;
      });
    }
    return this.initializing;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInit();
    const res = await this.post({ jsonrpc: '2.0', id: ++this.seq, method: 'tools/call', params: { name, arguments: args } }, true);
    return unwrapToolResult(res?.result);
  }
}
