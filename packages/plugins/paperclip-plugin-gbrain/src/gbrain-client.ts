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
  result?: { content?: Array<{ type: string; text?: string }> } | unknown;
  error?: { code: number; message: string };
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

      const json = (await resp.json()) as JsonRpcResponse;
      if (json.error) {
        throw new GbrainCallError(
          `JSON-RPC error ${json.error.code}: ${json.error.message}`,
        );
      }

      const result = json.result as
        | { content?: Array<{ type: string; text?: string }> }
        | undefined;
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
