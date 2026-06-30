import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyIntegrators } from "@paperclipai/db";
import {
  INTEGRATOR_REGISTRY,
  getIntegratorSystem,
  type CompanyIntegrator,
  type IntegratorConnectionStatus,
} from "@paperclipai/shared";
import { runIntegratorAction, type RunActionResult } from "./integrator-runtime.js";
import { secretService } from "./secrets.js";

/** Redaction sentinel echoed to clients for stored secret fields. */
const SECRET_MASK = "••••••";

/**
 * Stored config shape. Non-secret auth fields are persisted inline; secret
 * fields never touch this JSON — instead we keep a pointer (`__secrets`) to the
 * `company_secrets` vault entry that holds the encrypted value.
 */
type StoredConfig = Record<string, unknown> & { __secrets?: Record<string, string> };

/** Agent-facing descriptor for one connected integrator action. */
export interface IntegratorAgentTool {
  name: string;
  integratorKey: string;
  actionKey: string;
  system: string;
  category: string;
  description: string;
  endpoint: string;
  inputs: Array<{ key: string; label: string; required: boolean; type: string; placeholder?: string }>;
  body: { action: string; inputs: Record<string, string> };
}

/** Which config keys are secret for a given system. Derived from registry auth metadata. */
function secretKeysFor(systemKey: string): Set<string> {
  const sys = getIntegratorSystem(systemKey);
  const keys = new Set<string>();
  for (const f of sys?.auth.fields ?? []) if (f.secret) keys.add(f.key);
  return keys;
}

/** Stable vault secret name for an integrator credential field. */
function secretName(companyKey: string, integratorKey: string, field: string): string {
  return `integrator:${integratorKey}:${field}`;
}

