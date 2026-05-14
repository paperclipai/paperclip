export interface BrainMcpClient {
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface BrainMcpClientOptions {
  endpoint: string;
  bearerToken: string;
  timeoutMs?: number;
}

export class BrainMcpError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "BrainMcpError";
  }
}

export function createBrainMcpClient(opts: BrainMcpClientOptions): BrainMcpClient {
  const endpoint = opts.endpoint.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return {
    async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.bearerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ tool, args }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new BrainMcpError(
            `Brain MCP call failed: ${res.status} ${res.statusText} — ${body.slice(0, 500)}`,
            res.status,
          );
        }
        const json = (await res.json()) as { result?: unknown; error?: string };
        if (json.error) throw new BrainMcpError(json.error);
        return json.result;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
