import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  MemoryAdapter,
  MemoryAdapterCapabilities,
  MemoryWriteRequest,
  MemoryQueryRequest,
  MemoryRecordHandle,
  MemoryScope,
  MemorySnippet,
  MemoryContextBundle,
  MemoryUsage,
} from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_KEY = "mempalace";

// ---------------------------------------------------------------------------
// Handle encoding helpers
// ---------------------------------------------------------------------------

/**
 * Encodes a mempalace drawer reference as a MemoryRecordHandle.
 * Format: "wing/room/drawerId" or just "drawerId" for global references.
 */
function encodeHandle(drawerId: string, wing?: string, room?: string): MemoryRecordHandle {
  const parts: string[] = [];
  if (wing) parts.push(wing);
  if (room) parts.push(room);
  parts.push(drawerId);
  return { providerKey: PROVIDER_KEY, providerRecordId: parts.join("/") };
}

function decodeHandle(handle: MemoryRecordHandle): {
  drawerId: string;
  wing?: string;
  room?: string;
} {
  const parts = handle.providerRecordId.split("/");
  if (parts.length === 3) {
    return { wing: parts[0], room: parts[1], drawerId: parts[2] };
  }
  if (parts.length === 2) {
    return { wing: parts[0], drawerId: parts[1] };
  }
  return { drawerId: parts[0] };
}

// ---------------------------------------------------------------------------
// Scope → mempalace hierarchy mapping
//
// Company isolation: each company gets its own mempalace sidecar process
// with a separate palace directory. Isolation is enforced at the process
// level (RED-47), not by wing naming. The adapter therefore does not
// encode companyId into the wing — it is implicit in which sidecar the
// adapter is connected to.
//
// Hierarchy:
//   projectId  → wing   (e.g. "project-{short-id}")
//   agentId    → wing   (e.g. "agent-{short-id}"), used when no project
//   issueId    → room   (e.g. "issue-{short-id}")
//   runId      → metadata tag on drawers, not a room
//   subjectId  → metadata tag, passed through to drawer tags
// ---------------------------------------------------------------------------

function scopeToWing(scope: MemoryScope): string | undefined {
  if (scope.projectId) return `project-${scope.projectId.slice(0, 8)}`;
  if (scope.agentId) return `agent-${scope.agentId.slice(0, 8)}`;
  return undefined;
}

function scopeToRoom(scope: MemoryScope): string | undefined {
  if (scope.issueId) return `issue-${scope.issueId.slice(0, 8)}`;
  return undefined;
}

/**
 * Builds a source_file provenance string from scope and source.
 * mempalace stores this in drawer metadata for traceability.
 */
function buildSourceFile(
  scope: MemoryScope,
  source?: { kind: string; issueId?: string; runId?: string; commentId?: string; documentKey?: string; companyId: string; activityId?: string; externalRef?: string },
): string {
  const parts: string[] = [];
  if (source?.kind) parts.push(source.kind);
  if (source?.issueId) parts.push(`issue:${source.issueId.slice(0, 8)}`);
  if (source?.runId) parts.push(`run:${source.runId.slice(0, 8)}`);
  if (scope.agentId) parts.push(`agent:${scope.agentId.slice(0, 8)}`);
  return parts.join("/") || "paperclip";
}

// ---------------------------------------------------------------------------
// MCP tool call helpers
// ---------------------------------------------------------------------------

interface ToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

