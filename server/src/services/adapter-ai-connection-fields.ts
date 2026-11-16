import { and, eq } from "drizzle-orm";
import { connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import type { AdapterAiConnectionRuntimeValue } from "@paperclipai/adapter-utils";
import {
  aiConnectionMatchesField,
  aiConnectionMetadataSchema,
  aiRoutingBaseUrl,
  parseAiConnectionFieldBinding,
  readAiConnectionFieldMeta,
  type AiConnectionFieldBinding,
  type AiConnectionFieldMeta,
} from "@paperclipai/shared";
import { findActiveServerAdapter } from "../adapters/index.js";
import { HttpError, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { prepareManagedAiRuntime } from "./ai-connection-runtime.js";
import { managedAiHomeEnvironment } from "@paperclipai/adapter-utils/managed-ai-runtime-env";

const NIL_AGENT_ID = "00000000-0000-0000-0000-000000000000";

export interface AdapterAiConnectionField {
  key: string;
  meta: AiConnectionFieldMeta;
}

type ManagedRuntime = Awaited<ReturnType<typeof prepareManagedAiRuntime>>;

export async function listAdapterAiConnectionFields(adapterType: string | null | undefined): Promise<AdapterAiConnectionField[]> {
  if (!adapterType) return [];
  const adapter = findActiveServerAdapter(adapterType);
  if (!adapter?.getConfigSchema) return [];
  try {
    const schema = await adapter.getConfigSchema();
    return schema.fields.flatMap((field) => {
      const meta = readAiConnectionFieldMeta(field.meta);
      return meta ? [{ key: field.key, meta }] : [];
    });
  } catch (err) {
    logger.warn({ err, adapterType }, "adapter config schema unavailable while reading AI connection fields");
    return [];
  }
}

async function assertConnectionUsable(
  db: Db,
  companyId: string,
  key: string,
  meta: AiConnectionFieldMeta,
  binding: AiConnectionFieldBinding,
  actor: { userId?: string | null; agentId?: string | null } | undefined,
) {
  const { aiConnectionService } = await import("./ai-connections.js");
  const unusable = () => unprocessable(`${key} must be an AI connection you can use that is compatible with ${meta.harness}`);
  if (actor?.userId) {
    try {
      const selection = await aiConnectionService(db).select({
        companyId,
        userId: actor.userId,
        agentId: actor.agentId ?? NIL_AGENT_ID,
        adapterType: meta.harness,
        binding,
        allowUninstalledPersonal: true,
        allowUninstalledShared: true,
      });
      const metadata = aiConnectionMetadataSchema.safeParse(selection.connection.config.ai);
      if (!metadata.success || !aiConnectionMatchesField(meta, metadata.data)) throw unusable();
    } catch (error) {
      if (error instanceof HttpError && (error.status === 403 || error.status === 422)) throw unusable();
      throw error;
    }
    return;
  }
  const [row] = await db
    .select({ connection: toolConnections, grant: connectionGrants })
    .from(toolConnections)
    .innerJoin(
      connectionGrants,
      and(eq(connectionGrants.companyId, toolConnections.companyId), eq(connectionGrants.connectionId, toolConnections.id)),
    )
    .where(and(
      eq(toolConnections.companyId, companyId),
      eq(toolConnections.id, binding.connectionId),
      eq(toolConnections.connectionPurpose, "ai"),
      eq(connectionGrants.id, binding.grantId),
    ));
  const metadata = aiConnectionMetadataSchema.safeParse(row?.connection.config.ai);
  if (
    !row || !metadata.success || row.grant.status !== "active" ||
    metadata.data.provider !== binding.provider || metadata.data.method !== binding.method ||
    (binding.mode === "shared") !== (row.grant.kind === "organization") ||
    !aiConnectionMatchesField(meta, metadata.data)
  ) throw unusable();
}

export async function normalizeAdapterAiConnectionFields(
  db: Db,
  companyId: string,
  adapterConfig: Record<string, unknown>,
  opts?: { adapterType?: string | null; actor?: { userId?: string | null; agentId?: string | null } },
): Promise<Record<string, unknown>> {
  const fields = await listAdapterAiConnectionFields(opts?.adapterType);
  if (fields.length === 0) return adapterConfig;
  const normalized = { ...adapterConfig };
  for (const { key, meta } of fields) {
    if (!Object.prototype.hasOwnProperty.call(adapterConfig, key)) continue;
    const raw = adapterConfig[key];
    if (raw === null || raw === undefined || raw === "") {
      delete normalized[key];
      continue;
    }
    const binding = parseAiConnectionFieldBinding(raw);
    if (!binding) throw unprocessable(`${key} must be a shared or delegated AI connection binding`);
    await assertConnectionUsable(db, companyId, key, meta, binding, opts?.actor);
    normalized[key] = binding;
  }
  return normalized;
}

function projectEnv(env: Record<string, unknown>, home: string | undefined): Record<string, string> {
  const managed = home ? managedAiHomeEnvironment(home) : {};
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1] !== "" && !(entry[0] in managed) && entry[0] !== "OPENCODE_DISABLE_PROJECT_CONFIG"),
  );
}

