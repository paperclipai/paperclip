import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat idle-skip tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat idle-skip", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-idle-skip-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE issues, heartbeat_run_events, heartbeat_runs, agent_task_sessions, agent_wakeup_requests, agent_runtime_state, agents, companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(opts: { skipWhenIdle: boolean; intervalSec?: number }) {
    const companyId = randomUUID();
    const agentId = randomUUID();

    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      slug: `test-${companyId.slice(0, 8)}`,
      issuePrefix,
    });

    const pastDate = new Date(Date.now() - 600_000);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "test-agent",
      adapterType: "claude_local",
      status: "idle",
      lastHeartbeatAt: pastDate,
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: opts.intervalSec ?? 60,
          skipWhenIdle: opts.skipWhenIdle,
        },
      },
    });

    return { companyId, agentId };
  }

  async function seedIssue(companyId: string, agentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: "todo",
      assigneeAgentId: agentId,
    });
    return issueId;
  }

  it("skips timer wake when skipWhenIdle is true and no open issues", async () => {
    const { agentId } = await seedAgent({ skipWhenIdle: true });
    const svc = heartbeatService(db);
    const result = await svc.tickTimers(new Date());

    expect(result.checked).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(new Date(agent.lastHeartbeatAt!).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("fires timer wake when skipWhenIdle is true and open issues exist", async () => {
    const { companyId, agentId } = await seedAgent({ skipWhenIdle: true });
    await seedIssue(companyId, agentId);
    const svc = heartbeatService(db);
    const result = await svc.tickTimers(new Date());

    expect(result.checked).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("fires timer wake when skipWhenIdle is false regardless of issue count", async () => {
    await seedAgent({ skipWhenIdle: false });
    const svc = heartbeatService(db);
    const result = await svc.tickTimers(new Date());

    expect(result.checked).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(0);
  });
});
