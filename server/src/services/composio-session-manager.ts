import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecretBindings, toolConnections } from "@paperclipai/db";
import type { ToolCredentialSecretRef } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { createComposioClient, type ComposioClient } from "./composio.js";
import { secretService } from "./secrets.js";

const DEFAULT_SESSION_TTL_MS = 50 * 60 * 1000;
const sessionQueues = new Map<string, Promise<void>>();

type ComposioChildConfig = {
  parentConnectionId: string;
  toolkitSlug: string;
  connectedAccountId?: string;
};

type SessionRef = { name: string; configPath: string; secretId: string };
type CachedSession = {
  sessionId: string;
  scopeKey: string;
  fingerprint: string;
  createdAt: string;
  urlRef: SessionRef;
  headerRefs: SessionRef[];
};

export type ComposioSessionCredentials = {
  sessionId: string;
  scopeKey: string;
  url: string;
  headers: Record<string, string>;
};

export type ComposioSessionManagerOptions = {
  composioClientFactory?: (apiKey: string) => ComposioClient;
  now?: () => Date;
  sessionTtlMs?: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function composioChildConfig(connection: typeof toolConnections.$inferSelect): ComposioChildConfig | null {
  const config = record(connection.config);
  if (config.provider !== "composio") return null;
  if (typeof config.parentConnectionId !== "string" || typeof config.toolkitSlug !== "string") return null;
  return {
    parentConnectionId: config.parentConnectionId,
    toolkitSlug: config.toolkitSlug,
    ...(typeof config.connectedAccountId === "string" ? { connectedAccountId: config.connectedAccountId } : {}),
  };
}

function normalizedTools(tools: string[] | undefined): string[] {
  return [...new Set((tools ?? []).map((tool) => tool.trim()).filter(Boolean))].sort();
}

function scopeKeyFor(toolkitSlug: string, tools: string[]): string {
  return createHash("sha256").update(JSON.stringify({ toolkitSlug, tools })).digest("hex").slice(0, 24);
}

function cacheFrom(connection: typeof toolConnections.$inferSelect): Record<string, CachedSession> {
  return record(record(connection.transportConfig).composioSessions) as Record<string, CachedSession>;
}

export function createComposioSessionManager(db: Db, options: ComposioSessionManagerOptions = {}) {
  const secrets = secretService(db);
  const now = options.now ?? (() => new Date());
  const ttlMs = Math.max(1, options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS);

  async function connectionRow(connectionId: string) {
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)).limit(1);
    if (!connection) throw unprocessable("The Composio toolkit connection no longer exists.", { code: "composio_child_missing" });
    return connection;
  }

  async function parentApiKey(child: typeof toolConnections.$inferSelect, config: ComposioChildConfig) {
    const [parent] = await db.select().from(toolConnections).where(and(
      eq(toolConnections.id, config.parentConnectionId),
      eq(toolConnections.companyId, child.companyId),
    )).limit(1);
    if (!parent) throw unprocessable("The parent Composio connection is missing.", { code: "composio_parent_missing" });
    const headerRef = parent.credentialRefs.find((ref) => ref.placement === "header" && ref.key.toLowerCase() === "x-api-key");
    const secretRef = parent.credentialSecretRefs.find((ref) => ref.configPath === "credentials.apiKey")
      ?? (headerRef
        ? {
            secretId: headerRef.secretId,
            versionSelector: headerRef.version ?? "latest",
            configPath: headerRef.name.startsWith("credentials.") ? headerRef.name : `credentials.${headerRef.name}`,
          }
        : undefined);
    if (!secretRef) throw unprocessable("The parent Composio API key is missing.", { code: "composio_api_key_missing" });
    const apiKey = await secrets.resolveSecretValue(parent.companyId, secretRef.secretId, secretRef.versionSelector ?? "latest", {
      consumerType: "tool_connection",
      consumerId: parent.id,
      configPath: secretRef.configPath,
      actorType: "system",
    });
    const revision = createHash("sha256").update(JSON.stringify({
      parentId: parent.id,
      updatedAt: parent.updatedAt.toISOString(),
      secretId: secretRef.secretId,
      versionSelector: secretRef.versionSelector ?? "latest",
    })).digest("hex");
    return { apiKey, revision };
  }

  async function resolveRef(child: typeof toolConnections.$inferSelect, ref: SessionRef) {
    return secrets.resolveSecretValue(child.companyId, ref.secretId, "latest", {
      consumerType: "tool_connection",
      consumerId: child.id,
      configPath: ref.configPath,
      actorType: "system",
    });
  }

  async function resolveCached(child: typeof toolConnections.$inferSelect, cached: CachedSession): Promise<ComposioSessionCredentials> {
    const url = await resolveRef(child, cached.urlRef);
    const headers = Object.fromEntries(await Promise.all(cached.headerRefs.map(async (ref) => [ref.name, await resolveRef(child, ref)])));
    return { sessionId: cached.sessionId, scopeKey: cached.scopeKey, url, headers };
  }

  async function createOrRotateRef(input: {
    child: typeof toolConnections.$inferSelect;
    cached?: SessionRef;
    name: string;
    configPath: string;
    value: string;
  }): Promise<SessionRef> {
    if (input.cached) {
      await secrets.rotate(input.cached.secretId, { value: input.value });
      return { ...input.cached, name: input.name };
    }
    const secret = await secrets.create(input.child.companyId, {
      name: `${input.child.name} Composio session ${input.name} ${randomUUID().slice(0, 8)}`,
      key: `tool_app.${randomUUID()}.${input.configPath.replace(/[^a-z0-9_:-]+/gi, "_")}`,
      provider: "local_encrypted",
      value: input.value,
      description: `Hosted Composio MCP session credential for ${input.child.name}.`,
    });
    return { name: input.name, configPath: input.configPath, secretId: secret.id };
  }

  async function mint(
    connectionId: string,
    tools: string[],
    force: boolean,
    scopeRevision?: string,
  ): Promise<ComposioSessionCredentials> {
    const child = await connectionRow(connectionId);
    const config = composioChildConfig(child);
    if (!config) throw unprocessable("This connection is not a Composio toolkit child.", { code: "not_composio_child" });
    const { apiKey, revision } = await parentApiKey(child, config);
    const scopeKey = scopeKeyFor(config.toolkitSlug, tools);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      revision,
      toolkitSlug: config.toolkitSlug,
      connectedAccountId: config.connectedAccountId ?? null,
      tools,
      scopeRevision: scopeRevision ?? null,
    })).digest("hex");
    const cache = cacheFrom(child);
    const cached = cache[scopeKey];
    if (!force && cached?.fingerprint === fingerprint && Date.parse(cached.createdAt) + ttlMs > now().getTime()) {
      return resolveCached(child, cached);
    }

    const client = options.composioClientFactory?.(apiKey) ?? createComposioClient({ apiKey });
    const session = await client.createSession(`paperclip:${child.companyId}`, {
      mcp: true,
      toolkits: [config.toolkitSlug],
      ...(tools.length > 0 ? { tools: { [config.toolkitSlug]: { enable: tools } } } : {}),
      ...(config.connectedAccountId ? { connectedAccounts: { [config.toolkitSlug]: [config.connectedAccountId] } } : {}),
    });
    if (!session.mcp?.url) throw unprocessable("Composio did not return a hosted MCP URL.", { code: "composio_session_invalid" });

    const prefix = `composio.session.${scopeKey}`;
    const urlRef = await createOrRotateRef({
      child,
      cached: cached?.urlRef,
      name: "url",
      configPath: `${prefix}.url`,
      value: session.mcp.url,
    });
    const priorHeaders = new Map((cached?.headerRefs ?? []).map((ref) => [ref.name.toLowerCase(), ref]));
    const headerRefs: SessionRef[] = [];
    for (const [name, value] of Object.entries(session.mcp.headers ?? {})) {
      headerRefs.push(await createOrRotateRef({
        child,
        cached: priorHeaders.get(name.toLowerCase()),
        name,
        configPath: `${prefix}.header.${createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 16)}`,
        value,
      }));
    }
    const nextCached: CachedSession = {
      sessionId: session.session_id,
      scopeKey,
      fingerprint,
      createdAt: now().toISOString(),
      urlRef,
      headerRefs,
    };
    const nextCache = { ...cache, [scopeKey]: nextCached };
    const refsByPath = new Map(child.credentialSecretRefs.map((ref) => [ref.configPath, ref]));
    for (const ref of [urlRef, ...headerRefs]) {
      refsByPath.set(ref.configPath, {
        secretId: ref.secretId,
        versionSelector: "latest",
        configPath: ref.configPath,
        required: true,
        label: ref.name === "url" ? "Composio MCP session URL" : `Composio MCP ${ref.name} header`,
        keyScope: scopeKey,
      } satisfies ToolCredentialSecretRef);
    }
    const credentialSecretRefs = [...refsByPath.values()];
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(toolConnections).set({
        transportConfig: { ...record(child.transportConfig), composioSessions: nextCache },
        credentialSecretRefs,
        updatedAt: now(),
      }).where(eq(toolConnections.id, child.id)).returning();
      await tx.delete(companySecretBindings).where(and(
        eq(companySecretBindings.companyId, child.companyId),
        eq(companySecretBindings.targetType, "tool_connection"),
        eq(companySecretBindings.targetId, child.id),
      ));
      if (credentialSecretRefs.length > 0) {
        await tx.insert(companySecretBindings).values(credentialSecretRefs.map((ref) => ({
          companyId: child.companyId,
          secretId: ref.secretId,
          targetType: "tool_connection" as const,
          targetId: child.id,
          configPath: ref.configPath,
          projectionClass: ref.projectionClass ?? "unclassified",
          projectionAllowlistKey: ref.projectionAllowlistKey ?? null,
        })));
      }
      return row;
    });
    return resolveCached(updated, nextCached);
  }

  return {
    ensureSession(connectionId: string, input: { tools?: string[]; force?: boolean; scopeRevision?: string } = {}) {
      const tools = normalizedTools(input.tools);
      const previous = sessionQueues.get(connectionId) ?? Promise.resolve();
      const pending = previous.catch(() => undefined).then(
        () => mint(connectionId, tools, input.force === true, input.scopeRevision),
      );
      const queued = pending.then(() => undefined, () => undefined);
      sessionQueues.set(connectionId, queued);
      return pending.finally(() => {
        if (sessionQueues.get(connectionId) === queued) sessionQueues.delete(connectionId);
      });
    },
  };
}
