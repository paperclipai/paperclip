import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { selectEligibleAgentsForImageBump, isAgentExecuting, applyImageBumpToAgent, bumpAgentImagesForCompany, processPendingImageBumpForAgent } from "../services/agent-image-bump.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-image-bump tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("selectEligibleAgentsForImageBump", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-image-bump-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns only eligible agents that have an image different from targetImage", async () => {
    const companyId = randomUUID();
    const oldImage = "ghcr.io/paperclip/agent:sha-aabbccdd";
    const newImage = "ghcr.io/paperclip/agent:sha-11223344";

    await db.insert(companies).values({
      id: companyId,
      name: "BumpTest Co",
      issuePrefix: `BT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const [eligibleClaudeAgent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "EligibleClaudeAgent",
        adapterType: "claude_k8s",
        adapterConfig: { image: oldImage },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    const [eligibleOpencodeAgent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "EligibleOpencodeAgent",
        adapterType: "opencode_k8s",
        adapterConfig: { image: oldImage },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    const [alreadyOnTarget] = await db
      .insert(agents)
      .values({
        companyId,
        name: "AlreadyOnTarget",
        adapterType: "claude_k8s",
        adapterConfig: { image: newImage },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    const [noImageSet] = await db
      .insert(agents)
      .values({
        companyId,
        name: "NoImageSet",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    const [wrongAdapter] = await db
      .insert(agents)
      .values({
        companyId,
        name: "WrongAdapter",
        adapterType: "chatjimmy",
        adapterConfig: { image: oldImage },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    const result = await selectEligibleAgentsForImageBump(db, {
      companyId,
      targetImage: newImage,
    });

    const resultIds = result.map((a) => a.id).sort();

    expect(resultIds).toEqual(
      [eligibleClaudeAgent!.id, eligibleOpencodeAgent!.id].sort(),
    );

    const excludedIds = [alreadyOnTarget!.id, noImageSet!.id, wrongAdapter!.id];
    for (const excludedId of excludedIds) {
      expect(resultIds).not.toContain(excludedId);
    }
  });
});

describeEmbeddedPostgres("isAgentExecuting", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-in-flight-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createTestAgent(db: ReturnType<typeof createDb>) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "InFlightTest Co",
      issuePrefix: `IF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "InFlightTestAgent",
        adapterType: "claude_k8s",
        adapterConfig: { image: "harbor.example/a:old" },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    return { companyId, agent: agent! };
  }

  it("returns true when agent has a running heartbeat run", async () => {
    const { companyId, agent } = await createTestAgent(db);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent.id,
      status: "running",
    });
    await expect(isAgentExecuting(db, agent.id)).resolves.toBe(true);
  });

  it("returns false when agent only has a queued heartbeat run", async () => {
    // BLO-8746/BLO-8827: queued runs are NOT active execution. A queued
    // backlog must not be treated as "in flight", otherwise a pending image
    // bump on a perpetually-backlogged maxConcurrentRuns=1 agent never applies.
    const { companyId, agent } = await createTestAgent(db);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent.id,
      status: "queued",
    });
    await expect(isAgentExecuting(db, agent.id)).resolves.toBe(false);
  });

  it("returns false when agent only has terminal runs", async () => {
    const { companyId, agent } = await createTestAgent(db);
    await db.insert(heartbeatRuns).values([
      { companyId, agentId: agent.id, status: "succeeded" },
      { companyId, agentId: agent.id, status: "failed" },
    ]);
    await expect(isAgentExecuting(db, agent.id)).resolves.toBe(false);
  });

  it("returns false when agent has no heartbeat runs and k8s client unavailable", async () => {
    // Exercises the k8s-confirm fallback path: zero DB rows means we fall
    // through to hasActiveJobForAgent, which in the test environment (no
    // KUBERNETES_SERVICE_HOST) returns false. Together: false || false === false.
    // This guards against regressions in the AGENT_ID_LABEL constant — if it
    // ever stops matching prod label names, the k8s lookup silently returns
    // no Jobs, and this test stays green. The real guard is integration:
    // production verification that the label string matches kubectl output.
    const { agent } = await createTestAgent(db);
    await expect(isAgentExecuting(db, agent.id)).resolves.toBe(false);
  });
});

