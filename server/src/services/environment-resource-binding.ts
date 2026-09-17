import { and, eq, sql } from "drizzle-orm";
import { environments, type Db } from "@paperclipai/db";
import type { PluginEnvironmentResourceBinding } from "@paperclipai/plugin-sdk";
import { conflict } from "../errors.js";

export function parseResourceBinding(value: unknown): PluginEnvironmentResourceBinding | undefined {
  if (value == null) return undefined;
  const binding = value as PluginEnvironmentResourceBinding;
  if (binding.provider !== "exe-dev" || typeof binding.companyId !== "string" || !binding.companyId || typeof binding.resourceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(binding.resourceId) || typeof binding.identity !== "string" || !/^[a-f0-9-]{36}$/.test(binding.identity)) {
    throw conflict("Invalid durable environment resource binding");
  }
  return { provider: binding.provider, companyId: binding.companyId, resourceId: binding.resourceId, identity: binding.identity };
}

export async function readEnvironmentResourceBinding(db: Db, environmentId: string, companyId: string) {
  // Environments are instance-scoped; the durable binding carries ownership.
  // Lease insertion separately rechecks the existing company binding contract.
  const [row] = await db.select({ metadata: environments.metadata }).from(environments).where(eq(environments.id, environmentId));
  const binding = parseResourceBinding(row?.metadata?.environmentResourceBinding);
  if (binding && binding.companyId !== companyId) throw conflict("Durable VM belongs to another company");
  return binding;
}

/** Atomic compare-and-set: concurrent first acquisitions must agree on identity. */
export async function bindEnvironmentResource(db: Db, environmentId: string, companyId: string, value: unknown) {
  const binding = parseResourceBinding(value);
  if (!binding || binding.companyId !== companyId) throw conflict("Provider did not attest a company-scoped durable VM binding");
  const encoded = JSON.stringify(binding);
  const rows = await db.update(environments).set({
    metadata: sql`coalesce(${environments.metadata}, '{}'::jsonb) || jsonb_build_object('environmentResourceBinding', ${encoded}::jsonb)`,
    // Binding attestation is runtime state. updatedAt is also the configuration
    // revision used for session compatibility; changing it would rotate every
    // agent session when this VM is first bound or another lease is acquired.
  }).where(and(eq(environments.id, environmentId), sql`(${environments.metadata}->'environmentResourceBinding' IS NULL OR ${environments.metadata}->'environmentResourceBinding' = ${encoded}::jsonb)`)).returning({ id: environments.id });
  if (rows.length !== 1) throw conflict("Durable VM identity changed; explicit recovery to a new environment is required");
}
