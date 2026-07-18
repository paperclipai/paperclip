import { spawn } from "node:child_process";
import path from "node:path";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMcpServers, mcpServers, mcpServerCatalogSnapshots } from "@paperclipai/db";
import type {
  AgentEnvConfig,
  AgentMcpServerBinding,
  AgentMcpServerBindingDetail,
  BindAgentMcpServerRequest,
  CreateMcpServerRequest,
  McpServer,
  McpServerCatalogPrompt,
  McpServerCatalogResource,
  McpServerCatalogSnapshot,
  McpServerGovernanceStatus,
  McpServerHealthStatus,
  McpServerRiskLevel,
  McpServerTransport,
  McpServerCatalogTool,
  McpServerDiscoveryResult,
  McpServerDiscoveryStatus,
  TestMcpServerRequest,
  UpdateAgentMcpServerBindingRequest,
  UpdateMcpServerRequest,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import {
  getSharedMcpClientManager,
  type McpClientManager,
  type PooledMcpClient,
} from "./mcp-client-manager.js";
import type { secretService } from "./secrets.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 15_000;
const MCP_SERVER_METADATA_BEARER_ENV_KEY = "httpBearerTokenEnvVar";
const MCP_SERVER_METADATA_FORWARDED_ENV_KEYS = "forwardedEnvKeys";
const MCP_SERVER_METADATA_HEADER_ENV_BINDINGS = "headerEnvBindings";
const MCP_SERVER_CREDENTIAL_PREFIX = "paperclip-mcp-credential:";
const MCP_SERVER_CREDENTIAL_ENV_KEY = "MCP_CREDENTIAL";

// Mirrors the cloud-upstreams sealed-credential path: credential material is
// encrypted via localEncryptedProvider and only the sealed ref is persisted.
export async function sealMcpServerCredential(value: string): Promise<string> {
  const prepared = await localEncryptedProvider.createSecret({ value });
  return `${MCP_SERVER_CREDENTIAL_PREFIX}${JSON.stringify(prepared.material)}`;
}

export async function unsealMcpServerCredential(value: string): Promise<string> {
  if (!value.startsWith(MCP_SERVER_CREDENTIAL_PREFIX)) {
    throw badRequest("Invalid MCP server credential ref (missing seal prefix)");
  }
  const encoded = value.slice(MCP_SERVER_CREDENTIAL_PREFIX.length);
  let material: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(encoded) as unknown;
    material = isRecord(parsed) ? parsed : null;
  } catch {
    material = null;
  }
  if (!material) {
    throw badRequest("Invalid encrypted MCP server credential material");
  }
  return localEncryptedProvider.resolveVersion({
    material,
    externalRef: null,
  });
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
  method?: string;
}

interface ResolvedStdioRuntimeConfig {
  kind: "stdio";
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

interface ResolvedHttpRuntimeConfig {
  kind: "http";
  transport: "http" | "sse";
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

type ResolvedRuntimeConfig = ResolvedStdioRuntimeConfig | ResolvedHttpRuntimeConfig;

async function withRequestTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for MCP response after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value)
    .filter(([, entry]) => typeof entry === "string")
    .map(([key, entry]) => [key, String(entry)] as const);
  return Object.fromEntries(entries);
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function normalizeHeaderEnvBindings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
    .map(([headerName, envKey]) => [headerName, envKey.trim()] as const);
  return Object.fromEntries(entries);
}

function normalizeArgs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeEnv(value: unknown): AgentEnvConfig {
  return isRecord(value) ? (value as AgentEnvConfig) : {};
}

