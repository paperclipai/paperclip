export type OpenCrabToolName =
  | "opencrab_status"
  | "opencrab_query"
  | "opencrab_search_documents"
  | "opencrab_search_nodes"
  | "opencrab_get_node_context"
  | "opencrab_search_packs"
  | "opencrab_ingest_text";

export interface OpenCrabTransportCall {
  tool: OpenCrabToolName;
  arguments: Record<string, unknown>;
}

export type OpenCrabTransport = (call: OpenCrabTransportCall) => Promise<unknown>;

export interface OpenCrabClientOptions {
  endpoint: string;
  transport?: OpenCrabTransport;
  timeoutMs?: number;
  maxLimit?: number;
  defaultLimit?: number;
  ingestEnabled?: boolean;
}

export interface OpenCrabQueryParams {
  query: string;
  topK?: number;
  workspaceId?: string;
}

export interface OpenCrabSearchDocumentsParams {
  query: string;
  limit?: number;
  sourceType?: string;
  workspaceId?: string;
}

export interface OpenCrabSearchNodesParams {
  query: string;
  limit?: number;
  nodeType?: string;
  sourceType?: string;
  workspaceId?: string;
}

export interface OpenCrabNodeContextParams {
  nodeId: string;
  limit?: number;
  workspaceId?: string;
}

export interface OpenCrabSearchPacksParams {
  query?: string;
  category?: string;
  licenseScope?: string;
  workspaceId?: string;
  limit?: number;
}

export interface OpenCrabIngestTextParams {
  text: string;
  sourceId?: string;
  metadata?: Record<string, unknown>;
  workspaceId?: string;
}

export class OpenCrabClientError extends Error {
  readonly safeEndpoint: string;
  readonly causeError?: unknown;

  constructor(message: string, safeEndpoint: string, causeError?: unknown) {
    super(message);
    this.name = "OpenCrabClientError";
    this.safeEndpoint = safeEndpoint;
    this.causeError = causeError;
  }
}

export function redactOpenCrabEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.hostname === "opencrab.sh" && url.pathname.includes("/api/mcp/")) {
      return `${url.origin}/api/mcp/[REDACTED]`;
    }
    if (url.pathname.includes("/api/mcp/")) {
      const prefix = url.pathname.split("/api/mcp/")[0];
      return `${url.origin}${prefix}/api/mcp/[REDACTED]`;
    }
  } catch {
    return "[REDACTED]";
  }
  return "[REDACTED]";
}

export function clampOpenCrabLimit(value: number | undefined, max = 50, fallback = 10): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function withOptionalString(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (typeof value === "string" && value.trim().length > 0) target[key] = value;
}

function redactErrorMessage(message: string, safeEndpoint: string): string {
  return message
    .replace(/https:\/\/opencrab\.sh\/api\/mcp\/[^\s"')]+/g, safeEndpoint)
    .replace(/ocm_[A-Za-z0-9._-]+/g, "[REDACTED]")
    .replace(/(api\/mcp\/)[^\s"')]+/g, "$1[REDACTED]");
}

export class OpenCrabClient {
  private readonly endpoint: string;
  private readonly safeEndpoint: string;
  private readonly transport: OpenCrabTransport;
  private readonly timeoutMs: number;
  private readonly maxLimit: number;
  private readonly defaultLimit: number;
  private readonly ingestEnabled: boolean;

  constructor(options: OpenCrabClientOptions) {
    this.endpoint = options.endpoint;
    this.safeEndpoint = redactOpenCrabEndpoint(options.endpoint);
    this.transport = options.transport ?? createHttpOpenCrabTransport(options.endpoint, options.timeoutMs ?? 30_000);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxLimit = options.maxLimit ?? 50;
    this.defaultLimit = options.defaultLimit ?? 10;
    this.ingestEnabled = options.ingestEnabled === true;
  }

  async status(): Promise<unknown> {
    return this.call("opencrab_status", {});
  }

  async query(params: OpenCrabQueryParams): Promise<unknown> {
    return this.call("opencrab_query", {
      query: params.query,
      top_k: clampOpenCrabLimit(params.topK, this.maxLimit, this.defaultLimit),
      ...(params.workspaceId ? { workspace_id: params.workspaceId } : {}),
    });
  }

  async searchDocuments(params: OpenCrabSearchDocumentsParams): Promise<unknown> {
    const args: Record<string, unknown> = {
      query: params.query,
      limit: clampOpenCrabLimit(params.limit, this.maxLimit, this.defaultLimit),
    };
    withOptionalString(args, "source_type", params.sourceType);
    withOptionalString(args, "workspace_id", params.workspaceId);
    return this.call("opencrab_search_documents", args);
  }

  async searchNodes(params: OpenCrabSearchNodesParams): Promise<unknown> {
    const args: Record<string, unknown> = {
      query: params.query,
      limit: clampOpenCrabLimit(params.limit, this.maxLimit, this.defaultLimit),
    };
    withOptionalString(args, "node_type", params.nodeType);
    withOptionalString(args, "source_type", params.sourceType);
    withOptionalString(args, "workspace_id", params.workspaceId);
    return this.call("opencrab_search_nodes", args);
  }

  async getNodeContext(params: OpenCrabNodeContextParams): Promise<unknown> {
    const args: Record<string, unknown> = {
      node_id: params.nodeId,
      limit: clampOpenCrabLimit(params.limit, this.maxLimit, this.defaultLimit),
    };
    withOptionalString(args, "workspace_id", params.workspaceId);
    return this.call("opencrab_get_node_context", args);
  }

  async searchPacks(params: OpenCrabSearchPacksParams = {}): Promise<unknown> {
    const args: Record<string, unknown> = {
      limit: clampOpenCrabLimit(params.limit, this.maxLimit, this.defaultLimit),
    };
    withOptionalString(args, "query", params.query);
    withOptionalString(args, "category", params.category);
    withOptionalString(args, "license_scope", params.licenseScope);
    withOptionalString(args, "workspace_id", params.workspaceId);
    return this.call("opencrab_search_packs", args);
  }

  async ingestText(params: OpenCrabIngestTextParams): Promise<unknown> {
    if (!this.ingestEnabled) {
      throw new OpenCrabClientError("OpenCrab ingest is disabled; explicit approval is required before knowledge mutation.", this.safeEndpoint);
    }
    const args: Record<string, unknown> = { text: params.text };
    withOptionalString(args, "source_id", params.sourceId);
    withOptionalString(args, "workspace_id", params.workspaceId);
    if (params.metadata) args.metadata = params.metadata;
    return this.call("opencrab_ingest_text", args);
  }

  private async call(tool: OpenCrabToolName, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.withTimeout(this.transport({ tool, arguments: args }));
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const safeMessage = redactErrorMessage(rawMessage, this.safeEndpoint);
      throw new OpenCrabClientError(`OpenCrab tool ${tool} failed via ${this.safeEndpoint}: ${safeMessage}`, this.safeEndpoint, error);
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`OpenCrab request timed out after ${this.timeoutMs}ms`));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export function createHttpOpenCrabTransport(endpoint: string, timeoutMs = 30_000): OpenCrabTransport {
  return async (call: OpenCrabTransportCall): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: {
            name: call.tool,
            arguments: call.arguments,
          },
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      if (!text.trim()) return null;
      const parsed = JSON.parse(text) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "result" in parsed &&
        parsed.result &&
        typeof parsed.result === "object" &&
        "content" in parsed.result
      ) {
        return parsed.result;
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  };
}
