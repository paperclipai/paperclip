// Thin Honcho v3 client used by the Ordillect brain-mirror plugin.
//
// The Honcho self-host verified in AGE-92 exposes:
//   POST /v3/workspaces                                   { id }
//   POST /v3/workspaces/{ws}/peers                        { id, metadata }
//   POST /v3/workspaces/{ws}/sessions                     { id, metadata }
//   POST /v3/workspaces/{ws}/sessions/{sid}/peers         { <peerId>: { ... } }
//   POST /v3/workspaces/{ws}/sessions/{sid}/messages      { messages: [...] }
//
// Peer/session IDs must match ^[A-Za-z0-9_-]+$.

export interface HonchoClientOptions {
  baseUrl: string;
  workspace: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface MirrorMessage {
  peerId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export class HonchoClient {
  private readonly base: string;
  private readonly workspace: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HonchoClientOptions) {
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.workspace = opts.workspace;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    // Honcho returns 200/201 for both create and idempotent "already exists"
    // paths. Non-2xx is always an error.
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`honcho POST ${path} → ${res.status} ${text}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async ensureWorkspace(): Promise<void> {
    await this.post("/v3/workspaces", { id: this.workspace });
  }

  async ensurePeer(peerId: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.post(`/v3/workspaces/${this.workspace}/peers`, {
      id: peerId,
      metadata: metadata ?? {},
    });
  }

  async ensureSession(sessionId: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.post(`/v3/workspaces/${this.workspace}/sessions`, {
      id: sessionId,
      metadata: metadata ?? {},
    });
  }

  async addSessionPeers(sessionId: string, peerIds: string[]): Promise<void> {
    if (peerIds.length === 0) return;
    const payload: Record<string, unknown> = {};
    for (const pid of peerIds) payload[pid] = {};
    await this.post(
      `/v3/workspaces/${this.workspace}/sessions/${sessionId}/peers`,
      payload,
    );
  }

  async postMessage(sessionId: string, message: MirrorMessage): Promise<unknown> {
    return this.post(
      `/v3/workspaces/${this.workspace}/sessions/${sessionId}/messages`,
      {
        messages: [
          {
            peer_id: message.peerId,
            content: message.content,
            metadata: message.metadata ?? {},
          },
        ],
      },
    );
  }
}

// Peer id derivation. Paperclip agent ids map to `agent-{role}` when known
// (registered by scripts/honcho-register-peers.mjs), else `agent-{id}`.
// Human commenters map to `user-{userId}`. Deleted-author fallback: `bot`.

const AGENT_PEER_MAP: Record<string, string> = {
  "9ce4abb5-e3ed-45bc-8cdc-8f735ea27708": "agent-ceo",
  "afde9a62-ea2a-4a11-a94a-7edd03a00bf7": "agent-cto",
  "87dbfeb3-c0f9-4529-a98d-fb84dd69e504": "agent-cmo",
  "9944e435-8abb-420d-b543-ae9b8e9b087b": "agent-coo_hermes",
  "b635fd0b-e3b8-41cf-be9f-08c032716987": "agent-impl_lead",
  "e3fba8b2-4d4c-4ccf-81e7-8499be4a0f65": "agent-designer",
};

export function peerIdForComment(input: {
  authorType?: string | null;
  authorAgentId?: string | null;
  authorUserId?: string | null;
}): string {
  if (input.authorAgentId && AGENT_PEER_MAP[input.authorAgentId]) {
    return AGENT_PEER_MAP[input.authorAgentId];
  }
  if (input.authorAgentId) {
    return `agent-${input.authorAgentId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  }
  if (input.authorUserId) {
    return `user-${input.authorUserId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  }
  return "bot";
}

export function sessionIdForIssue(issueId: string): string {
  return `issue-${issueId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
