import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets } from "@paperclipai/db";
import { CLASS3_STATIC_LEASE_ALLOWLIST } from "@paperclipai/shared";
import { unprocessable } from "../../../errors.js";

function assertClass3ToolCredentialRefAllowed(ref: {
  configPath?: string | null;
  projectionClass?: string | null;
  projectionAllowlistKey?: string | null;
}) {
  const projectionClass = ref.projectionClass ?? "unclassified";
  if (projectionClass !== "class_3_static_lease") return;
  if (!ref.configPath?.trim() || !ref.projectionAllowlistKey?.trim()) {
    throw unprocessable(
      "Class-3 static lease tool credentials require an allowlist key and config path",
      {
        code: "class_3_static_lease_allowlist_required",
        targetType: "tool_connection",
        configPath: ref.configPath ?? null,
      },
    );
  }
  const allowed = CLASS3_STATIC_LEASE_ALLOWLIST.some(
    (entry) =>
      entry.key === ref.projectionAllowlistKey &&
      entry.targetType === "tool_connection" &&
      entry.configPath === ref.configPath,
  );
  if (!allowed) {
    throw unprocessable(
      "Class-3 static lease tool credential is outside the approved allowlist",
      {
        code: "class_3_static_lease_not_allowed",
        allowlistKey: ref.projectionAllowlistKey,
        targetType: "tool_connection",
        configPath: ref.configPath,
      },
    );
  }
}

export function createConnectionCredentialValidation(db: Db) {
  async function assertSecretRefs(
    companyId: string,
    refs: Array<{
      secretId: string;
      configPath?: string | null;
      projectionClass?: string | null;
      projectionAllowlistKey?: string | null;
    }>,
  ) {
    if (refs.length === 0) return;
    for (const ref of refs) {
      assertClass3ToolCredentialRefAllowed(ref);
    }
    const secretIds = [...new Set(refs.map((ref) => ref.secretId))];
    for (const secretId of secretIds) {
      const [secret] = await db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(
          and(
            eq(companySecrets.id, secretId),
            eq(companySecrets.companyId, companyId),
          ),
        );
      if (!secret)
        throw unprocessable(
          "Tool connection credential secrets must belong to the same company",
        );
    }
  }
  return assertSecretRefs;
}
