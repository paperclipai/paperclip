export interface ServerGbrainClientOptions {
  url?: string;
  bearerToken?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ServerGbrainClient {
  call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T>;
}

export class ServerGbrainCallError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ServerGbrainCallError";
  }
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?:
    | {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      }
    | unknown;
  error?: { code: number; message: string };
}

const DEFAULT_GBRAIN_MCP_URL = "http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/mcp";

function parseMcpResponseBody(text: string): JsonRpcResponse {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpcResponse;
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
  }
  throw new Error(`unexpected MCP response body: ${text.slice(0, 120)}`);
}

class HttpServerGbrainClient implements ServerGbrainClient {
  private nextId = 1;

  constructor(private readonly opts: Required<Omit<ServerGbrainClientOptions, "bearerToken">> & { bearerToken?: string }) {}

  async call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      if (this.opts.bearerToken) headers.authorization = `Bearer ${this.opts.bearerToken}`;

      const resp = await this.opts.fetch(this.opts.url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
      });
      if (!resp.ok) throw new ServerGbrainCallError(`HTTP ${resp.status} from ${this.opts.url}`);
      const json = parseMcpResponseBody(await resp.text());
      if (json.error) throw new ServerGbrainCallError(`JSON-RPC error ${json.error.code}: ${json.error.message}`);

      const result = json.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
      if (result?.isError === true) return null as T;
      const text = result?.content?.[0]?.text;
      if (typeof text !== "string") return result as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    } catch (err) {
      if (err instanceof ServerGbrainCallError) throw err;
      throw new ServerGbrainCallError(err instanceof Error ? err.message : String(err), err);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createServerGbrainClient(opts: ServerGbrainClientOptions = {}): ServerGbrainClient {
  return new HttpServerGbrainClient({
    url: opts.url ?? process.env.PAPERCLIP_GBRAIN_MCP_URL ?? DEFAULT_GBRAIN_MCP_URL,
    bearerToken: opts.bearerToken ?? process.env.PAPERCLIP_GBRAIN_MCP_BEARER_TOKEN,
    fetch: opts.fetch ?? fetch,
    timeoutMs: opts.timeoutMs ?? 500,
  });
}