function normalizeMcpServerRow(row: typeof mcpServers.$inferSelect): McpServer {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    transport: row.transport as McpServerTransport,
    command: row.command,
    args: normalizeArgs(row.args),
    cwd: row.cwd,
    url: row.url,
    headers: normalizeHeaders(row.headers),
    env: normalizeEnv(row.env),
    credentialSecretRef: row.credentialSecretRef,
    enabled: row.enabled,
    governanceStatus: (row.governanceStatus ?? "pending") as McpServerGovernanceStatus,
    riskLevel: (row.riskLevel ?? "unknown") as McpServerRiskLevel,
    riskFactors: Array.isArray(row.riskFactors) ? row.riskFactors as string[] : [],
    governanceUpdatedAt: row.governanceUpdatedAt ?? null,
    governanceUpdatedBy: row.governanceUpdatedBy ?? null,
    governanceReason: row.governanceReason ?? null,
    lastHealthStatus: row.lastHealthStatus as McpServerHealthStatus,
    lastHealthcheckAt: row.lastHealthcheckAt,
    lastDiscoveryAt: row.lastDiscoveryAt,
    lastError: row.lastError,
    metadata: normalizeMetadata(row.metadata),
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeCatalogTool(entry: Record<string, unknown>): McpServerCatalogTool | null {
  const name = asString(entry.name).trim();
  if (!name) return null;
  return {
    name,
    title: asNullableString(entry.title),
    description: asNullableString(entry.description),
    inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : null,
    annotations: isRecord(entry.annotations) ? entry.annotations : null,
    raw: entry,
  };
}

function normalizeCatalogResource(entry: Record<string, unknown>): McpServerCatalogResource | null {
  const uri = asString(entry.uri).trim();
  if (!uri) return null;
  return {
    uri,
    name: asNullableString(entry.name),
    description: asNullableString(entry.description),
    mimeType: asNullableString(entry.mimeType),
    raw: entry,
  };
}

function normalizeCatalogPrompt(entry: Record<string, unknown>): McpServerCatalogPrompt | null {
  const name = asString(entry.name).trim();
  if (!name) return null;
  return {
    name,
    title: asNullableString(entry.title),
    description: asNullableString(entry.description),
    arguments: Array.isArray(entry.arguments)
      ? entry.arguments.filter((value): value is Record<string, unknown> => isRecord(value))
      : [],
    raw: entry,
  };
}

function normalizeCatalogSnapshotRow(
  row: typeof mcpServerCatalogSnapshots.$inferSelect,
): McpServerCatalogSnapshot {
  return {
    ...row,
    tools: Array.isArray(row.tools) ? row.tools as McpServerCatalogTool[] : [],
    resources: Array.isArray(row.resources) ? row.resources as McpServerCatalogResource[] : [],
    prompts: Array.isArray(row.prompts) ? row.prompts as McpServerCatalogPrompt[] : [],
    serverInfo: normalizeMetadata(row.serverInfo),
  };
}

function normalizeAgentMcpServerBindingRow(
  row: typeof agentMcpServers.$inferSelect,
): AgentMcpServerBinding {
  return {
    companyId: row.companyId,
    agentId: row.agentId,
    mcpServerId: row.mcpServerId,
    bindingMode: row.bindingMode,
    enabled: row.enabled,
    allowedTools: Array.isArray(row.allowedTools) ? row.allowedTools as string[] : [],
    bindingAuthority: row.bindingAuthority ?? "board",
    toolClearances: (row.toolClearances as Record<string, string>) ?? {},
    defaultMinUserRole: row.defaultMinUserRole ?? "board",
    autonomousAllowed: row.autonomousAllowed ?? false,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

class StdioJsonRpcClient {
  private readonly child;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly logs: string[];
  private readonly timeoutMs: number;
  private nextId = 1;
  private buffer = Buffer.alloc(0);

  constructor(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
      logs: string[];
    },
  ) {
    this.logs = options.logs;
    this.timeoutMs = options.timeoutMs;
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.consume();
    });
    this.child.stderr.on("data", (chunk: string) => {
      const text = String(chunk).trim();
      if (text) this.logs.push(`[mcp:stderr] ${text}`);
    });
    this.child.on("error", (error) => {
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
    this.child.on("close", (code, signal) => {
      if (this.pending.size === 0) return;
      this.rejectAll(new Error(`MCP process exited before reply (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    });
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    };
    const message = JSON.stringify(payload);
    const frame = `Content-Length: ${Buffer.byteLength(message, "utf8")}\r\n\r\n${message}`;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response to ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(frame, "utf8");
    return await response;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`, "utf8");
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGTERM");
        resolve();
      }, 500);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private consume(): void {
    while (true) {
      const separatorIndex = this.buffer.indexOf("\r\n\r\n");
      if (separatorIndex < 0) return;
      const headerText = this.buffer.subarray(0, separatorIndex).toString("utf8");
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!lengthMatch) {
        const text = this.buffer.toString("utf8").trim();
        if (text) this.logs.push(`[mcp:stdout] ${text}`);
        this.buffer = Buffer.alloc(0);
        return;
      }
      const contentLength = Number(lengthMatch[1]);
      const bodyStart = separatorIndex + 4;
      if (this.buffer.length < bodyStart + contentLength) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(body) as JsonRpcResponse;
    } catch {
      this.logs.push(`[mcp:stdout] ${body}`);
      return;
    }
    if (typeof message.id !== "number") {
      const method = asString(message.method, "notification");
      this.logs.push(`[mcp:${method}] ${JSON.stringify(message.result ?? message.error ?? {})}`);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message || `MCP request failed for id ${message.id}`));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

async function callOptionalList(
  client: StdioJsonRpcClient,
  method: "tools/list" | "resources/list" | "prompts/list",
  logs: string[],
): Promise<Array<Record<string, unknown>>> {
  try {
    const result = await client.request(method);
    if (!isRecord(result)) return [];
    const key = method === "tools/list" ? "tools" : method === "resources/list" ? "resources" : "prompts";
    const entries = Array.isArray(result[key]) ? result[key] : [];
    return entries.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  } catch (error) {
    logs.push(`[discovery] ${method} unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function listOptional(
  key: "tools" | "resources" | "prompts",
  logs: string[],
  fn: (() => Promise<unknown>) | undefined,
): Promise<Array<Record<string, unknown>>> {
  if (!fn) return [];
  try {
    const result = await fn();
    if (!isRecord(result)) return [];
    const entries = Array.isArray(result[key]) ? result[key] : [];
    return entries.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  } catch (error) {
    logs.push(`[discovery] ${key}/list unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export function mcpServerService(
  db: Db,
  deps: {
    secrets: ReturnType<typeof secretService>;
    /** Pooled multi-tenant MCP client manager; defaults to the shared one. */
    mcpClients?: McpClientManager;
  },
) {
  const mcpClients = deps.mcpClients ?? getSharedMcpClientManager();
  async function getLatestSnapshotForServer(mcpServerId: string) {
    const row = await db
      .select()
      .from(mcpServerCatalogSnapshots)
      .where(eq(mcpServerCatalogSnapshots.mcpServerId, mcpServerId))
      .orderBy(desc(mcpServerCatalogSnapshots.createdAt))
      .then((rows) => rows[0] ?? null);
    return row ? normalizeCatalogSnapshotRow(row) : null;
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? normalizeMcpServerRow(row) : null;
  }

  async function getBySlug(companyId: string, slug: string) {
    const row = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.companyId, companyId), eq(mcpServers.slug, slug)))
      .then((rows) => rows[0] ?? null);
    return row ? normalizeMcpServerRow(row) : null;
  }

  async function assertUniqueSlug(companyId: string, slug: string, excludeId?: string) {
    const existing = await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.companyId, companyId),
          eq(mcpServers.slug, slug),
          ...(excludeId ? [ne(mcpServers.id, excludeId)] : []),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) {
      throw conflict(`MCP server slug already exists: ${slug}`);
    }
  }

  async function createSnapshot(
    server: McpServer,
    input: {
      status: McpServerDiscoveryStatus;
      protocolVersion?: string | null;
      serverName?: string | null;
      serverVersion?: string | null;
      summary?: string | null;
      tools?: McpServerCatalogTool[];
      resources?: McpServerCatalogResource[];
      prompts?: McpServerCatalogPrompt[];
      serverInfo?: Record<string, unknown>;
      error?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    },
  ) {
    const [row] = await db
      .insert(mcpServerCatalogSnapshots)
      .values({
        companyId: server.companyId,
        mcpServerId: server.id,
        status: input.status,
        protocolVersion: input.protocolVersion ?? null,
        serverName: input.serverName ?? null,
        serverVersion: input.serverVersion ?? null,
        summary: input.summary ?? null,
        tools: input.tools ?? [],
        resources: input.resources ?? [],
        prompts: input.prompts ?? [],
        serverInfo: input.serverInfo ?? {},
        error: input.error ?? null,
        createdByAgentId: input.createdByAgentId ?? null,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning();
    return normalizeCatalogSnapshotRow(row);
  }

  async function updateHealth(serverId: string, patch: {
    status: typeof mcpServers.$inferInsert.lastHealthStatus;
    discovered?: boolean;
    error?: string | null;
  }) {
    await db
      .update(mcpServers)
      .set({
        lastHealthStatus: patch.status,
        lastHealthcheckAt: new Date(),
        ...(patch.discovered ? { lastDiscoveryAt: new Date() } : {}),
        lastError: patch.error ?? null,
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, serverId));
  }

  async function resolveRuntimeConfig(server: McpServer, request?: TestMcpServerRequest): Promise<ResolvedRuntimeConfig> {
    const metadata = normalizeMetadata(server.metadata);
    const timeoutMs = Math.max(1, request?.timeoutSec ?? 15) * 1000;

    if (server.transport === "http" || server.transport === "sse") {
      const bearerTokenEnvVar = asNullableString(metadata[MCP_SERVER_METADATA_BEARER_ENV_KEY]);
      const forwardedEnvKeys = normalizeStringArray(metadata[MCP_SERVER_METADATA_FORWARDED_ENV_KEYS]);
      const headerEnvBindings = normalizeHeaderEnvBindings(metadata[MCP_SERVER_METADATA_HEADER_ENV_BINDINGS]);
      const resolvedHeaders = { ...server.headers };

      if (bearerTokenEnvVar) {
        const bearerValue = process.env[bearerTokenEnvVar]?.trim();
        if (bearerValue) {
          resolvedHeaders.Authorization = `Bearer ${bearerValue}`;
        }
      }

      for (const envKey of forwardedEnvKeys) {
        const forwardedValue = process.env[envKey];
        if (typeof forwardedValue === "string") {
          resolvedHeaders[envKey] = forwardedValue;
        }
      }

      for (const [headerName, envKey] of Object.entries(headerEnvBindings)) {
        const envValue = process.env[envKey];
        if (typeof envValue === "string" && envValue.trim().length > 0) {
          resolvedHeaders[headerName] = envValue;
        }
      }

      if (server.credentialSecretRef && !resolvedHeaders.Authorization) {
        const credential = await unsealMcpServerCredential(server.credentialSecretRef);
        resolvedHeaders.Authorization = `Bearer ${credential}`;
      }

      if (!server.url) {
        throw unprocessable(`MCP server "${server.name}" is missing a URL`);
      }
      return {
        kind: "http",
        transport: server.transport,
        url: server.url,
        headers: resolvedHeaders,
        timeoutMs,
      };
    }

    if (!server.command) {
      throw unprocessable(`MCP server "${server.name}" is missing command`);
    }
    const cwd = path.resolve(request?.workspacePath ?? server.cwd ?? process.cwd());
    const { env } = await deps.secrets.resolveEnvBindings(server.companyId, server.env);
    const forwardedEnvKeys = normalizeStringArray(metadata[MCP_SERVER_METADATA_FORWARDED_ENV_KEYS]);
    const forwardedEnv: Record<string, string> = {};
    for (const envKey of forwardedEnvKeys) {
      const value = process.env[envKey];
      if (typeof value === "string") {
        forwardedEnv[envKey] = value;
      }
    }

    const credentialEnv: Record<string, string> = {};
    if (server.credentialSecretRef && env[MCP_SERVER_CREDENTIAL_ENV_KEY] === undefined) {
      credentialEnv[MCP_SERVER_CREDENTIAL_ENV_KEY] = await unsealMcpServerCredential(
        server.credentialSecretRef,
      );
    }

    return {
      kind: "stdio",
      command: server.command,
      args: server.args,
      cwd,
      env: {
        ...process.env,
        ...forwardedEnv,
        ...credentialEnv,
        ...env,
      },
      timeoutMs,
    };
  }

  function acquireHttpPooledClient(
    server: McpServer,
    runtime: ResolvedHttpRuntimeConfig,
  ): Promise<PooledMcpClient> {
    return mcpClients.acquire({
      companyId: server.companyId,
      mcpServerId: server.id,
      transport: runtime.transport,
      endpoint: runtime.url,
      headers: runtime.headers,
    });
  }

  function acquireStdioPooledClient(
    server: McpServer,
    runtime: ResolvedStdioRuntimeConfig,
  ): Promise<PooledMcpClient> {
    return mcpClients.acquire({
      companyId: server.companyId,
      mcpServerId: server.id,
      transport: "stdio",
      command: runtime.command,
      args: runtime.args,
      env: runtime.env as Record<string, string>,
      cwd: runtime.cwd,
    });
  }

  function normalizeToolCallResult(rawResult: unknown, logs: string[]): {
    content: string | null;
    data: unknown;
    error: string | null;
    logs: string[];
  } {
    const content = isRecord(rawResult) && Array.isArray(rawResult.content)
      ? rawResult.content
          .map((entry) => {
            if (!isRecord(entry)) return null;
            if (typeof entry.text === "string" && entry.text.trim().length > 0) return entry.text;
            return null;
          })
          .filter((entry): entry is string => entry !== null)
          .join("\n")
      : null;

    const error = isRecord(rawResult) && typeof rawResult.isError === "boolean" && rawResult.isError
      ? content ?? "MCP tool call returned an error"
      : null;

    return {
      content: content && content.trim().length > 0 ? content : null,
      data: rawResult ?? null,
      error,
      logs,
    };
  }

  async function executeTool(
    server: McpServer,
    input: {
      toolName: string;
      arguments?: Record<string, unknown>;
      workspacePath?: string | null;
      timeoutSec?: number | null;
    },
  ): Promise<{
    content: string | null;
    data: unknown;
    error: string | null;
    logs: string[];
  }> {
    const logs = [`[tool-call] mcpServerId=${server.id}`, `[tool-call] tool=${input.toolName}`];
    const runtime = await resolveRuntimeConfig(server, {
      workspacePath: input.workspacePath,
      timeoutSec: input.timeoutSec,
    });

    logs.push(`[tool-call] transport=${server.transport}`);

    if (runtime.kind === "http") {
      logs.push(`[tool-call] url=${runtime.url}`);
      try {
        const pooled = await acquireHttpPooledClient(server, runtime);
        const rawResult = await withRequestTimeout(
          pooled.client.callTool({
            name: input.toolName,
            arguments: input.arguments ?? {},
          }),
          runtime.timeoutMs,
        );
        return normalizeToolCallResult(rawResult, logs);
      } catch (error) {
        // Drop the pooled connection so the next call reconnects fresh.
        void mcpClients.invalidateServer(server.companyId, server.id).catch(() => {});
        throw error;
      }
    }

    // stdio: governance gate — server must be explicitly allowlisted before
    // any process spawn. Distinct from the http/sse enablement check.
    if (server.governanceStatus !== "allowlisted") {
      throw unprocessable(
        `MCP server "${server.name}" must be allowlisted before stdio tool execution (current status: ${server.governanceStatus})`,
      );
    }

    logs.push(`[tool-call] command=${runtime.command} ${runtime.args.join(" ")}`.trim());
    logs.push(`[tool-call] cwd=${runtime.cwd}`);

    try {
      const pooled = await acquireStdioPooledClient(server, runtime);
      const rawResult = await withRequestTimeout(
        pooled.client.callTool({
          name: input.toolName,
          arguments: input.arguments ?? {},
        }),
        runtime.timeoutMs,
      );
      return normalizeToolCallResult(rawResult, logs);
    } catch (error) {
      // Drop the pooled connection on any error — stdio processes may have
      // crashed or become wedged.
      void mcpClients.invalidateServer(server.companyId, server.id).catch(() => {});
      throw error;
    }
  }

  async function discover(
    id: string,
    request: TestMcpServerRequest | undefined,
    actor?: { userId?: string | null; agentId?: string | null },
  ): Promise<McpServerDiscoveryResult> {
    const server = await getById(id);
    if (!server) throw notFound("MCP server not found");
    const logs = [`[discovery] mcpServerId=${server.id}`, `[discovery] name=${server.name}`];

    try {
      const runtime = await resolveRuntimeConfig(server, request);
      logs.push(`[discovery] transport=${server.transport}`);

      let toolsRaw: Array<Record<string, unknown>>;
      let resourcesRaw: Array<Record<string, unknown>>;
      let promptsRaw: Array<Record<string, unknown>>;
      let serverInfo: Record<string, unknown>;
      let protocolVersion: string | null;
      let stdioClient: StdioJsonRpcClient | null = null;

      try {
        if (runtime.kind === "http") {
          logs.push(`[discovery] url=${runtime.url}`);
          let pooled: PooledMcpClient;
          try {
            pooled = await acquireHttpPooledClient(server, runtime);
            toolsRaw = await listOptional("tools", logs, () => pooled.client.listTools());
            resourcesRaw = await listOptional("resources", logs, pooled.client.listResources?.bind(pooled.client));
            promptsRaw = await listOptional("prompts", logs, pooled.client.listPrompts?.bind(pooled.client));
          } catch (error) {
            void mcpClients.invalidateServer(server.companyId, server.id).catch(() => {});
            throw error;
          }
          const version = pooled.client.getServerVersion?.();
          serverInfo = version
            ? { ...(version.name ? { name: version.name } : {}), ...(version.version ? { version: version.version } : {}) }
            : {};
          protocolVersion = null;
        } else {
          logs.push(`[discovery] command=${runtime.command} ${runtime.args.join(" ")}`.trim());
          logs.push(`[discovery] cwd=${runtime.cwd}`);

          stdioClient = new StdioJsonRpcClient(runtime.command, runtime.args, {
            cwd: runtime.cwd,
            env: runtime.env,
            timeoutMs: runtime.timeoutMs,
            logs,
          });
          const initializeResult = await stdioClient.request("initialize", {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
              name: "paperclip.mcp-registry",
              version: "0.1.0",
            },
          });
          stdioClient.notify("notifications/initialized");
          toolsRaw = await callOptionalList(stdioClient, "tools/list", logs);
          resourcesRaw = await callOptionalList(stdioClient, "resources/list", logs);
          promptsRaw = await callOptionalList(stdioClient, "prompts/list", logs);
          serverInfo = isRecord(initializeResult) && isRecord(initializeResult.serverInfo)
            ? initializeResult.serverInfo
            : {};
          protocolVersion = asNullableString(
            isRecord(initializeResult) ? initializeResult.protocolVersion : null,
          );
        }

        const serverLabel = asString(serverInfo.name, server.name);
        const tools = toolsRaw
          .map(normalizeCatalogTool)
          .filter((value): value is McpServerCatalogTool => value !== null);
        const resources = resourcesRaw
          .map(normalizeCatalogResource)
          .filter((value): value is McpServerCatalogResource => value !== null);
        const prompts = promptsRaw
          .map(normalizeCatalogPrompt)
          .filter((value): value is McpServerCatalogPrompt => value !== null);
        const summary = [
          `Connected to ${serverLabel}.`,
          tools.length > 0 ? `${tools.length} tool(s)` : "no tools",
          resources.length > 0 ? `${resources.length} resource(s)` : "no resources",
          prompts.length > 0 ? `${prompts.length} prompt(s)` : "no prompts",
        ].join(" ");

        const snapshot = await createSnapshot(server, {
          status: "succeeded",
          protocolVersion,
          serverName: asNullableString(serverInfo.name) ?? server.name,
          serverVersion: asNullableString(serverInfo.version),
          summary,
          tools,
          resources,
          prompts,
          serverInfo,
          error: null,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });
        await updateHealth(server.id, {
          status: "healthy",
          discovered: true,
          error: null,
        });
        return {
          ok: true,
          mcpServerId: server.id,
          snapshot,
          logs,
        };
      } finally {
        // Pooled http/sse clients stay open for reuse; only stdio is per-call.
        if (stdioClient) await stdioClient.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logs.push(`[discovery:error] ${message}`);
      const snapshot = await createSnapshot(server, {
        status: "failed",
        summary: null,
        tools: [],
        resources: [],
        prompts: [],
        serverInfo: {},
        error: message,
        createdByAgentId: actor?.agentId ?? null,
        createdByUserId: actor?.userId ?? null,
      });
      await updateHealth(server.id, {
        status: "error",
        discovered: false,
        error: message,
      });
      return {
        ok: false,
        mcpServerId: server.id,
        snapshot,
        logs,
      };
    }
  }

  return {
    list: async (companyId: string) =>
      db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.companyId, companyId))
        .orderBy(desc(mcpServers.createdAt))
        .then((rows) => rows.map(normalizeMcpServerRow)),

    getById,

    getLatestSnapshot: async (mcpServerId: string) => {
      return getLatestSnapshotForServer(mcpServerId);
    },

    listBindingsForAgent: async (agentId: string): Promise<AgentMcpServerBindingDetail[]> => {
      const rows = await db
        .select()
        .from(agentMcpServers)
        .where(eq(agentMcpServers.agentId, agentId))
        .orderBy(desc(agentMcpServers.createdAt));

      const bindingRows = rows.map(normalizeAgentMcpServerBindingRow);
      const serverIds = Array.from(new Set(bindingRows.map((row) => row.mcpServerId)));
      const servers = await Promise.all(serverIds.map((serverId) => getById(serverId)));
      const serverById = new Map(
        servers.filter((server): server is McpServer => server !== null).map((server) => [server.id, server]),
      );
      const snapshots = await Promise.all(serverIds.map((serverId) => getLatestSnapshotForServer(serverId)));
      const snapshotByServerId = new Map(
        serverIds.map((serverId, index) => [serverId, snapshots[index] ?? null]),
      );

      return bindingRows.flatMap((binding) => {
        const server = serverById.get(binding.mcpServerId);
        if (!server) return [];
        return [{
          ...binding,
          server,
          latestSnapshot: snapshotByServerId.get(binding.mcpServerId) ?? null,
        }];
      });
    },

    bindToAgent: async (
      companyId: string,
      agentId: string,
      input: BindAgentMcpServerRequest,
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const server = await getById(input.mcpServerId);
      if (!server) throw notFound("MCP server not found");
      if (server.companyId !== companyId) {
        throw unprocessable("MCP server must belong to the same company");
      }

      const [created] = await db
        .insert(agentMcpServers)
        .values({
          companyId,
          agentId,
          mcpServerId: input.mcpServerId,
          bindingMode: input.bindingMode ?? "allowed",
          enabled: input.enabled ?? true,
          allowedTools: input.allowedTools ?? [],
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        })
        .onConflictDoUpdate({
          target: [agentMcpServers.agentId, agentMcpServers.mcpServerId],
          set: {
            bindingMode: input.bindingMode ?? "allowed",
            enabled: input.enabled ?? true,
            allowedTools: input.allowedTools ?? [],
            updatedAt: new Date(),
          },
        })
        .returning();

      return normalizeAgentMcpServerBindingRow(created);
    },

    updateAgentBinding: async (
      agentId: string,
      mcpServerId: string,
      patch: UpdateAgentMcpServerBindingRequest,
    ) => {
      const existing = await db
        .select()
        .from(agentMcpServers)
        .where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, mcpServerId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const [updated] = await db
        .update(agentMcpServers)
        .set({
          bindingMode: patch.bindingMode ?? existing.bindingMode,
          enabled: patch.enabled ?? existing.enabled,
          allowedTools: patch.allowedTools ?? (Array.isArray(existing.allowedTools) ? existing.allowedTools as string[] : []),
          updatedAt: new Date(),
        })
        .where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, mcpServerId)))
        .returning();

      return updated ? normalizeAgentMcpServerBindingRow(updated) : null;
    },

    removeAgentBinding: async (agentId: string, mcpServerId: string) => {
      const existing = await db
        .select()
        .from(agentMcpServers)
        .where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, mcpServerId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      await db
        .delete(agentMcpServers)
        .where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, mcpServerId)));

      return normalizeAgentMcpServerBindingRow(existing);
    },

    create: async (
      companyId: string,
      input: CreateMcpServerRequest,
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      await assertUniqueSlug(companyId, input.slug);
      const env = await deps.secrets.normalizeEnvBindingsForPersistence(
        companyId,
        input.env ?? {},
        { fieldPath: "env" },
      );
      const credentialSecretRef =
        typeof input.credential === "string" && input.credential.length > 0
          ? await sealMcpServerCredential(input.credential)
          : null;
      const [created] = await db
        .insert(mcpServers)
        .values({
          companyId,
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          transport: input.transport,
          command: input.command ?? null,
          args: input.args ?? [],
          cwd: input.cwd ?? null,
          url: input.url ?? null,
          headers: input.headers ?? {},
          env,
          credentialSecretRef,
          enabled: input.enabled ?? false,
          metadata: input.metadata ?? {},
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        })
        .returning();
      return normalizeMcpServerRow(created);
    },

    update: async (id: string, patch: UpdateMcpServerRequest) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (patch.slug && patch.slug !== existing.slug) {
        await assertUniqueSlug(existing.companyId, patch.slug, existing.id);
      }
      const nextEnv = patch.env === undefined
        ? existing.env
        : await deps.secrets.normalizeEnvBindingsForPersistence(existing.companyId, patch.env, {
          fieldPath: "env",
        });
      const nextCredentialSecretRef = patch.credential === undefined
        ? existing.credentialSecretRef
        : patch.credential === null || patch.credential.length === 0
          ? null
          : await sealMcpServerCredential(patch.credential);
      const [updated] = await db
        .update(mcpServers)
        .set({
          name: patch.name ?? existing.name,
          slug: patch.slug ?? existing.slug,
          description: patch.description === undefined ? existing.description : patch.description,
          transport: patch.transport ?? existing.transport,
          command: patch.command === undefined ? existing.command : patch.command,
          args: patch.args ?? existing.args,
          cwd: patch.cwd === undefined ? existing.cwd : patch.cwd,
          url: patch.url === undefined ? existing.url : patch.url,
          headers: patch.headers ?? existing.headers,
          env: nextEnv,
          credentialSecretRef: nextCredentialSecretRef,
          enabled: patch.enabled ?? existing.enabled,
          metadata: patch.metadata ?? existing.metadata,
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, id))
        .returning();
      // Config changed — drop any pooled connection so the next tool call
      // reconnects with the new endpoint/credentials.
      void mcpClients.invalidateServer(existing.companyId, id).catch(() => {});
      return updated ? normalizeMcpServerRow(updated) : null;
    },

    remove: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      await db.delete(mcpServers).where(eq(mcpServers.id, id));
      void mcpClients.invalidateServer(existing.companyId, id).catch(() => {});
      return existing;
    },

    discover,
    executeTool,
  };
}
