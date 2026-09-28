import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  AGENT_DEFAULT_MAX_IN_PROGRESS_ISSUES,
  evaluateAgentWipCap,
} from "@paperclipai/shared";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres per-agent in_progress WIP cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("evaluateAgentWipCap", () => {
  it("allows a claim strictly below the cap", () => {
    expect(evaluateAgentWipCap({ cap: 2, currentCount: 0 })).toEqual({ allowed: true });
    expect(evaluateAgentWipCap({ cap: 2, currentCount: 1 })).toEqual({ allowed: true });
  });

  it("refuses the claim that would reach the cap boundary, not the one past it", () => {
    // Off-by-one guard. `currentCount` excludes the issue being claimed, so the
    // third claim against a cap of 2 arrives here as `currentCount: 2` and must
    // be refused — not allowed on the reasoning that 2 < 2 is "under".
    expect(evaluateAgentWipCap({ cap: 2, currentCount: 2 })).toEqual({
      allowed: false,
      cap: 2,
      currentCount: 2,
      reason: "wip_cap_exceeded",
    });
  });

  it("treats a negative or non-numeric count as zero rather than a free pass", () => {
    expect(evaluateAgentWipCap({ cap: 2, currentCount: -5 })).toEqual({ allowed: true });
    expect(evaluateAgentWipCap({ cap: 2, currentCount: Number.NaN })).toEqual({
      allowed: true,
    });
  });
});

