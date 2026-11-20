import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";
import { credentialAccessConnectionNameSql } from "./credential-access-visibility.js";
import { readRunFailureCause, withoutSqlStatementText } from "@paperclipai/shared";

/**
 * A run row's `error` without SQL statement text. Rows saved before run errors
 * were cleaned at settlement can still carry a Drizzle `Failed query:` statement
 * and its parameters; every run read that passes through here drops them.
 */
function withoutSqlRunError<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.error !== "string") return value;
  const error = withoutSqlStatementText(record.error, readRunFailureCause(record.resultJson));
  return error === record.error ? value : { ...record, error } as T;
}

const REGISTRY_KEY = "paperclipSecretRedactions";
const OUTPUT_SECRET_KEY = "paperclipOutputSecretRedactions";
// Project only the registry: run contexts can contain megabytes of prompt data.
const registrySnapshot = sql`jsonb_build_object('paperclipSecretRedactions', ${heartbeatRuns.contextSnapshot} -> 'paperclipSecretRedactions')`;

export function runSecretRedactionVersionSql() {
  return sql<string>`md5(coalesce((${heartbeatRuns.contextSnapshot}->${REGISTRY_KEY})::text, ''))`;
}

type RegistryEntry = {
  fingerprintSha256: string;
  material: StoredSecretVersionMaterial;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function registryEntries(contextSnapshot: unknown, key = REGISTRY_KEY): RegistryEntry[] {
  const context = asRecord(contextSnapshot);
  const raw = context?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const entry = asRecord(value);
    const material = asRecord(entry?.material);
    return typeof entry?.fingerprintSha256 === "string" && material
      ? [{ fingerprintSha256: entry.fingerprintSha256, material }]
      : [];
  });
}

function redactText(input: string, values: string[]) {
  return values.reduce(
    (result, value) => value.length > 0 ? result.split(value).join(REDACTED_EVENT_VALUE) : result,
    input,
  );
}

export function redactRegisteredSecretValues<T>(input: T, values: string[], credentialConnectionName: string | null = null): T {
  if (typeof input === "string") return redactText(input, values) as T;
  if (Array.isArray(input)) return input.map((value) => redactRegisteredSecretValues(value, values, credentialConnectionName)) as T;
  // Dates carry no redactable text; rebuilding them via Object.entries would
  // collapse them to `{}` and break every timestamp in redacted responses.
  if (input instanceof Date) return input;
  const record = asRecord(input);
  if (!record) return input;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== REGISTRY_KEY && key !== OUTPUT_SECRET_KEY && key !== "nativeControllerRecovery" && key !== "nativeTaskSessionPublication" && key !== "legacyProcessSettlement")
      .map(([key, value]) => [key, key === "credentialAccess"
        ? (credentialConnectionName ? { connectionName: redactText(credentialConnectionName, values) } : {})
        : redactRegisteredSecretValues(value, values, credentialConnectionName)]),
  ) as T;
}

async function registerEncryptedValues(db: Db, key: string, companyId: string, runId: string, values: readonly string[]) {
  const provider = getSecretProvider("local_encrypted");
  const fingerprints = new Map(values.filter(Boolean).map((value) =>
    [createHash("sha256").update(value).digest("hex"), value] as const));
  if (fingerprints.size === 0) return;
  await db.transaction(async (tx) => {
    const row = await tx.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!row) throw new Error("Heartbeat run redaction registration failed");
    const registered = new Set(registryEntries(row.contextSnapshot, key).map((entry) => entry.fingerprintSha256));
    const added: RegistryEntry[] = [];
    for (const [fingerprintSha256, value] of fingerprints) {
      if (registered.has(fingerprintSha256)) continue;
      const prepared = await provider.createSecret({ value });
      added.push({ fingerprintSha256, material: prepared.material });
    }
    if (added.length === 0) return;
    const contextSnapshot = asRecord(row.contextSnapshot) ?? {};
    const currentEntries = Array.isArray(contextSnapshot[key])
      ? contextSnapshot[key]
      : [];
    await tx.update(heartbeatRuns)
      .set({
        contextSnapshot: { ...contextSnapshot, [key]: [...currentEntries, ...added] },
        updatedAt: new Date(),
      })
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  });
}

export function withRunRedactionHistory<T extends Record<string, unknown>>(next: T, current: unknown): T {
  const locked = asRecord(current) ?? {};
  const preserved = [REGISTRY_KEY, OUTPUT_SECRET_KEY].filter((key) => Array.isArray(locked[key]));
  return preserved.length === 0 ? next : { ...next, ...Object.fromEntries(preserved.map((key) => [key, locked[key]])) };
}