describeEmbeddedPostgres("applyImageBumpToAgent", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apply-image-bump-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompanyAndAgent(opts: {
    image: string;
    extraConfig?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "ApplyBumpTest Co",
      issuePrefix: `AB${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "ApplyBumpTestAgent",
        adapterType: "claude_k8s",
        adapterConfig: { image: opts.image, ...(opts.extraConfig ?? {}) },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    return { companyId, agent: agent! };
  }

  it("PATCHes the image immediately when the agent is idle", async () => {
    const { agent } = await createCompanyAndAgent({
      image: "harbor.example/a:old",
      extraConfig: { model: "claude-opus" },
    });

    const result = await applyImageBumpToAgent(db, {
      agentId: agent.id,
      targetImage: "harbor.example/a:new",
      source: "ci:test",
    });

    expect(result).toEqual({ outcome: "bumped", agentId: agent.id });

    const [refetched] = await db.select().from(agents).where(eq(agents.id, agent.id));
    const cfg = refetched!.adapterConfig as Record<string, unknown>;
    expect(cfg.image).toBe("harbor.example/a:new");
    expect(cfg.model).toBe("claude-opus"); // siblings preserved
    expect(refetched!.pendingImageBump).toBeNull();
  });

  it("sets pending_image_bump and skips PATCH when the agent is in-flight", async () => {
    const { companyId, agent } = await createCompanyAndAgent({ image: "harbor.example/a:old" });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent.id,
      status: "running",
    });

    const result = await applyImageBumpToAgent(db, {
      agentId: agent.id,
      targetImage: "harbor.example/a:new",
      source: "ci:test",
    });

    expect(result).toEqual({ outcome: "skipped", agentId: agent.id });

    const [refetched] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect((refetched!.adapterConfig as Record<string, unknown>).image).toBe(
      "harbor.example/a:old",
    );
    expect(refetched!.pendingImageBump).toBe("harbor.example/a:new");
  });

  it("overwrites a stale pending_image_bump with the newer target", async () => {
    const { companyId, agent } = await createCompanyAndAgent({ image: "harbor.example/a:old" });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent.id,
      status: "running",
    });

    await applyImageBumpToAgent(db, {
      agentId: agent.id,
      targetImage: "harbor.example/a:X",
      source: "ci:first",
    });
    await applyImageBumpToAgent(db, {
      agentId: agent.id,
      targetImage: "harbor.example/a:Y",
      source: "ci:second",
    });

    const [refetched] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(refetched!.pendingImageBump).toBe("harbor.example/a:Y");
  });
});

describeEmbeddedPostgres("bumpAgentImagesForCompany", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bump-company-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns {bumped, skipped, unchanged} for a mixed agent fleet", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "BatchBumpTest Co",
      issuePrefix: `BB${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    // idleEligible: claude_k8s, old image, no in-flight runs -> should be bumped
    const [idleEligible] = await db
      .insert(agents)
      .values({
        companyId,
        name: "IdleEligible",
        adapterType: "claude_k8s",
        adapterConfig: { image: "harbor.example/a:old" },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    // busyEligible: opencode_k8s, old image, has a running heartbeat_run -> should be skipped
    const [busyEligible] = await db
      .insert(agents)
      .values({
        companyId,
        name: "BusyEligible",
        adapterType: "opencode_k8s",
        adapterConfig: { image: "harbor.example/a:old" },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: busyEligible!.id,
      status: "running",
    });

    // alreadyOnTarget: claude_k8s, already at new image -> should be unchanged
    const [alreadyOnTarget] = await db
      .insert(agents)
      .values({
        companyId,
        name: "AlreadyOnTarget",
        adapterType: "claude_k8s",
        adapterConfig: { image: "harbor.example/a:new" },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    const summary = await bumpAgentImagesForCompany(db, {
      companyId,
      targetImage: "harbor.example/a:new",
      source: "ci:test-batch",
    });

    expect(summary.bumped).toContain(idleEligible!.id);
    expect(summary.skipped).toContain(busyEligible!.id);
    expect(summary.unchanged).toContain(alreadyOnTarget!.id);
    expect(summary.bumped).not.toContain(busyEligible!.id);
    expect(summary.bumped).not.toContain(alreadyOnTarget!.id);
    expect(summary.skipped).not.toContain(idleEligible!.id);
    expect(summary.unchanged).not.toContain(idleEligible!.id);
  });
});

describeEmbeddedPostgres("processPendingImageBumpForAgent", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-process-pending-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompanyAndAgent(opts: {
    image: string;
    pending?: string | null;
  }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "ProcessPendingTest Co",
      issuePrefix: `PP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "ProcessPendingTestAgent",
        adapterType: "claude_k8s",
        adapterConfig: { image: opts.image },
        runtimeConfig: {},
        permissions: {},
        pendingImageBump: opts.pending ?? null,
      })
      .returning();
    return { companyId, agent: agent! };
  }

  it("PATCHes and clears pending_image_bump when agent is now idle", async () => {
    const { agent } = await createCompanyAndAgent({
      image: "harbor.example/a:old",
      pending: "harbor.example/a:new",
    });

    await processPendingImageBumpForAgent(db, agent.id);

    const [refetched] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect((refetched!.adapterConfig as Record<string, unknown>).image).toBe(
      "harbor.example/a:new",
    );
    expect(refetched!.pendingImageBump).toBeNull();
  });

  it("is a no-op when pending_image_bump is unset", async () => {
    const { agent } = await createCompanyAndAgent({
      image: "harbor.example/a:old",
      pending: null,
    });

    await processPendingImageBumpForAgent(db, agent.id);

    const [refetched] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect((refetched!.adapterConfig as Record<string, unknown>).image).toBe(
      "harbor.example/a:old",
    );
    expect(refetched!.pendingImageBump).toBeNull();
  });

  it("applies the pending bump when the agent only has QUEUED runs (no active execution)", async () => {
    // BLO-8746/BLO-8827: a queued backlog must NOT starve a pending image bump.
    // A maxConcurrentRuns=1 agent under steady automation is perpetually
    // backlogged; if queued runs gate the bump it never applies and the agent
    // is pinned to a stale (possibly broken) image forever. Only an actively
    // executing run (a live k8s Job) should defer the bump.
    const { companyId, agent } = await createCompanyAndAgent({
      image: "harbor.example/a:old",
      pending: "harbor.example/a:new",
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent.id,
      status: "queued",
    });

    await processPendingImageBumpForAgent(db, agent.id);

    const [refetched] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect((refetched!.adapterConfig as Record<string, unknown>).image).toBe(
      "harbor.example/a:new",
    );
    expect(refetched!.pendingImageBump).toBeNull();
  });

  it("keeps pending_image_bump set while a run is actively RUNNING (self-healing)", async () => {
    const { companyId, agent } = await createCompanyAndAgent({
      image: "harbor.example/a:old",
      pending: "harbor.example/a:new",
    });
    // A run that is actively executing (running, not merely queued) must still
    // defer the bump — it gets retried on the next terminal transition / next
    // idle dispatch.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent.id,
      status: "running",
    });

    await processPendingImageBumpForAgent(db, agent.id);

    const [refetched] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect((refetched!.adapterConfig as Record<string, unknown>).image).toBe(
      "harbor.example/a:old",
    );
    expect(refetched!.pendingImageBump).toBe("harbor.example/a:new");
  });
});
