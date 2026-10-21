import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { companySecrets, companySecretVersions, type Db } from "@paperclipai/db";
import type { SandboxEnvironmentConfig } from "@paperclipai/shared";
import { collectSecretRefPaths, isUuidSecretRef, parseSecretRefBindingObject, readConfigValueAtPath, writeConfigValueAtPath } from "./json-schema-secret-refs.js";
import { secretService } from "./secrets.js";

/** A 404 under replacement credentials says nothing about the old resource.
 * Legacy leases did not record a secret-version manifest. Only an unrotated
 * initial version whose resolved bytes still match its immutable hash can
 * establish their credential identity. Other histories need explicit evidence.
 * Normal cleanup resolution and run-continuation rules remain unchanged. */
export async function historicalProviderCredentials(db: Db, companyId: string,
  config: SandboxEnvironmentConfig, schema: Record<string, unknown> | null | undefined,
  context: { issueId: string | null; heartbeatRunId: string | null },
): Promise<SandboxEnvironmentConfig | undefined> {
  let resolved = { ...config } as Record<string, unknown>;
  for (const path of collectSecretRefPaths(schema)) {
    const raw = readConfigValueAtPath(resolved, path);
    const binding = parseSecretRefBindingObject(raw);
    if (binding && binding.version !== "latest" && binding.version !== 1) return undefined;
    const ref = binding?.secretId ?? (typeof raw === "string" ? raw.trim() : null);
    if (!ref || !isUuidSecretRef(ref)) continue;
    const [version] = await db.select({ hash: companySecretVersions.valueSha256 })
      .from(companySecrets).innerJoin(companySecretVersions, and(
        eq(companySecretVersions.secretId, companySecrets.id), eq(companySecretVersions.version, 1)))
      .where(and(eq(companySecrets.id, ref), eq(companySecrets.companyId, companyId),
        eq(companySecrets.latestVersion, 1), eq(companySecrets.status, "active"),
        sql`${companySecretVersions.revokedAt} IS NULL`,
        sql`NOT EXISTS (SELECT 1 FROM company_secret_versions other_version
          WHERE other_version.secret_id = ${companySecrets.id} AND other_version.version <> 1)`));
    if (!version) return undefined;
    const value = await secretService(db).resolveSecretValueForSandboxCleanup(companyId, ref, 1, { ...context, configPath: path });
    if (createHash("sha256").update(value).digest("hex") !== version.hash) return undefined;
    resolved = writeConfigValueAtPath(resolved, path, value);
  }
  if (resolved.provider === "daytona" && (typeof resolved.apiKey !== "string" ||
      !resolved.apiKey.trim() || isUuidSecretRef(resolved.apiKey.trim()))) return undefined;
  return resolved as SandboxEnvironmentConfig;
}
