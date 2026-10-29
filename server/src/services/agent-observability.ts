import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { companyObservability, type Db } from "@paperclipai/db";
import {
  agentObservabilityCaptureSchema, agentObservabilityDestinationSchema, agentObservabilityHeadersSchema,
  DEFAULT_AGENT_OBSERVABILITY_CAPTURE, updateAgentObservabilitySchema,
  isSameOtlpOrigin,
  type AgentObservabilitySettings, type AgentObservabilityTestReceipt, type UpdateAgentObservabilityRequest, type AgentObservabilityUnavailableReason,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";

type Row = typeof companyObservability.$inferSelect;
const target = { targetType: "system" as const, targetId: "company-observability" };
const binding = { consumerType: "system" as const, consumerId: target.targetId, configPath: "headers", actorType: "system" as const };
const credentialSchema = "paperclip.agent_observability.credentials.v1";
type ResolutionAccess = { runId?: string; agentId?: string; userId?: string; responsibleUserId?: string | null; issueId?: string | null };
export type ResolvedAgentObservability = {
  state: "disabled" | "unavailable"; revision: string | null; compatibilityKey: string; reason?: string;
} | {
  state: "enabled"; revision: string; compatibilityKey: string;
  logsEndpoint: string; tracesEndpoint: string; headers: Readonly<Record<string, string>>;
  capture: typeof DEFAULT_AGENT_OBSERVABILITY_CAPTURE | AgentObservabilitySettings["capture"];
};

function identity(companyId: string, revision: string | null, state: string, version?: number) {
  return createHash("sha256").update(JSON.stringify(["paperclip.agent-observability.launch.v1", companyId, revision, state, version ?? null])).digest("hex");
}
export function unavailableAgentObservability(companyId: string, reason: AgentObservabilityUnavailableReason, revision: string | null = null): ResolvedAgentObservability {
  return { state: "unavailable", reason, revision, compatibilityKey: identity(companyId, revision, `unavailable:${reason}`) };
}
function settingsDto(row: Row): AgentObservabilitySettings {
  return { companyId: row.companyId, revision: row.revision, enabled: row.enabled,
    destination: agentObservabilityDestinationSchema.parse(row.destination), capture: agentObservabilityCaptureSchema.parse(row.capture),
    credentialsConfigured: Boolean(row.credentialsSecretId), headerNames: row.headerNames,
    updatedAt: row.updatedAt.toISOString(), lastTest: row.lastTest };
}
function assertRevision(row: Row | undefined, expectedRevision: string | null) {
  if ((row?.revision ?? null) !== expectedRevision) {
    throw conflict("Agent observability settings changed. Reload saved settings before saving again.", { code: "observability_revision_conflict" });
  }
}

export function agentObservabilityService(db: Db) {
  const getRow = (companyId: string, executor = db) => executor.select().from(companyObservability)
    .where(eq(companyObservability.companyId, companyId)).then(rows => rows[0]);

  async function readCredentials(companyId: string, row: Row, executor = db, access: ResolutionAccess = {}): Promise<{ headers: Record<string, string>; version?: number }> {
    if (!row.credentialsSecretId) {
      if (row.destination.provider === "braintrust" || row.headerNames.length) throw unprocessable("Observability credentials are unavailable");
      return { headers: {} };
    }
    const secrets = secretService(executor);
    const context = { ...binding, heartbeatRunId: access.runId ?? null, issueId: access.issueId ?? null,
      responsibleUserId: access.responsibleUserId ?? access.userId ?? null,
      actorType: access.userId ? "user" as const : access.agentId ? "agent" as const : "system" as const,
      actorId: access.userId ?? access.agentId ?? null };
    const version = await secrets.resolveSecretVersion(companyId, row.credentialsSecretId, "latest", context);
    const raw = await secrets.resolveSecretValue(companyId, row.credentialsSecretId, version, context);
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== credentialSchema || !("headers" in value)
      || !value.headers || typeof value.headers !== "object" || Array.isArray(value.headers)) throw unprocessable("Observability credentials are unavailable");
    const entries = agentObservabilityHeadersSchema.parse(Object.entries(value.headers).map(([name, header]) => ({ name, value: header })));
    const headers = Object.fromEntries(entries.map(entry => [entry.name, entry.value!]));
    if (row.destination.provider === "braintrust" && !headers.authorization) throw unprocessable("Observability credentials are unavailable");
    return { headers, version };
  }

  return {
    settings: async (companyId: string) => { const row = await getRow(companyId); return row ? settingsDto(row) : null; },
    configure: async (companyId: string, userId: string, input: UpdateAgentObservabilityRequest) => {
      const data = updateAgentObservabilitySchema.parse(input);
      // Match credential writers: filesystem mutation ownership precedes DB row locks.
      return withAccountHomeSecretMutationLock(undefined, companyId, () => withAccountingTransaction(db, companyId, async (tx, publications) => {
        const previous = await getRow(companyId, tx);
        assertRevision(previous, data.expectedRevision);
        if ((!previous || previous.destination.provider !== data.destination.provider) && data.credentials.mode === "keep") {
          throw unprocessable("Provide credentials when choosing a new destination", { code: "observability_credentials_required" });
        }
        const originChanged = previous?.destination.provider === "otlp" && data.destination.provider === "otlp"
          && !isSameOtlpOrigin(previous.destination, data.destination);
        if (originChanged && (data.credentials.mode === "keep" && previous.headerNames.length > 0
          || data.credentials.mode === "replace" && "headers" in data.credentials && data.credentials.headers.some(header => header.value === undefined))) {
          throw unprocessable("Re-enter every header value for the new endpoint, or remove the header", { code: "observability_credentials_required" });
        }
        const secrets = secretService(tx);
        let secretId = previous?.credentialsSecretId ?? null;
        let headerNames = previous?.headerNames ?? [];
        if (data.credentials.mode === "replace") {
          let headers: Record<string, string>;
          if ("apiKey" in data.credentials) {
            headers = { authorization: `Bearer ${data.credentials.apiKey}` };
          } else {
            const needsSaved = data.credentials.headers.some(header => header.value === undefined);
            const saved = needsSaved && previous && previous.destination.provider === "otlp"
              ? (await readCredentials(companyId, previous, tx, { userId })).headers : {};
            headers = Object.fromEntries(data.credentials.headers.map(header => {
              const value = header.value ?? saved[header.name];
              if (value === undefined) throw unprocessable("New or renamed headers require a value", { code: "observability_header_value_required" });
              return [header.name, value];
            }));
          }
          agentObservabilityHeadersSchema.parse(Object.entries(headers).map(([name, value]) => ({ name, value })));
          headerNames = Object.keys(headers).sort();
          if (headerNames.length) {
            const value = JSON.stringify({ schema: credentialSchema, headers });
            if (secretId) {
              // Existing inactive/deleted credentials may be replaced without resolving them.
              const old = await secrets.getById(secretId);
              if (old?.status === "active") await secrets.rotate(secretId, { value });
              else secretId = null;
            }
            if (!secretId) {
              const suffix = randomUUID();
              const secret = await secrets.create(companyId, { name: `agent-observability.${suffix}`, key: `AGENT_OBSERVABILITY_HEADERS_${suffix.replaceAll("-", "_")}`,
                provider: "local_encrypted", managedMode: "paperclip_managed", value }, { userId });
              secretId = secret.id;
            }
          } else secretId = null;
          await secrets.syncSecretRefsForTarget(companyId, target, secretId ? [{ secretId, configPath: "headers", versionSelector: "latest", projectionClass: "unclassified" }] : [], { replaceAll: true });
        }
        if (data.enabled && data.destination.provider === "braintrust" && !secretId) {
          throw unprocessable("Provide a Braintrust API key", { code: "observability_credentials_required" });
        }
        const values = { companyId, revision: randomUUID(), enabled: data.enabled, destination: data.destination,
          capture: data.capture, credentialsSecretId: secretId, headerNames, lastTest: null, updatedAt: new Date() };
        const [row] = await tx.insert(companyObservability).values(values).onConflictDoUpdate({ target: companyObservability.companyId, set: values }).returning();
        if (previous?.credentialsSecretId && previous.credentialsSecretId !== secretId) await secrets.remove(previous.credentialsSecretId);
        await logActivity(tx, { companyId, actorType: "user", actorId: userId, action: "agent_observability.configured", entityType: "company", entityId: companyId,
          details: { revision: row.revision, enabled: row.enabled, provider: row.destination.provider, capture: row.capture, headerCount: headerNames.length } }, publications);
        return settingsDto(row);
      }));
    },
    remove: async (companyId: string, userId: string, expectedRevision: string) => withAccountHomeSecretMutationLock(undefined, companyId, () => withAccountingTransaction(db, companyId, async (tx, publications) => {
      const row = await getRow(companyId, tx);
      assertRevision(row, expectedRevision);
      if (!row) throw notFound("Agent observability is not configured");
      const secrets = secretService(tx);
      await secrets.syncSecretRefsForTarget(companyId, target, [], { replaceAll: true });
      await tx.delete(companyObservability).where(eq(companyObservability.companyId, companyId));
      if (row.credentialsSecretId) await secrets.remove(row.credentialsSecretId);
      await logActivity(tx, { companyId, actorType: "user", actorId: userId, action: "agent_observability.removed", entityType: "company", entityId: companyId,
        details: { revision: row.revision } }, publications);
    })),
    resolve: async (companyId: string, options: ResolutionAccess & { forTest?: boolean; expectedRevision?: string; unavailableReason?: AgentObservabilityUnavailableReason } = {}): Promise<ResolvedAgentObservability> => {
      const row = await getRow(companyId);
      if (options.expectedRevision) { if (!row) throw notFound("Agent observability is not configured"); assertRevision(row, options.expectedRevision); }
      if (!row || (!row.enabled && !options.forTest)) return { state: "disabled", revision: row?.revision ?? null, compatibilityKey: identity(companyId, row?.revision ?? null, "disabled") };
      const unavailable = (reason: AgentObservabilityUnavailableReason) => unavailableAgentObservability(companyId, reason, row.revision);
      if (options.unavailableReason) return unavailable(options.unavailableReason);
      let destination: AgentObservabilitySettings["destination"], capture: AgentObservabilitySettings["capture"];
      try { destination = agentObservabilityDestinationSchema.parse(row.destination); capture = agentObservabilityCaptureSchema.parse(row.capture); }
      catch { return unavailable("configuration_invalid"); }
      try {
        const { headers, version } = await readCredentials(companyId, row, db, options);
        const base = destination.provider === "braintrust" ? "https://api.braintrust.dev/otel" : destination.endpointBaseUrl;
        return { state: "enabled", revision: row.revision, compatibilityKey: identity(companyId, row.revision, "enabled", version), capture,
          logsEndpoint: `${base}/v1/logs`, tracesEndpoint: `${base}/v1/traces`,
          headers: Object.freeze({ ...headers, ...(destination.provider === "braintrust" ? { "x-bt-parent": `project_id:${destination.projectId}` } : {}) }) };
      } catch { return unavailable("credentials_unavailable"); }
    },
    // The company deletion owner acquires mutation ownership before its company lock, and owns commit/publication.
    removeForCompanyDeletion: async (companyId: string) => {
      const row = await getRow(companyId);
      if (!row) return;
      const secrets = secretService(db);
      await secrets.syncSecretRefsForTarget(companyId, target, [], { replaceAll: true });
      await db.delete(companyObservability).where(eq(companyObservability.companyId, companyId));
      if (row.credentialsSecretId) await secrets.remove(row.credentialsSecretId);
    },
    recordTest: async (companyId: string, userId: string, receipt: AgentObservabilityTestReceipt) => withAccountingTransaction(db, companyId, async (tx, publications) => {
      assertRevision(await getRow(companyId, tx), receipt.revision);
      await tx.update(companyObservability).set({ lastTest: receipt }).where(and(eq(companyObservability.companyId, companyId), eq(companyObservability.revision, receipt.revision)));
      await logActivity(tx, { companyId, actorType: "user", actorId: userId, action: "agent_observability.tested", entityType: "company", entityId: companyId,
        details: { revision: receipt.revision, status: receipt.status, marker: receipt.marker } }, publications);
      return receipt;
    }),
  };
}