function extractText(result: ToolCallResult): string {
  return result.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mempalace Memory Adapter
// ---------------------------------------------------------------------------

export interface MempalaceAdapterConfig {
  /**
   * Remote MCP server URL (e.g. "http://mempalace:8080/mcp").
   * When set, the adapter connects over Streamable HTTP instead of spawning
   * a local child process. This is the expected mode for Docker Compose /
   * Podman pod deployments where mempalace runs as a separate container.
   */
  url?: string;
  /** Command to start the mempalace MCP server (default: "python"). Ignored when `url` is set. */
  command?: string;
  /** Arguments for the command (default: ["-m", "mempalace.mcp_server"]). Ignored when `url` is set. */
  args?: string[];
  /** Working directory for the mempalace process. Ignored when `url` is set. */
  cwd?: string;
  /** Environment variables for the mempalace process. Ignored when `url` is set. */
  env?: Record<string, string>;
  /** Connection timeout in ms (default: 15000). */
  connectTimeoutMs?: number;
  /** Per-tool-call timeout in ms (default: 30000). */
  callTimeoutMs?: number;
}

export function createMempalaceMemoryAdapter(
  config: MempalaceAdapterConfig,
): MemoryAdapter & {
  /** Connect to the mempalace MCP server. Must be called before any operations. */
  connect(): Promise<void>;
  /** Disconnect from the mempalace MCP server and kill the sidecar. */
  disconnect(): Promise<void>;
  /** Lightweight liveness check using MCP protocol ping. */
  ping(): Promise<void>;
  /** Whether the adapter is currently connected. */
  readonly connected: boolean;
} {
  const remoteUrl = config.url;
  const command = config.command ?? "python";
  const args = config.args ?? ["-m", "mempalace.mcp_server"];
  const cwd = config.cwd;
  const env = config.env;
  const connectTimeoutMs = config.connectTimeoutMs ?? 15_000;
  const callTimeoutMs = config.callTimeoutMs ?? 30_000;

  let client: Client | null = null;
  let transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
  let _connected = false;

  // ── Connection lifecycle ────────────────────────────────────────────

  async function connect(): Promise<void> {
    if (_connected) return;

    if (remoteUrl) {
      transport = new StreamableHTTPClientTransport(new URL(remoteUrl));
    } else {
      transport = new StdioClientTransport({
        command,
        args,
        cwd,
        env,
        stderr: "pipe",
      });
    }

    client = new Client(
      { name: "paperclip-mempalace", version: "1.0.0" },
    );

    await client.connect(transport, {
      timeout: connectTimeoutMs,
    });
    _connected = true;
  }

  async function disconnect(): Promise<void> {
    if (!_connected || !client) return;
    try {
      await client.close();
    } catch {
      // best-effort cleanup
    }
    client = null;
    transport = null;
    _connected = false;
  }

  function ensureConnected(): Client {
    if (!_connected || !client) {
      throw new Error("Mempalace adapter is not connected. Call connect() first.");
    }
    return client;
  }

  /**
   * Call a mempalace MCP tool with timeout.
   *
   * If the call fails with a connection-level error, attempt a single
   * reconnect before propagating the failure. This handles the case where
   * a remote mempalace container or local sidecar crashes and restarts
   * while the paperclip server keeps running.
   */
  async function callTool(
    name: string,
    args_: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const tryCall = async (c: Client) => {
      const result = await c.callTool(
        { name, arguments: args_ },
        undefined,
        { timeout: callTimeoutMs },
      );
      const typed = result as ToolCallResult;
      if (typed.isError) {
        const msg = extractText(typed) || `MCP tool "${name}" returned an error`;
        throw new Error(msg);
      }
      return typed;
    };

    const isTransportError = (err: unknown): boolean =>
      err instanceof Error &&
      (/ECONN|EPIPE|ENETUNREACH|socket hang up/i.test(err.message) ||
        err.name === "AbortError");

    try {
      const c = ensureConnected();
      return await tryCall(c);
    } catch (err) {
      // Only retry on transport-level failures to avoid duplicate writes
      if (!isTransportError(err)) throw err;
      try {
        await disconnect();
        await connect();
        const c = ensureConnected();
        return await tryCall(c);
      } catch {
        throw err;
      }
    }
  }

  // ── Write ───────────────────────────────────────────────────────────

  async function write(req: MemoryWriteRequest): Promise<{
    records?: MemoryRecordHandle[];
    usage?: MemoryUsage[];
  }> {
    // wing and room are required by mempalace_add_drawer
    const wing = (req.metadata?.wing as string) ?? scopeToWing(req.scope) ?? "general";
    const room = (req.metadata?.room as string) ?? scopeToRoom(req.scope) ?? "default";

    const sourceFile = buildSourceFile(req.scope, req.source);

    const start = Date.now();

    if (req.mode === "upsert" && req.metadata?.drawerId) {
      // mempalace has no update — delete then re-add
      try {
        await callTool("mempalace_delete_drawer", { drawer_id: req.metadata.drawerId });
      } catch {
        // drawer may not exist yet, continue with add
      }

      const result = await callTool("mempalace_add_drawer", {
        wing,
        room,
        content: req.content,
        source_file: sourceFile,
        added_by: "paperclip",
      });
      const latency = Date.now() - start;
      const text = extractText(result);
      const parsed = tryParseJson(text) as Record<string, unknown> | null;
      const drawerId = (parsed?.drawer_id as string) ?? (req.metadata.drawerId as string);

      return {
        records: [encodeHandle(drawerId, wing, room)],
        usage: [{
          provider: PROVIDER_KEY,
          latencyMs: latency,
          details: { method: "upsert_drawer", wing, room },
        }],
      };
    }

    // Default: add new drawer
    const result = await callTool("mempalace_add_drawer", {
      wing,
      room,
      content: req.content,
      source_file: sourceFile,
      added_by: "paperclip",
    });
    const latency = Date.now() - start;
    const text = extractText(result);
    const parsed = tryParseJson(text) as Record<string, unknown> | null;

    // mempalace returns the drawer_id in the response
    const drawerId = (parsed?.drawer_id as string) ?? `drawer-${Date.now()}`;

    return {
      records: [encodeHandle(drawerId, wing, room)],
      usage: [{
        provider: PROVIDER_KEY,
        latencyMs: latency,
        details: { method: "add_drawer", wing, room },
      }],
    };
  }

  // ── Query ───────────────────────────────────────────────────────────

  async function query(req: MemoryQueryRequest): Promise<MemoryContextBundle> {
    const start = Date.now();

    // For preamble intent, use mempalace_status for a palace overview
    if (req.intent === "agent_preamble") {
      const result = await callTool("mempalace_status", {});
      const latency = Date.now() - start;
      const text = extractText(result);

      return {
        snippets: [{
          handle: { providerKey: PROVIDER_KEY, providerRecordId: "__status__" },
          text,
          score: 1.0,
          metadata: { method: "status", intent: "agent_preamble" },
        }],
        profileSummary: text,
        usage: [{
          provider: PROVIDER_KEY,
          latencyMs: latency,
          details: { method: "status" },
        }],
      };
    }

    // mempalace has a single mempalace_search tool with optional wing/room filters
    const wing = (req.metadataFilter?.wing as string) ?? scopeToWing(req.scope);
    const room = (req.metadataFilter?.room as string) ?? scopeToRoom(req.scope);
    const topK = req.topK ?? 5;

    const toolArgs: Record<string, unknown> = {
      query: req.query,
      limit: topK,
    };
    if (wing) toolArgs.wing = wing;
    if (room) toolArgs.room = room;

    const result = await callTool("mempalace_search", toolArgs);
    const latency = Date.now() - start;
    const text = extractText(result);
    const parsed = tryParseJson(text) as Record<string, unknown> | null;

    const snippets: MemorySnippet[] = [];

    // mempalace returns { query, filters, results: [{text, wing, room, similarity, source_file}] }
    const results = parsed?.results;
    if (Array.isArray(results)) {
      for (const r of results.slice(0, topK)) {
        const rWing = (r.wing as string) ?? wing;
        const rRoom = (r.room as string) ?? room;
        // mempalace search results don't include drawer_id — prefix with
        // __search__ so forget()/get() can detect and skip these handles
        const syntheticId = `__search__/${rWing ?? "global"}/${rRoom ?? "default"}/${snippets.length}`;

        snippets.push({
          handle: { providerKey: PROVIDER_KEY, providerRecordId: syntheticId },
          text: (r.text as string) ?? (r.content as string) ?? "",
          score: (r.similarity as number) ?? (r.score as number) ?? undefined,
          metadata: {
            wing: rWing,
            room: rRoom,
            source_file: r.source_file as string,
          },
        });
      }
    } else if (text) {
      // Fallback: treat the full text response as a single snippet
      snippets.push({
        handle: { providerKey: PROVIDER_KEY, providerRecordId: "__search__" },
        text,
        score: 1.0,
        metadata: { method: "mempalace_search", wing, room },
      });
    }

    return {
      snippets,
      usage: [{
        provider: PROVIDER_KEY,
        latencyMs: latency,
        details: { method: "mempalace_search", wing, room, resultCount: snippets.length },
      }],
    };
  }

  // ── Get ─────────────────────────────────────────────────────────────

  async function get(
    handle: MemoryRecordHandle,
    _scope: MemoryScope,
  ): Promise<MemorySnippet | null> {
    // Synthetic handles from search results can't be resolved to a specific drawer
    if (handle.providerRecordId.startsWith("__search__")) return null;

    const { drawerId, wing, room } = decodeHandle(handle);

    // Use mempalace_search with wing/room filters and drawerId as query
    const toolArgs: Record<string, unknown> = {
      query: drawerId,
      limit: 1,
    };
    if (wing) toolArgs.wing = wing;
    if (room) toolArgs.room = room;

    try {
      const result = await callTool("mempalace_search", toolArgs);
      const text = extractText(result);
      const parsed = tryParseJson(text) as Record<string, unknown> | null;

      // mempalace returns { results: [...] }
      const results = parsed?.results;
      if (Array.isArray(results) && results.length > 0) {
        const r = results[0];
        return {
          handle,
          text: (r.text as string) ?? (r.content as string) ?? "",
          metadata: {
            wing: (r.wing as string) ?? wing,
            room: (r.room as string) ?? room,
            drawer_id: drawerId,
          },
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  // ── Forget ──────────────────────────────────────────────────────────

  async function forget(
    handles: MemoryRecordHandle[],
    _scope: MemoryScope,
  ): Promise<{ usage?: MemoryUsage[] }> {
    let deleted = 0;
    const start = Date.now();

    for (const handle of handles) {
      if (handle.providerKey !== PROVIDER_KEY) continue;
      // Skip synthetic handles from search results — no real drawer_id to delete
      if (handle.providerRecordId.startsWith("__search__")) continue;
      const { drawerId } = decodeHandle(handle);

      try {
        await callTool("mempalace_delete_drawer", { drawer_id: drawerId });
        deleted++;
      } catch {
        // best-effort: continue with remaining handles
      }
    }

    const latency = Date.now() - start;
    return {
      usage: [{
        provider: PROVIDER_KEY,
        latencyMs: latency,
        details: { drawersDeleted: deleted, drawersRequested: handles.length },
      }],
    };
  }

  // ── Adapter ─────────────────────────────────────────────────────────

  const capabilities: MemoryAdapterCapabilities = {
    profile: false,
    browse: true,
    correction: false,
    asyncIngestion: true,
    multimodal: false,
    providerManagedExtraction: true,
  };

  async function ping(): Promise<void> {
    const c = ensureConnected();
    await c.ping({ timeout: callTimeoutMs });
  }

  return {
    key: PROVIDER_KEY,
    capabilities,
    write,
    query,
    get,
    forget,
    connect,
    disconnect,
    ping,
    get connected() {
      return _connected;
    },
  };
}