export function createRunOutputSecretStore(db: Db) {
  const provider = getSecretProvider("local_encrypted");
  const snapshot = sql`jsonb_build_object('paperclipOutputSecretRedactions', ${heartbeatRuns.contextSnapshot} -> 'paperclipOutputSecretRedactions')`;
  return {
    registerAll: (companyId: string, runId: string, values: readonly string[]) =>
      registerEncryptedValues(db, OUTPUT_SECRET_KEY, companyId, runId, values),
    valuesForRun: async (companyId: string, runId: string) => {
      const rows = await db.select({ contextSnapshot: snapshot }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
      return Promise.all(rows.flatMap((row) => registryEntries(row.contextSnapshot, OUTPUT_SECRET_KEY))
        .map((entry) => provider.resolveVersion({ material: entry.material, externalRef: null })));
    },
  };
}

export function createRunSecretRedactionRegistry(db: Db) {
  const provider = getSecretProvider("local_encrypted");

  async function valuesForRuns(rows: Array<{ contextSnapshot: unknown }>) {
    const entries = rows.flatMap((row) => registryEntries(row.contextSnapshot));
    const unique = new Map(entries.map((entry) => [entry.fingerprintSha256, entry]));
    const values = await Promise.all(
      [...unique.values()].map((entry) => provider.resolveVersion({
        material: entry.material,
        externalRef: null,
      })),
    );
    return values.sort((left, right) => right.length - left.length);
  }

  async function valuesForRun(companyId: string, runId: string, viewerUserId: string | null) {
    const rows = await db.select({ contextSnapshot: registrySnapshot, credentialConnectionName: credentialAccessConnectionNameSql(viewerUserId) })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
    return { values: await valuesForRuns(rows), credentialConnectionName: rows[0]?.credentialConnectionName ?? null };
  }

  async function valuesForIssue(companyId: string, issueId: string) {
    const rows = await db.select({ contextSnapshot: registrySnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        or(
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          sql`${heartbeatRuns.contextSnapshot} -> 'paperclipIssue' ->> 'id' = ${issueId}`,
        ),
      ));
    return valuesForRuns(rows);
  }

  return {
    redactionValuesForRun: async (companyId: string, runId: string) => valuesForRuns(await db
      .select({ contextSnapshot: registrySnapshot }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))),
    register: (companyId: string, runId: string, value: string) =>
      registerEncryptedValues(db, REGISTRY_KEY, companyId, runId, [value]),
    redactForRuns: async <T extends { id: string }>(companyId: string, runs: T[], viewerUserId: string | null = null): Promise<T[]> => {
      if (runs.length === 0) return [];
      const rows = await db.select({ id: heartbeatRuns.id, contextSnapshot: registrySnapshot, credentialConnectionName: credentialAccessConnectionNameSql(viewerUserId) })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runs.map((run) => run.id))));
      // Resolve each encrypted value once per request, but apply only each run's
      // own registry. Do not retain plaintext secrets across requests.
      const resolved = new Map<string, Promise<string>>();
      const valuesByRun = new Map(await Promise.all(rows.map(async (row) => {
        const values = await Promise.all(registryEntries(row.contextSnapshot).map((entry) => {
          let value = resolved.get(entry.fingerprintSha256);
          if (!value) {
            value = provider.resolveVersion({ material: entry.material, externalRef: null });
            resolved.set(entry.fingerprintSha256, value);
          }
          return value;
        }));
        return [row.id, { values: values.sort((a, b) => b.length - a.length), credentialConnectionName: row.credentialConnectionName ?? null }] as const;
      })));
      return runs.map((run) => {
        const disclosure = valuesByRun.get(run.id);
        return redactRegisteredSecretValues(withoutSqlRunError(run), disclosure?.values ?? [], disclosure?.credentialConnectionName ?? null);
      });
    },
    redactorForRun: async (companyId: string, runId: string, viewerUserId: string | null = null) => {
      const disclosure = await valuesForRun(companyId, runId, viewerUserId);
      return <T>(value: T): T => redactRegisteredSecretValues(withoutSqlRunError(value), disclosure.values, disclosure.credentialConnectionName);
    },
    redactForRun: async <T>(companyId: string, runId: string, value: T, viewerUserId: string | null = null): Promise<T> => {
      const disclosure = await valuesForRun(companyId, runId, viewerUserId);
      return redactRegisteredSecretValues(withoutSqlRunError(value), disclosure.values, disclosure.credentialConnectionName);
    },
    redactForIssue: async <T>(companyId: string, issueId: string, value: T): Promise<T> =>
      redactRegisteredSecretValues(value, await valuesForIssue(companyId, issueId)),
  };
}