describeEmbeddedPostgres("per-agent in_progress claim ceiling", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-wip-cap-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, maxInProgressIssues?: number) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Cap agent ${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      // Absence of an explicit value is itself a case under test: the default
      // must hold for an agent nobody configured, which is all 21 agents on the
      // live instance today.
      runtimeConfig:
        maxInProgressIssues === undefined
          ? { heartbeat: { maxConcurrentRuns: 1 } }
          : { heartbeat: { maxConcurrentRuns: 1, maxInProgressIssues } },
      permissions: {},
    });
    return agentId;
  }

  async function seedTodoIssue(companyId: string, agentId: string, title: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return issueId;
  }

  async function seedInProgressIssue(companyId: string, agentId: string, title: string) {
    const issueId = await seedTodoIssue(companyId, agentId, title);
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    return issueId;
  }

  // `create` is a claim path in its own right: a caller can post an issue that
  // is already `in_progress`, which is a claim made at birth rather than a
  // transition. These cases exist because that path shipped with no cap check
  // while `update` and `importIssues` both had one, so a single POST could put
  // an agent over its cap even though the identical claim via PATCH was
  // refused. Proven live before the fix, not inferred: an at-cap agent
  // accepted a third `in_progress` issue through `create`, and dispatch bound a
  // run to it seconds later.
  describe("create() as a claim path", () => {
    it("refuses to create an issue already in progress on an agent at its cap", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, 2);
      await seedInProgressIssue(companyId, agentId, "claim 1");
      await seedInProgressIssue(companyId, agentId, "claim 2");

      await expect(
        svc.create(companyId, {
          title: "created already in progress",
          status: "in_progress",
          assigneeAgentId: agentId,
        }),
      ).rejects.toMatchObject({ status: 429 });

      // The refusal must leave nothing behind. A cap that rejects the write but
      // still persists the row would cap the API's answer and not the fleet.
      const rows = await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, companyId));
      expect(rows.filter((r) => r.title === "created already in progress")).toHaveLength(0);
    });

    it("still allows the create-time claim when the agent is under its cap", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, 2);
      await seedInProgressIssue(companyId, agentId, "claim 1");

      const created = await svc.create(companyId, {
        title: "second claim at create time",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      expect(created).toBeDefined();
      expect(created.status).toBe("in_progress");
    });

    it("counts per agent on the create path too", async () => {
      const companyId = await seedCompany();
      const capped = await seedAgent(companyId, 1);
      const other = await seedAgent(companyId, 1);
      await seedInProgressIssue(companyId, capped, "capped 1");

      await expect(
        svc.create(companyId, {
          title: "second claim for a capped agent",
          status: "in_progress",
          assigneeAgentId: capped,
        }),
      ).rejects.toMatchObject({ status: 429 });

      await expect(
        svc.create(companyId, {
          title: "claim for an uncapped agent",
          status: "in_progress",
          assigneeAgentId: other,
        }),
      ).resolves.toBeDefined();
    });

    it("does not consult the cap for a create that is not a claim", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, 1);
      await seedInProgressIssue(companyId, agentId, "claim 1");

      // Queuing work is not claiming it. If `create` refused a `todo` row for an
      // at-cap agent, the cap would stop the queue from being written at all and
      // would become a work-stop rather than a queue, which is the opposite of
      // the "requeue, do not drop" rule.
      for (const title of ["queued 1", "queued 2", "queued 3"]) {
        await expect(
          svc.create(companyId, { title, status: "todo", assigneeAgentId: agentId }),
        ).resolves.toBeDefined();
      }
    });

    it("holds the line when create and update race for the same slot", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, 1);
      const queued = await seedTodoIssue(companyId, agentId, "queued via update");

      // Whichever way the final claim is expressed, the agent must not end up
      // holding more than the cap. The count is taken inside the same
      // transaction as the insert on the create path, so a create cannot read a
      // pre-insert snapshot and then write past it.
      const results = await Promise.allSettled([
        svc.update(queued, { status: "in_progress" }),
        svc.create(companyId, {
          title: "racing create",
          status: "in_progress",
          assigneeAgentId: agentId,
        }),
      ]);
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);

      const rows = await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, companyId));
      const held = rows.filter((r) => r.status === "in_progress");
      expect(held.length).toBeLessThanOrEqual(1);
    });
  });

  it("refuses a third claim and leaves the issue queued rather than dropping it", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, 2);
    const a = await seedTodoIssue(companyId, agentId, "claim 1");
    const b = await seedTodoIssue(companyId, agentId, "claim 2");
    const c = await seedTodoIssue(companyId, agentId, "claim 3");

    await svc.update(a, { status: "in_progress" });
    await svc.update(b, { status: "in_progress" });

    await expect(svc.update(c, { status: "in_progress" })).rejects.toMatchObject({
      status: 429,
    });

    // The decisive assertion: a refused claim is still dispatch-eligible. If the
    // write had landed the issue in `blocked` the cap would have silently become
    // a work-stop, which is a different and much more damaging control.
    const rows = await db.select().from(issues).where(eq(issues.id, c));
    expect(rows[0]?.status).toBe("todo");
  });

  it("lets a slot free by landing a task, so the cap is a queue and not a wall", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, 2);
    const a = await seedTodoIssue(companyId, agentId, "claim 1");
    const b = await seedTodoIssue(companyId, agentId, "claim 2");
    const c = await seedTodoIssue(companyId, agentId, "claim 3");

    await svc.update(a, { status: "in_progress" });
    await svc.update(b, { status: "in_progress" });
    await expect(svc.update(c, { status: "in_progress" })).rejects.toMatchObject({
      status: 429,
    });

    await svc.update(a, { status: "done" });
    await expect(svc.update(c, { status: "in_progress" })).resolves.toBeDefined();

    const rows = await db.select().from(issues).where(eq(issues.id, c));
    expect(rows[0]?.status).toBe("in_progress");
  });

  it("counts per agent, so one agent at its cap cannot refuse another's claim", async () => {
    const companyId = await seedCompany();
    const capped = await seedAgent(companyId, 2);
    const other = await seedAgent(companyId, 2);
    const a = await seedTodoIssue(companyId, capped, "capped 1");
    const b = await seedTodoIssue(companyId, capped, "capped 2");
    const c = await seedTodoIssue(companyId, capped, "capped 3");
    const d = await seedTodoIssue(companyId, other, "other 1");

    await svc.update(a, { status: "in_progress" });
    await svc.update(b, { status: "in_progress" });
    await expect(svc.update(c, { status: "in_progress" })).rejects.toMatchObject({
      status: 429,
    });

    await expect(svc.update(d, { status: "in_progress" })).resolves.toBeDefined();
  });

  it("applies the honest default to an agent with no configured cap", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, undefined);
    const cap = AGENT_DEFAULT_MAX_IN_PROGRESS_ISSUES;
    const seeded: string[] = [];
    for (let i = 0; i < cap; i += 1) {
      seeded.push(await seedTodoIssue(companyId, agentId, `default claim ${i}`));
    }
    const overflow = await seedTodoIssue(companyId, agentId, "default overflow");

    for (const issueId of seeded) await svc.update(issueId, { status: "in_progress" });
    await expect(svc.update(overflow, { status: "in_progress" })).rejects.toMatchObject({
      status: 429,
    });
  });

  it("does not refuse an edit to an issue that is already in progress", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, 1);
    const held = await seedTodoIssue(companyId, agentId, "held at cap");

    await svc.update(held, { status: "in_progress" });

    // Editing an existing claim must not be judged as a new claim. If it were,
    // ordinary work on an agent that is legitimately at its cap becomes
    // impossible rather than merely capped, and the reconciler cannot even
    // relabel a phantom to undo it.
    await expect(svc.update(held, { priority: "high" })).resolves.toBeDefined();
    const rows = await db.select().from(issues).where(eq(issues.id, held));
    expect(rows[0]?.status).toBe("in_progress");
    expect(rows[0]?.priority).toBe("high");
  });

  it("refuses a claim that would move the issue onto an agent already at cap", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, 1);
    const held = await seedTodoIssue(companyId, agentId, "held at cap");
    const incoming = randomUUID();
    await db.insert(issues).values({
      id: incoming,
      companyId,
      title: "unassigned work",
      status: "todo",
      priority: "medium",
    });

    await svc.update(held, { status: "in_progress" });

    await expect(
      svc.update(incoming, { status: "in_progress", assigneeAgentId: agentId }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("honours a widened per-agent cap, so the default is not a hard ceiling", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, 4);
    const seeded: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      seeded.push(await seedTodoIssue(companyId, agentId, `wide claim ${i}`));
    }
    const overflow = await seedTodoIssue(companyId, agentId, "wide overflow");

    for (const issueId of seeded) await svc.update(issueId, { status: "in_progress" });
    await expect(svc.update(overflow, { status: "in_progress" })).rejects.toMatchObject({
      status: 429,
    });
    expect(AGENT_DEFAULT_MAX_IN_PROGRESS_ISSUES).toBe(2);
  });
});
