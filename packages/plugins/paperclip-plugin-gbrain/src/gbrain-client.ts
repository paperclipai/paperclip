export interface GbrainClientOptions {
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class GbrainCallError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "GbrainCallError";
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

/**
 * The gbrain MCP server (supergateway-wrapped) requires both
 * application/json and text/event-stream in the Accept header, and chooses
 * SSE for its response. Parse the SSE envelope by extracting the JSON
 * payload from the first `data:` line. If the body is already JSON
 * (no `event:` prefix), use it as-is.
 */
function parseMcpResponseBody(text: string): JsonRpcResponse {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      return JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
    }
  }
  throw new Error(`unexpected MCP response body: ${text.slice(0, 120)}`);
}

export class GbrainClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(opts: GbrainClientOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const body = {
      jsonrpc: "2.0" as const,
      id,
      method: "tools/call",
      params: { name: tool, arguments: args },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new GbrainCallError(`HTTP ${resp.status} from ${this.url}`);
      }

      const bodyText = await resp.text();
      const json = parseMcpResponseBody(bodyText);
      if (json.error) {
        throw new GbrainCallError(
          `JSON-RPC error ${json.error.code}: ${json.error.message}`,
        );
      }

      const result = json.result as
        | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
        | undefined;
      // Tool-level error (e.g. get_page on a missing slug returns
      // result.isError=true with the error detail in content[0].text).
      // Surface that as a null return so callers can treat "not found"
      // as "no value" rather than treating the error envelope as data.
      if (result?.isError === true) {
        return null as T;
      }
      const text = result?.content?.[0]?.text;
      if (typeof text === "string") {
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      }
      return result as T;
    } catch (err) {
      if (err instanceof GbrainCallError) throw err;
      throw new GbrainCallError(
        err instanceof Error ? err.message : String(err),
        err,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
