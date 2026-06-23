import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMcpServers } from "@paperclipai/db";
import type {
  AgentMcpServer,
  McpTransport,
  RequestMcpInstall,
  RuntimeMcpServer,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { secretService } from "./secrets.js";

export type McpActor = { actorType: "user" | "agent"; actorId: string };

type AgentMcpServerRow = typeof agentMcpServers.$inferSelect;

function toAgentMcpServer(row: AgentMcpServerRow): AgentMcpServer {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    name: row.name,
    description: row.description,
    transport: row.transport as McpTransport,
    config: row.config ?? {},
    envBindings: row.envBindings ?? {},
    status: row.status as AgentMcpServer["status"],
    sourceApprovalId: row.sourceApprovalId,
    createdByActorType: row.createdByActorType,
    createdByActorId: row.createdByActorId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    disabledAt: row.disabledAt,
  };
}

type ProvisionInput = RequestMcpInstall & { secretValues?: Record<string, string> };

export function agentMcpServerService(db: Db) {
  const secrets = secretService(db);

  /**
   * Resolve a secret name to a company_secrets id, creating the secret from a
   * board-provided value when it does not exist yet. The value never leaves this
   * call: it goes straight into company_secrets, and only the id is bound.
   */
  async function ensureSecretId(
    companyId: string,
    secretName: string,
    value: string | undefined,
    actor: McpActor,
  ): Promise<string> {
    const actorRef = {
      userId: actor.actorType === "user" ? actor.actorId : null,
      agentId: actor.actorType === "agent" ? actor.actorId : null,
    };
    const existing = await secrets.getByName(companyId, secretName);
    if (existing) {
      // A board-supplied value for an already-existing secret is an update, not a
      // no-op: rotate it so the new credential actually takes effect.
      if (value !== undefined && value.length > 0) {
        await secrets.rotate(existing.id, { value }, actorRef);
      }
      return existing.id;
    }
    if (value === undefined || value.length === 0) {
      throw unprocessable(`Missing value for secret "${secretName}" required by this MCP server`);
    }
    const created = await secrets.create(
      companyId,
      { name: secretName, provider: "local_encrypted", value },
      actorRef,
    );
    return created.id;
  }

  /** Build the persisted config + env bindings from a request payload. */
  async function buildPersistedFields(companyId: string, input: ProvisionInput, actor: McpActor) {
    const envBindings: Record<string, unknown> = {};
    for (const entry of input.env ?? []) {
      if (entry.secretName) {
        const secretId = await ensureSecretId(companyId, entry.secretName, input.secretValues?.[entry.secretName], actor);
        envBindings[entry.key] = { type: "secret_ref", secretId, version: "latest" };
      } else {
        envBindings[entry.key] = entry.value ?? "";
      }
    }
    const config: Record<string, unknown> =
      input.transport === "stdio"
        ? { command: input.command, args: input.args ?? [] }
        : { url: input.url };
    return { config, envBindings };
  }

  async function persistServer(
    companyId: string,
    agentId: string,
    input: ProvisionInput,
    actor: McpActor,
    sourceApprovalId: string | null,
  ): Promise<AgentMcpServer> {
    const { config, envBindings } = await buildPersistedFields(companyId, input, actor);
    const now = new Date();
    // Atomic upsert on the (companyId, agentId, name) unique index: re-install
    // refreshes config and re-enables, without a check-then-insert race.
    const upserted = await db
      .insert(agentMcpServers)
      .values({
        companyId,
        agentId,
        name: input.name,
        description: input.description ?? null,
        transport: input.transport,
        config,
        envBindings,
        status: "enabled",
        sourceApprovalId,
        createdByActorType: actor.actorType,
        createdByActorId: actor.actorId,
      })
      .onConflictDoUpdate({
        target: [agentMcpServers.companyId, agentMcpServers.agentId, agentMcpServers.name],
        set: {
          description: input.description ?? null,
          transport: input.transport,
          config,
          envBindings,
          status: "enabled",
          sourceApprovalId,
          disabledAt: null,
          updatedAt: now,
        },
      })
      .returning()
      .then((rows) => rows[0]);
    return toAgentMcpServer(upserted);
  }

  return {
    list: async (companyId: string, agentId: string, opts?: { includeDisabled?: boolean }): Promise<AgentMcpServer[]> => {
      const conditions = [eq(agentMcpServers.companyId, companyId), eq(agentMcpServers.agentId, agentId)];
      if (!opts?.includeDisabled) conditions.push(eq(agentMcpServers.status, "enabled"));
      const rows = await db
        .select()
        .from(agentMcpServers)
        .where(and(...conditions))
        .orderBy(desc(agentMcpServers.updatedAt));
      return rows.map(toAgentMcpServer);
    },

    getById: async (companyId: string, agentId: string, id: string): Promise<AgentMcpServer> => {
      const row = await db
        .select()
        .from(agentMcpServers)
        .where(and(eq(agentMcpServers.id, id), eq(agentMcpServers.companyId, companyId), eq(agentMcpServers.agentId, agentId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("MCP server not found");
      return toAgentMcpServer(row);
    },

    /** Board-direct install (secret values may be supplied inline). */
    create: (companyId: string, agentId: string, input: ProvisionInput, actor: McpActor): Promise<AgentMcpServer> =>
      persistServer(companyId, agentId, input, actor, null),

    /** Install from an approved `request_mcp_install` approval. */
    provisionFromApproval: (
      companyId: string,
      agentId: string,
      input: ProvisionInput,
      actor: McpActor,
      approvalId: string,
    ): Promise<AgentMcpServer> => persistServer(companyId, agentId, input, actor, approvalId),

    setStatus: async (
      companyId: string,
      agentId: string,
      id: string,
      status: "enabled" | "disabled",
    ): Promise<AgentMcpServer> => {
      const now = new Date();
      const updated = await db
        .update(agentMcpServers)
        .set({ status, disabledAt: status === "disabled" ? now : null, updatedAt: now })
        .where(and(eq(agentMcpServers.id, id), eq(agentMcpServers.companyId, companyId), eq(agentMcpServers.agentId, agentId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) throw notFound("MCP server not found");
      return toAgentMcpServer(updated);
    },

    remove: async (companyId: string, agentId: string, id: string): Promise<void> => {
      const deleted = await db
        .delete(agentMcpServers)
        .where(and(eq(agentMcpServers.id, id), eq(agentMcpServers.companyId, companyId), eq(agentMcpServers.agentId, agentId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!deleted) throw notFound("MCP server not found");
    },

    /**
     * Resolve enabled servers for a run: secret refs in env bindings are resolved
     * into concrete env (stdio) or headers (http) values for the adapter.
     */
    buildRuntimeMcpServers: async (companyId: string, agentId: string): Promise<RuntimeMcpServer[]> => {
      const rows = await db
        .select()
        .from(agentMcpServers)
        .where(and(eq(agentMcpServers.companyId, companyId), eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.status, "enabled")))
        .orderBy(desc(agentMcpServers.updatedAt));

      const out: RuntimeMcpServer[] = [];
      for (const row of rows) {
        // If a secret can't be resolved, SKIP the server rather than inject it with
        // empty credentials (which would fail opaquely at run time).
        const resolved = await secrets.resolveEnvBindings(companyId, row.envBindings ?? {}).catch((err) => {
          logger.warn(
            { err, companyId, agentId, mcpServer: row.name },
            "failed to resolve MCP server secrets; skipping server for this run",
          );
          return null;
        });
        if (!resolved) continue;
        const env = resolved.env;
        const config = (row.config ?? {}) as { command?: string; args?: string[]; url?: string };
        if (row.transport === "stdio") {
          if (!config.command) continue;
          out.push({ name: row.name, transport: "stdio", command: config.command, args: config.args ?? [], env });
        } else {
          if (!config.url) continue;
          out.push({ name: row.name, transport: "http", url: config.url, headers: env });
        }
      }
      return out;
    },
  };
}
