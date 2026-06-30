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

/**
 * Which config keys are secret for a given system (so we never echo them back to
 * clients). Derived from the registry auth field metadata.
 */
function secretKeysFor(systemKey: string): Set<string> {
  const sys = getIntegratorSystem(systemKey);
  const keys = new Set<string>();
  for (const f of sys?.auth.fields ?? []) if (f.secret) keys.add(f.key);
  return keys;
}

function redactConfig(systemKey: string, config: Record<string, unknown>): Record<string, unknown> {
  const secrets = secretKeysFor(systemKey);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) out[k] = secrets.has(k) ? "••••••" : v;
  return out;
}

export function integratorsService(db: Db) {
  function toCompanyIntegrator(
    sys: (typeof INTEGRATOR_REGISTRY)[number],
    row: typeof companyIntegrators.$inferSelect | undefined,
  ): CompanyIntegrator {
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
      config: row ? redactConfig(sys.key, row.config ?? {}) : {},
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
      const now = new Date();
      // Store the full config (incl. credentials) server-side so live calls work.
      // Secrets are redacted on read; never returned to clients.
      const row = existing
        ? await db
            .update(companyIntegrators)
            .set({ status: "connected", config, connectedAt: now, updatedAt: now })
            .where(eq(companyIntegrators.id, existing.id))
            .returning()
            .then((r) => r[0]!)
        : await db
            .insert(companyIntegrators)
            .values({ companyId, integratorKey, status: "connected", config, connectedAt: now })
            .returning()
            .then((r) => r[0]!);
      return toCompanyIntegrator(sys, row);
    },

    async disconnect(companyId: string, integratorKey: string) {
      const sys = getIntegratorSystem(integratorKey);
      if (!sys) return null;
      const now = new Date();
      const row = await db
        .update(companyIntegrators)
        .set({ status: "available", config: {}, connectedAt: null, updatedAt: now })
        .where(and(eq(companyIntegrators.companyId, companyId), eq(companyIntegrators.integratorKey, integratorKey)))
        .returning()
        .then((r) => r[0] ?? null);
      return toCompanyIntegrator(sys, row ?? undefined);
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
      const row = await loadRow(companyId, integratorKey);
      const config = (row?.config as Record<string, unknown>) ?? {};
      // Merge connection config (base URL + credentials) with per-call inputs.
      const values = { ...config, ...inputs };
      return runIntegratorAction({ systemKey: integratorKey, actionKey, values });
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
