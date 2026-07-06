// One-shot backfill: grant `routines:execute_comment` to AutomationEngineer in the
// Paperclip-BTCAAAAA-main company so the Impact Gate 5-min polling daemon can post
// comments on issues it does not own (the assignee slot is held by the human/agent
// owner; the daemon only carries a routine-execution bearer + X-Paperclip-Run-Id).
//
// Idempotent: re-running is a no-op once the row exists.
//
// Usage:
//   pnpm tsx server/scripts/backfill-routine-executor-comment-grant.ts \
//     --company 73419cf3-bd37-4a7c-8782-311ccb47fced \
//     --agent   2b9152a6-07f6-4ae9-87fa-c824012c9ff6

import { and, eq } from "drizzle-orm";
import { agents, companies, createDb, principalPermissionGrants } from "../../packages/db/src/index.js";
import { loadConfig } from "../src/config.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);

  const companyId = parseFlag("--company");
  const agentId = parseFlag("--agent");
  const permissionKey = "routines:execute_comment";

  if (!companyId || !agentId) {
    console.error("Usage: --company <uuid> --agent <uuid>");
    process.exitCode = 2;
    return;
  }

  const companyRow = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (!companyRow) {
    console.error(`Company ${companyId} not found.`);
    process.exitCode = 2;
    return;
  }

  const agentRow = await db
    .select({ id: agents.id, companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
  if (!agentRow) {
    console.error(`Agent ${agentId} not found.`);
    process.exitCode = 2;
    return;
  }
  if (agentRow.companyId !== companyId) {
    console.error(
      `Agent ${agentId} belongs to company ${agentRow.companyId}, not ${companyId}. Refusing to grant.`,
    );
    process.exitCode = 2;
    return;
  }

  const existing = await db
    .select({ id: principalPermissionGrants.id })
    .from(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.companyId, companyId),
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, agentId),
        eq(principalPermissionGrants.permissionKey, permissionKey),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (existing) {
    console.log(
      `Grant already present: company=${companyId} agent=${agentId} key=${permissionKey} grant_id=${existing.id}`,
    );
    return;
  }

  await db.insert(principalPermissionGrants).values({
    companyId,
    principalType: "agent",
    principalId: agentId,
    permissionKey,
    scope: null,
    grantedByUserId: null,
  });

  console.log(
    `Granted ${permissionKey} to agent ${agentId} in company ${companyId}.`,
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Routine-executor grant backfill failed: ${message}`);
  process.exitCode = 1;
});