export function integratorsService(db: Db) {
  const secrets = secretService(db);

  function toCompanyIntegrator(
    sys: (typeof INTEGRATOR_REGISTRY)[number],
    row: typeof companyIntegrators.$inferSelect | undefined,
  ): CompanyIntegrator {
    const stored = (row?.config as StoredConfig) ?? {};
    const secretRefs = stored.__secrets ?? {};
    // Build the client-facing config: inline non-secret fields, mask any secret
    // field that has a vault entry. Never expose secret values or secret ids.
    const view: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(stored)) {
      if (k === "__secrets") continue;
      view[k] = v;
    }
    for (const field of Object.keys(secretRefs)) view[field] = SECRET_MASK;

    return {
      key: sys.key,
      name: sys.name,
      category: sys.category,
      description: sys.description,
      icon: sys.icon,
      authScheme: sys.auth.scheme,
      authFields: sys.auth.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        required: f.required,
        secret: f.secret,
        placeholder: f.placeholder,
      })),
      actions: sys.actions.map((a) => ({
        key: a.key,
        label: a.label,
        description: a.description,
        fields: a.fields.map((f) => ({ key: f.key, label: f.label, required: f.required, placeholder: f.placeholder, type: f.type })),
      })),
      status: (row?.status as IntegratorConnectionStatus) ?? "available",
      config: view,
      connectedAt: row?.connectedAt ? row.connectedAt.toISOString() : null,
    };
  }

  async function loadRow(companyId: string, integratorKey: string) {
    return db
      .select()
      .from(companyIntegrators)
      .where(and(eq(companyIntegrators.companyId, companyId), eq(companyIntegrators.integratorKey, integratorKey)))
      .then((r) => r[0] ?? null);
  }

  /** Upsert a credential into the vault, returning its secret id (or null if cleared). */
  async function persistSecretField(
    companyId: string,
    integratorKey: string,
    field: string,
    value: string,
    existingSecretId: string | undefined,
  ): Promise<string | null> {
    const name = secretName(companyId, integratorKey, field);
    if (existingSecretId) {
      const priorId = existingSecretId;
      try {
        // Rotate the existing vault entry in place.
        await secrets.rotate(priorId, { value });
        return priorId;
      } catch {
        // If the prior secret is gone/inactive, fall through to a fresh create.
        await secrets.remove(priorId).catch(() => undefined);
      }
    }
    const created = await secrets.create(companyId, {
      name,
      provider: "local_encrypted",
      value,
      description: `Credential for integrator ${integratorKey} (${field})`,
    });
    return created?.id ?? null;
  }

  /** Soft-delete every vault entry referenced by a stored config. */
  async function purgeSecrets(stored: StoredConfig | undefined) {
    for (const secretId of Object.values(stored?.__secrets ?? {})) {
      await secrets.remove(secretId).catch(() => undefined);
    }
  }

  return {
    async list(companyId: string): Promise<CompanyIntegrator[]> {
      const rows = await db
        .select()
        .from(companyIntegrators)
        .where(eq(companyIntegrators.companyId, companyId));
      const byKey = new Map(rows.map((r) => [r.integratorKey, r]));
      return INTEGRATOR_REGISTRY.map((sys) => toCompanyIntegrator(sys, byKey.get(sys.key)));
    },

    async connect(companyId: string, integratorKey: string, config: Record<string, unknown>) {
      const sys = getIntegratorSystem(integratorKey);
      if (!sys) return null;
      const existing = await loadRow(companyId, integratorKey);
      const prevStored = (existing?.config as StoredConfig) ?? {};
      const prevSecrets = prevStored.__secrets ?? {};
      const secretKeys = secretKeysFor(integratorKey);

      const inline: Record<string, unknown> = {};
      const nextSecrets: Record<string, string> = { ...prevSecrets };
      for (const [k, raw] of Object.entries(config)) {
        if (!secretKeys.has(k)) {
          inline[k] = raw;
          continue;
        }
        const value = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
        // A masked or empty value means "leave the stored credential as-is".
        if (value === "" || value === SECRET_MASK) continue;
        const secretId = await persistSecretField(companyId, integratorKey, k, value, prevSecrets[k]);
        if (secretId) nextSecrets[k] = secretId;
      }
      const nextConfig: StoredConfig = { ...inline };
      if (Object.keys(nextSecrets).length > 0) nextConfig.__secrets = nextSecrets;

      const now = new Date();
      const row = existing
        ? await db
            .update(companyIntegrators)
            .set({ status: "connected", config: nextConfig, connectedAt: now, updatedAt: now })
            .where(eq(companyIntegrators.id, existing.id))
            .returning()
            .then((r) => r[0]!)
        : await db
            .insert(companyIntegrators)
            .values({ companyId, integratorKey, status: "connected", config: nextConfig, connectedAt: now })
            .returning()
            .then((r) => r[0]!);
      return toCompanyIntegrator(sys, row);
    },

    async disconnect(companyId: string, integratorKey: string) {
      const sys = getIntegratorSystem(integratorKey);
      if (!sys) return null;
      const existing = await loadRow(companyId, integratorKey);
      await purgeSecrets(existing?.config as StoredConfig);
      const now = new Date();
      const row = await db
        .update(companyIntegrators)
        .set({ status: "available", config: {}, connectedAt: null, updatedAt: now })
        .where(and(eq(companyIntegrators.companyId, companyId), eq(companyIntegrators.integratorKey, integratorKey)))
        .returning()
        .then((r) => r[0] ?? null);
      return toCompanyIntegrator(sys, row ?? undefined);
    },

    /** Resolve a connected integrator's stored config into live credential values. */
    async resolveConfig(companyId: string, integratorKey: string): Promise<Record<string, unknown>> {
      const row = await loadRow(companyId, integratorKey);
      const stored = (row?.config as StoredConfig) ?? {};
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(stored)) {
        if (k === "__secrets") continue;
        values[k] = v;
      }
      for (const [field, secretId] of Object.entries(stored.__secrets ?? {})) {
        try {
          values[field] = await secrets.resolveSecretValue(companyId, secretId, "latest");
        } catch {
          // Leave the field unset; the live call will surface an auth error.
        }
      }
      return values;
    },

    /** Execute a real, live action against the connected system. */
    async runAction(
      companyId: string,
      integratorKey: string,
      actionKey: string,
      inputs: Record<string, unknown>,
    ): Promise<RunActionResult | { ok: false; error: string; status: number }> {
      const sys = getIntegratorSystem(integratorKey);
      if (!sys) return { ok: false, error: "Unknown integrator", status: 0 };
      const config = await this.resolveConfig(companyId, integratorKey);
      // Merge connection config (base URL + resolved credentials) with per-call inputs.
      const values = { ...config, ...inputs };
      return runIntegratorAction({ systemKey: integratorKey, actionKey, values });
    },

    /**
     * Describe every action of every CONNECTED integrator as an agent-callable
     * tool. Agents invoke these autonomously during a workflow run by POSTing to
     * the run-action endpoint (resolved credentials are injected server-side).
     */
    async toolsCatalog(companyId: string): Promise<IntegratorAgentTool[]> {
      const rows = await db
        .select()
        .from(companyIntegrators)
        .where(eq(companyIntegrators.companyId, companyId));
      const connected = new Set(rows.filter((r) => r.status === "connected").map((r) => r.integratorKey));
      const tools: IntegratorAgentTool[] = [];
      for (const sys of INTEGRATOR_REGISTRY) {
        if (!connected.has(sys.key)) continue;
        for (const action of sys.actions) {
          tools.push({
            name: `integrator.${sys.key}.${action.key}`,
            integratorKey: sys.key,
            actionKey: action.key,
            system: sys.name,
            category: sys.category,
            description: action.description,
            endpoint: `POST /api/companies/${companyId}/integrators/${sys.key}/run-action`,
            inputs: action.fields.map((f) => ({
              key: f.key,
              label: f.label,
              required: Boolean(f.required),
              type: f.type ?? "string",
              placeholder: f.placeholder,
            })),
            body: { action: action.key, inputs: Object.fromEntries(action.fields.map((f) => [f.key, `<${f.type ?? "string"}>`])) },
          });
        }
      }
      return tools;
    },

    /** Idempotently ensure each registry system has a row (used by the auto-seed). */
    async ensureCatalogRows(companyId: string) {
      const rows = await db
        .select()
        .from(companyIntegrators)
        .where(eq(companyIntegrators.companyId, companyId));
      const present = new Set(rows.map((r) => r.integratorKey));
      let created = 0;
      for (const sys of INTEGRATOR_REGISTRY) {
        if (present.has(sys.key)) continue;
        await db.insert(companyIntegrators).values({ companyId, integratorKey: sys.key, status: "available" });
        created += 1;
      }
      return { created };
    },
  };
}
