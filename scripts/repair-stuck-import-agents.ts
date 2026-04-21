import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, approvals, createDb } from "@paperclipai/db";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const db = createDb(dbUrl);

  const pending = await db.select().from(agents).where(eq(agents.status, "pending_approval"));

  if (pending.length === 0) {
    console.log("No agents in pending_approval. Nothing to repair.");
    process.exit(0);
  }

  const openHireApprovals = await db
    .select({ payload: approvals.payload })
    .from(approvals)
    .where(
      and(eq(approvals.type, "hire_agent"), inArray(approvals.status, ["pending", "revision_requested"])),
    );

  const legitimatelyPending = new Set<string>();
  for (const row of openHireApprovals) {
    const agentId = (row.payload as Record<string, unknown> | null)?.agentId;
    if (typeof agentId === "string") legitimatelyPending.add(agentId);
  }

  const stuck = pending.filter((agent) => !legitimatelyPending.has(agent.id));

  console.log(`Found ${pending.length} agents with status='pending_approval'`);
  console.log(`  ${legitimatelyPending.size} have an open hire_agent approval (kept).`);
  console.log(`  ${stuck.length} are stuck with no open hire approval (would be flipped to idle).`);

  for (const agent of stuck) {
    console.log(`  - ${agent.id}  company=${agent.companyId}  role=${agent.role}  name=${agent.name}`);
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to persist changes.");
    process.exit(0);
  }

  if (stuck.length === 0) {
    process.exit(0);
  }

  const ids = stuck.map((a) => a.id);
  const result = await db
    .update(agents)
    .set({ status: "idle", updatedAt: new Date() })
    .where(and(eq(agents.status, "pending_approval"), sql`${agents.id} = ANY(${ids})`))
    .returning({ id: agents.id });

  console.log(`\nFlipped ${result.length} agent(s) to status='idle'.`);
  process.exit(0);
}

void main();
