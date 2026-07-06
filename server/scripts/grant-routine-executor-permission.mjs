// One-shot permission grant: routines:execute_comment for Impact Gate daemon.
// Run from server/ via: pnpm exec tsx scripts/grant-routine-executor-permission.mjs
import { and, eq } from "drizzle-orm";
import { createDb, principalPermissionGrants } from "../../packages/db/src/index.ts";
import { loadConfig } from "../src/config.ts";

async function main() {
  const config = loadConfig();
  const db = createDb(config);
  const companyId = "73419cf3-bd37-4a7c-8782-311ccb47fced";
  const agentId = "2b9152a6-07f6-4ae9-87fa-c824012c9ff6";
  const permissionKey = "routines:execute_comment";

  const existing = await db
    .select()
    .from(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.companyId, companyId),
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, agentId),
        eq(principalPermissionGrants.permissionKey, permissionKey),
      ),
    );

  if (existing.length > 0) {
    console.log(JSON.stringify({ status: "already_present", row: existing[0] }, null, 2));
    return;
  }

  const inserted = await db
    .insert(principalPermissionGrants)
    .values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey,
      grantedByAgentId: null,
      metadata: { reason: "impact-gate-daemon: routines:execute_comment" },
    })
    .returning();

  console.log(JSON.stringify({ status: "inserted", row: inserted[0] }, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
