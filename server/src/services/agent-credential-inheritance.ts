import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Merge a donor agent's credential env bindings into a new agent's requested env,
 * so newly created/provisioned agents inherit the company's working credential.
 * Only `secret_ref` bindings are inherited (the shape the credential-connect flow
 * produces), any env key the request already set is left untouched, and the donor
 * binding's projection semantics are preserved verbatim. Pure/testable.
 */
export function mergeInheritedCredentialEnv(
  donorEnv: Record<string, unknown>,
  requestedEnv: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...requestedEnv };
  for (const [envKey, binding] of Object.entries(donorEnv)) {
    const parsed = asRecord(binding);
    if (!parsed || parsed.type !== "secret_ref" || typeof parsed.secretId !== "string") continue;
    if (Object.prototype.hasOwnProperty.call(requestedEnv, envKey)) continue;
    const inherited: Record<string, unknown> = {
      type: "secret_ref",
      secretId: parsed.secretId,
      version: parsed.version ?? "latest",
    };
    if (typeof parsed.projectionClass === "string") inherited.projectionClass = parsed.projectionClass;
    if (parsed.projectionAllowlistKey !== undefined) inherited.projectionAllowlistKey = parsed.projectionAllowlistKey;
    merged[envKey] = inherited;
  }
  return merged;
}

// Inherit the company's credential env bindings onto a newly created/provisioned
// agent so it can authenticate without the user re-connecting a key for every
// agent. Copies each `secret_ref` env binding from an existing same-adapter
// company agent (preferring the CEO) into the new agent's `adapterConfig.env`,
// never overriding an env the request set explicitly. No-op when no donor agent
// of the same adapterType has a credential (no behavior change / no regression).
export async function inheritCompanyCredentialEnv(
  db: Db,
  companyId: string,
  adapterType: string,
  requestedAdapterConfig: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestedEnv = asRecord(requestedAdapterConfig.env) ?? {};
  let donorRows: Array<{ role: string | null; adapterConfig: unknown }>;
  try {
    donorRows = await db
      .select({ role: agents.role, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.adapterType, adapterType)));
  } catch {
    return requestedAdapterConfig;
  }
  // A donor must have at least one secret_ref binding: an agent whose env is
  // empty (or holds only plain/cleared values) would otherwise win the ceo
  // preference and make inheritance a silent no-op.
  const donors = donorRows.filter((row) => {
    const env = asRecord(asRecord(row.adapterConfig)?.env);
    if (!env) return false;
    return Object.values(env).some((binding) => {
      const parsed = asRecord(binding);
      return parsed?.type === "secret_ref" && typeof parsed.secretId === "string";
    });
  });
  const donor = donors.find((row) => row.role === "ceo") ?? donors[0];
  if (!donor) return requestedAdapterConfig;
  const donorEnv = asRecord(asRecord(donor.adapterConfig)?.env) ?? {};
  return { ...requestedAdapterConfig, env: mergeInheritedCredentialEnv(donorEnv, requestedEnv) };
}
