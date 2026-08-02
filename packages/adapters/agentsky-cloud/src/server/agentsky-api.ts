export type AgentskyEventEnvelope = {
  id: string;
  type: string;
  sessionId?: string;
  agent?: string;
  at?: string;
  [key: string]: unknown;
};

export type AgentskyEventsPage = {
  events: AgentskyEventEnvelope[];
  cursor: string | null;
  hasMore: boolean;
};

export type AgentskyAgentSummary = {
  slug: string;
  agentType?: string;
  llm?: string;
  archived?: boolean;
  displayName?: string;
};

export class AgentskyApiError extends Error {
  status: number;
  code: string | null;
  retryAfterSec: number | null;

  constructor(input: { status: number; code: string | null; message: string; retryAfterSec?: number | null }) {
    super(input.message);
    this.name = "AgentskyApiError";
    this.status = input.status;
    this.code = input.code;
    this.retryAfterSec = input.retryAfterSec ?? null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function readError(response: Response): Promise<AgentskyApiError> {
  let code: string | null = null;
  let message = `AgentSky API responded ${response.status}`;
  try {
    const body = asRecord(await response.json());
    const error = asRecord(body?.error);
    if (error) {
      if (typeof error.code === "string" && error.code) code = error.code;
      if (typeof error.message === "string" && error.message) message = error.message;
    }
  } catch {
    // Non-JSON error body; keep the status message.
  }
  const retryAfterRaw = response.headers.get("retry-after");
  const retryAfterSec = retryAfterRaw && /^\d+$/.test(retryAfterRaw.trim()) ? Number(retryAfterRaw.trim()) : null;
  return new AgentskyApiError({ status: response.status, code, message, retryAfterSec });
}

export type AgentskyClient = {
  whoami(): Promise<{ email: string | null; universe: string | null; scopes: string[] }>;
  getAgent(slug: string): Promise<AgentskyAgentSummary>;
  createAgent(input: {
    name: string;
    displayName?: string;
    agentType: string;
    llm: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AgentskyAgentSummary>;
  createSession(input: { agent: string; title?: string; metadata?: Record<string, unknown> }): Promise<{ id: string }>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  listEvents(sessionId: string, cursor: string | null, limit: number): Promise<AgentskyEventsPage>;
};

export function createAgentskyClient(input: { baseUrl: string; token: string }): AgentskyClient {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${input.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw await readError(response);
    if (response.status === 202 || response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  function readAgent(body: unknown): AgentskyAgentSummary {
    const agent = asRecord(asRecord(body)?.agent);
    const slug = typeof agent?.slug === "string" ? agent.slug : "";
    if (!slug) throw new AgentskyApiError({ status: 0, code: null, message: "AgentSky API returned no agent slug." });
    return {
      slug,
      agentType: typeof agent?.agentType === "string" ? agent.agentType : undefined,
      llm: typeof agent?.llm === "string" ? agent.llm : undefined,
      archived: agent?.archived === true,
      displayName: typeof agent?.displayName === "string" ? agent.displayName : undefined,
    };
  }

  return {
    async whoami() {
      const body = asRecord(await request("GET", "/whoami"));
      const user = asRecord(body?.user);
      const universe = asRecord(body?.universe);
      return {
        email: typeof user?.email === "string" ? user.email : null,
        universe: typeof universe?.slug === "string" ? universe.slug : null,
        scopes: Array.isArray(body?.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : [],
      };
    },
    async getAgent(slug) {
      return readAgent(await request("GET", `/agents/${encodeURIComponent(slug)}`));
    },
    async createAgent(body) {
      return readAgent(await request("POST", "/agents", body));
    },
    async createSession(body) {
      const parsed = asRecord(asRecord(await request("POST", "/sessions", body))?.session);
      const id = typeof parsed?.id === "string" ? parsed.id : "";
      if (!id) throw new AgentskyApiError({ status: 0, code: null, message: "AgentSky API returned no session id." });
      return { id };
    },
    async sendMessage(sessionId, text) {
      await request("POST", `/sessions/${encodeURIComponent(sessionId)}/messages`, {
        parts: [{ type: "text", index: 0, text }],
      });
    },
    async listEvents(sessionId, cursor, limit) {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      params.set("limit", String(limit));
      const body = asRecord(
        await request("GET", `/sessions/${encodeURIComponent(sessionId)}/events?${params.toString()}`),
      );
      const events = Array.isArray(body?.events)
        ? body.events
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry))
            .filter((entry): entry is AgentskyEventEnvelope =>
              typeof entry.id === "string" && typeof entry.type === "string")
        : [];
      return {
        events,
        cursor: typeof body?.cursor === "string" ? body.cursor : null,
        hasMore: body?.hasMore === true,
      };
    },
  };
}
