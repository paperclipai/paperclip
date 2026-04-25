/**
 * Thin HTTP client around Paperclip's plugin-tools endpoints. Used by the
 * MCP bridge to translate `tools/list` and `tools/call` MCP requests into
 * Paperclip API calls scoped to a specific agent run.
 *
 * The token is the per-run agent JWT minted by
 * `server/src/agent-auth-jwt.ts#createLocalAgentJwt` — it identifies the
 * caller as `actor.type === "agent"` so that the routes (after the
 * #4192 PR) accept it.
 */

export interface RunContext {
  agentId: string;
  runId: string;
  companyId: string;
  projectId: string | null;
}

export interface PaperclipClientOpts {
  apiBase: string;
  token: string;
  runContext: RunContext;
  /** Hard timeout per HTTP call in ms. Defaults to 30000. */
  timeoutMs?: number;
}

export interface AgentToolDescriptor {
  name: string;
  displayName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  pluginId: string;
  pluginDbId: string;
}

export interface ToolExecuteResult {
  pluginId?: string;
  toolName?: string;
  result?: { content?: string; data?: unknown; error?: string };
  error?: string;
}

export interface PaperclipClient {
  listTools(): Promise<AgentToolDescriptor[]>;
  executeTool(name: string, parameters: unknown): Promise<ToolExecuteResult>;
}

export function createPaperclipClient(opts: PaperclipClientOpts): PaperclipClient {
  const headers = { Authorization: `Bearer ${opts.token}` };
  const timeoutMs = opts.timeoutMs ?? 30_000;

  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${opts.apiBase}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { ...headers, ...(init?.headers ?? {}) },
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${text || "(empty body)"}`);
      }
      return text ? (JSON.parse(text) as T) : (undefined as T);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async listTools() {
      return fetchJson<AgentToolDescriptor[]>("/api/plugins/tools");
    },
    async executeTool(name, parameters) {
      return fetchJson<ToolExecuteResult>("/api/plugins/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: name,
          parameters,
          runContext: opts.runContext,
        }),
      });
    },
  };
}
