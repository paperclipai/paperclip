import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONTEXT_SUMMARY_LIMIT, HONCHO_CONNECTION_PROBE_PATH, HONCHO_V2_PATH, HONCHO_V3_PATH } from "./constants.js";
import { peerIdForAgent, sessionIdForIssue, workspaceIdForCompany } from "./ids.js";
import type {
  AskPeerParams,
  HonchoChatResult,
  HonchoClientInput,
  HonchoIssueContext,
  HonchoMessageInput,
  HonchoRepresentationResult,
  HonchoResolvedConfig,
  HonchoSearchResult,
  HonchoSessionSummary,
  SearchMemoryParams,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

async function parseJson(res: Response | { status: number; body: string }) {
  if ("json" in res) {
    const text = await res.text();
    return text ? JSON.parse(text) as JsonRecord : {};
  }
  return res.body ? JSON.parse(res.body) as JsonRecord : {};
}

async function assertOk(res: Response | { status: number; body: string }, context: string) {
  const status = "status" in res ? res.status : 200;
  if (status >= 200 && status < 300) return;
  let message = `${context} failed with status ${status}`;
  try {
    const payload = await parseJson(res);
    if (typeof payload.error === "string") {
      message = `${context} failed: ${payload.error}`;
    } else if (typeof payload.message === "string") {
      message = `${context} failed: ${payload.message}`;
    }
  } catch {
    // ignore parse errors
  }
  throw new Error(message);
}

function joinUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

async function requestJson(
  ctx: PluginContext,
  config: HonchoResolvedConfig,
  apiKey: string,
  pathname: string,
  init: RequestInit,
): Promise<JsonRecord> {
  const res = await ctx.http.fetch(joinUrl(config.honchoApiBaseUrl, pathname), {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
  });
  await assertOk(res, pathname);
  return await parseJson(res);
}

export class HonchoClient {
  private readonly ctx: PluginContext;
  private readonly config: HonchoResolvedConfig;
  private readonly apiKey: string;

  constructor(input: HonchoClientInput & { apiKey: string }) {
    this.ctx = input.ctx;
    this.config = input.config;
    this.apiKey = input.apiKey;
  }

  workspaceId(companyId: string): string {
    return workspaceIdForCompany(companyId, this.config.workspacePrefix);
  }

  sessionId(issueId: string): string {
    return sessionIdForIssue(issueId);
  }

  async ensureWorkspace(companyId: string): Promise<string> {
    const workspaceId = this.workspaceId(companyId);
    await requestJson(this.ctx, this.config, this.apiKey, `${HONCHO_V3_PATH}/workspaces`, {
      method: "POST",
      body: JSON.stringify({
        id: workspaceId,
        metadata: {
          source_system: "paperclip",
          company_id: companyId,
        },
      }),
    });
    return workspaceId;
  }

  async probeConnection(): Promise<{ workspaceId: string | null }> {
    const payload = await requestJson(this.ctx, this.config, this.apiKey, HONCHO_CONNECTION_PROBE_PATH, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const workspaceId = typeof payload.id === "string"
      ? payload.id
      : typeof payload.workspace_id === "string"
        ? payload.workspace_id
        : null;
    return { workspaceId };
  }

  async ensurePeer(companyId: string, peerId: string, metadata?: Record<string, unknown>): Promise<string> {
    const workspaceId = await this.ensureWorkspace(companyId);
    await requestJson(this.ctx, this.config, this.apiKey, `${HONCHO_V3_PATH}/workspaces/${encodeURIComponent(workspaceId)}/peers`, {
      method: "POST",
      body: JSON.stringify({
        id: peerId,
        metadata: {
          source_system: "paperclip",
          ...metadata,
        },
      }),
    });
    return peerId;
  }

  async ensureSession(companyId: string, issueId: string, metadata?: Record<string, unknown>): Promise<string> {
    const workspaceId = await this.ensureWorkspace(companyId);
    const sessionId = this.sessionId(issueId);
    await requestJson(this.ctx, this.config, this.apiKey, `${HONCHO_V3_PATH}/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        id: sessionId,
        metadata: {
          source_system: "paperclip",
          company_id: companyId,
          issue_id: issueId,
          ...metadata,
        },
      }),
    });
    return sessionId;
  }

  async appendMessages(companyId: string, issueId: string, messages: HonchoMessageInput[]): Promise<void> {
    if (messages.length === 0) return;
    const sessionId = await this.ensureSession(companyId, issueId);
    const workspaceId = this.workspaceId(companyId);
    await requestJson(
      this.ctx,
      this.config,
      this.apiKey,
      `${HONCHO_V3_PATH}/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          messages: messages.map((message, index) => ({
            id: `${message.metadata.contentType}:${message.metadata.commentId ?? message.metadata.documentRevisionId ?? index}`,
            peer_id: message.peerId,
            content: message.content,
            created_at: message.createdAt,
            metadata: message.metadata,
          })),
        }),
      },
    );
  }

  async getIssueContext(companyId: string, issueId: string): Promise<HonchoIssueContext> {
    const sessionId = await this.ensureSession(companyId, issueId);
    const workspaceId = this.workspaceId(companyId);
    const payload = await requestJson(
      this.ctx,
      this.config,
      this.apiKey,
      `${HONCHO_V2_PATH}/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/summaries`,
      {
        method: "GET",
      },
    );
    const summaries = Array.isArray(payload.summaries)
      ? (payload.summaries as HonchoSessionSummary[])
      : Array.isArray(payload.items)
        ? (payload.items as HonchoSessionSummary[])
        : [];
    const preview = summaries
      .map((summary) => summary.summary ?? summary.content ?? "")
      .filter((value) => value.trim().length > 0)
      .slice(0, DEFAULT_CONTEXT_SUMMARY_LIMIT)
      .join("\n\n")
      .trim() || null;
    return {
      issueId,
      issueIdentifier: null,
      sessionId,
      workspaceId,
      summaries,
      preview,
    };
  }

  async searchMemory(companyId: string, agentId: string, params: SearchMemoryParams): Promise<HonchoSearchResult[]> {
    await this.ensurePeer(companyId, peerIdForAgent(agentId), {
      company_id: companyId,
      agent_id: agentId,
    });
    const workspaceId = this.workspaceId(companyId);
    const scopedSessionId = params.scope === "workspace" ? undefined : params.issueId ? this.sessionId(params.issueId) : undefined;
    const payload = await requestJson(
      this.ctx,
      this.config,
      this.apiKey,
      `${HONCHO_V3_PATH}/workspaces/${encodeURIComponent(workspaceId)}/peers/${encodeURIComponent(peerIdForAgent(agentId))}/representation`,
      {
        method: "POST",
        body: JSON.stringify({
          session_id: scopedSessionId,
          target: scopedSessionId,
          search_query: params.query,
          search_top_k: params.limit,
        }),
      },
    );
    const data = payload as HonchoRepresentationResult;
    if (Array.isArray(data.results)) return data.results;
    if (typeof data.representation === "string" && data.representation.trim()) {
      return [{ id: "representation", content: data.representation, metadata: data.metadata ?? null, score: null }];
    }
    if (typeof data.content === "string" && data.content.trim()) {
      return [{ id: "content", content: data.content, metadata: data.metadata ?? null, score: null }];
    }
    return [];
  }

  async askPeer(companyId: string, agentId: string, params: AskPeerParams): Promise<HonchoChatResult> {
    const workspaceId = await this.ensureWorkspace(companyId);
    const payload = await requestJson(
      this.ctx,
      this.config,
      this.apiKey,
      `${HONCHO_V3_PATH}/workspaces/${encodeURIComponent(workspaceId)}/peers/${encodeURIComponent(peerIdForAgent(agentId))}/chat`,
      {
        method: "POST",
        body: JSON.stringify({
          target: params.targetPeerId,
          query: params.query,
          session_id: params.issueId ? this.sessionId(params.issueId) : undefined,
        }),
      },
    );
    return payload as HonchoChatResult;
  }
}

export async function createHonchoClient(input: HonchoClientInput): Promise<HonchoClient> {
  const apiKey = await input.ctx.secrets.resolve(input.config.honchoApiKeySecretRef);
  return new HonchoClient({ ...input, apiKey });
}