export async function resolveAdapterAiConnectionFields(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    responsibleUserId: string | null;
    adapterType: string;
    config: Record<string, unknown>;
    onRuntime: (runtime: ManagedRuntime) => void;
  },
): Promise<{ values: Record<string, AdapterAiConnectionRuntimeValue>; secretValues: string[] }> {
  const { prepareManagedAiRuntime } = await import("./ai-connection-runtime.js");
  const values: Record<string, AdapterAiConnectionRuntimeValue> = {};
  const secretValues: string[] = [];
  for (const { key, meta } of await listAdapterAiConnectionFields(input.adapterType)) {
    const raw = input.config[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const binding = parseAiConnectionFieldBinding(raw);
    if (!binding) continue;
    try {
      const runtime = await prepareManagedAiRuntime(db, {
        companyId: input.companyId,
        agentId: input.agentId,
        responsibleUserId: input.responsibleUserId,
        adapterType: meta.harness,
        binding,
        allowUninstalledPersonal: true,
        allowUninstalledShared: true,
        skipProjectAuthCheck: true,
        config: {},
      });
      input.onRuntime(runtime);
      const routing = (runtime.config as { managedAiRouting?: Parameters<typeof aiRoutingBaseUrl>[0] }).managedAiRouting;
      if (!aiConnectionMatchesField(meta, { provider: runtime.attribution.provider, method: runtime.attribution.method, routing })) {
        throw unprocessable("The selected AI connection does not match this setting");
      }
      const env = projectEnv(runtime.config.env as Record<string, unknown>, runtime.home);
      secretValues.push(...Object.values(env));
      values[key] = {
        connectionId: binding.connectionId,
        name: runtime.accountName,
        provider: runtime.attribution.provider,
        method: runtime.attribution.method,
        routing: routing
          ? { kind: routing.kind, protocol: routing.protocol, baseUrl: aiRoutingBaseUrl(routing, meta.harness) }
          : null,
        env,
      };
    } catch (error) {
      logger.warn({ err: error, agentId: input.agentId, key }, "Could not resolve an AI connection setting for this run");
      values[key] = {
        connectionId: binding.connectionId,
        error: error instanceof Error ? error.message : "The AI connection could not be resolved",
      };
    }
  }
  return { values, secretValues };
}

export function stableAdapterAiConnectionConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => {
    const candidate = value as { connectionId?: unknown; env?: unknown; error?: unknown } | null;
    const resolved = candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) &&
      typeof candidate.connectionId === "string" && (typeof candidate.env === "object" || typeof candidate.error === "string");
    return [key, resolved ? { connectionId: candidate.connectionId } : value];
  }));
}
