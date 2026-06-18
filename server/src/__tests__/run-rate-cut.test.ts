import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping run-rate-cut tests: ${support.reason ?? "embedded pg unsupported"}`);
}

d("run-rate-cut: skip-if-no-actionable-work", () => {
  let db!: ReturnType<typeof createDb>;
  let hb!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rrc-");
    db = createDb(tempDb.connectionString);
    hb = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    // TRUNCATE CASCADE clears companies + every table transitively FK-referencing it.
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    try { await (tempDb as { stop?: () => Promise<void> } | null)?.stop?.(); } catch { /* noop */ }
  });

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RRC",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  async function seedAgent(opts: { preserveIdleRuns?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `a-${id.slice(0, 4)}`,
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 1, preserveIdleRuns: opts.preserveIdleRuns ?? false },
      },
      permissions: {},
      lastHeartbeatAt: new Date(0),
    });
    return id;
  }

  async function seedIssue(agentId: string, status: string) {
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: `i-${status}`,
      status,
      assigneeAgentId: agentId,
    });
  }

  async function noWorkSkips(agentId: string): Promise<number> {
    const rows = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "no_actionable_work"),
        ),
      );
    return rows.length;
  }

  it("T3 — no assigned work -> skipped(no_actionable_work)", async () => {
    await seedCompany();
    const a = await seedAgent();
    await hb.tickTimers(new Date());
    expect(await noWorkSkips(a)).toBe(1);
  });

  it("T1 — assigned todo -> NOT skipped", async () => {
    await seedCompany();
    const a = await seedAgent();
    await seedIssue(a, "todo");
    await hb.tickTimers(new Date());
    expect(await noWorkSkips(a)).toBe(0);
  });

  it("T2 — in_progress (stranded) -> NOT skipped", async () => {
    await seedCompany();
    const a = await seedAgent();
    await seedIssue(a, "in_progress");
    await hb.tickTimers(new Date());
    expect(await noWorkSkips(a)).toBe(0);
  });

  it("T4 — only blocked -> skipped", async () => {
    await seedCompany();
    const a = await seedAgent();
    await seedIssue(a, "blocked");
    await hb.tickTimers(new Date());
    expect(await noWorkSkips(a)).toBe(1);
  });

  it("T5 — only done/cancelled -> skipped", async () => {
    await seedCompany();
    const a = await seedAgent();
    await seedIssue(a, "done");
    await seedIssue(a, "cancelled");
    await hb.tickTimers(new Date());
    expect(await noWorkSkips(a)).toBe(1);
  });

  it("T6 — preserveIdleRuns=true, no work -> NOT skipped (CEO exemption)", async () => {
    await seedCompany();
    const a = await seedAgent({ preserveIdleRuns: true });
    await hb.tickTimers(new Date());
    expect(await noWorkSkips(a)).toBe(0);
  });
});
