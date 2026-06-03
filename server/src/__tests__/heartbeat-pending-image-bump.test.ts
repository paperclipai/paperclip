// BLO-4141: Integration test for the agent-image-bump hook in setRunStatus.
//
// setRunStatus is a private function inside heartbeat.ts, so we exercise it
// via the public service.cancelRun(runId) entry point — which internally
// transitions the run to "cancelled" (a terminal status) and triggers the
// hook. The hook is fire-and-forget (void ...catch(...)), so assertions
// wait for the pending_image_bump column to clear via vi.waitFor.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat-pending-image-bump tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat setRunStatus → processPendingImageBumpForAgent hook", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-pending-image-bump-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(opts: {
    image: string;
    pendingImageBump: string | null;
    runStatus: "queued" | "running";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `BP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "PendingBumpTest Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PendingBumpTestAgent",
      adapterType: "claude_k8s",
      adapterConfig: { image: opts.image, model: "claude-opus" },
      runtimeConfig: {},
      permissions: {},
      pendingImageBump: opts.pendingImageBump,
    });

    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: opts.runStatus,
      })
      .returning();

    return { companyId, agentId, run: run! };
  }

  async function getAgent(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return row;
  }

  it("PATCHes adapter_config.image and clears pending when run terminates via cancelRun", async () => {
    const { agentId, run } = await seedFixture({
      image: "harbor.example/a:old",
      pendingImageBump: "harbor.example/a:new",
      runStatus: "running",
    });

    await heartbeat.cancelRun(run.id);

    // Hook is fire-and-forget; wait for the column to clear.
    await vi.waitFor(
      async () => {
        const refetched = await getAgent(agentId);
        expect((refetched!.adapterConfig as Record<string, unknown>).image).toBe(
          "harbor.example/a:new",
        );
        expect(refetched!.pendingImageBump).toBeNull();
      },
      { timeout: 3_000, interval: 50 },
    );
  });

  it("does nothing when pending_image_bump is unset", async () => {
    const { agentId, run } = await seedFixture({
      image: "harbor.example/a:old",
      pendingImageBump: null,
      runStatus: "running",
    });

    await heartbeat.cancelRun(run.id);

    // Give the async hook a beat to run (or no-op). After 250ms, both fields
    // should still match the pre-cancel state.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const refetched = await getAgent(agentId);
    expect((refetched!.adapterConfig as Record<string, unknown>).image).toBe(
      "harbor.example/a:old",
    );
    expect(refetched!.pendingImageBump).toBeNull();
  });

  it("applies a deferred bump when a run terminates even though a QUEUED sibling remains (deadlock break)", async () => {
    // BLO-8746/BLO-8827 end-to-end: a maxConcurrentRuns=1 agent with a queued
    // backlog used to starve its pending image bump forever, because the old
    // gate counted queued runs as "in flight". With the fix, terminating the
    // running run applies the bump even though a queued sibling remains.
    // skipQueuedRunDispatch keeps the cancel path from spawning a real
    // executeRun whose async chain would race afterEach's TRUNCATE.
    const skipDispatchHeartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `BK${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "BacklogBumpTest Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "BacklogBumpAgent",
      adapterType: "claude_k8s",
      adapterConfig: { image: "harbor.example/a:old", model: "claude-opus" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
      pendingImageBump: "harbor.example/a:new",
    });
    const [runningRun] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "running" })
      .returning();
    // The backlog: a queued sibling that previously pinned the agent "in flight".
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued" });

    await skipDispatchHeartbeat.cancelRun(runningRun!.id);

    await vi.waitFor(
      async () => {
        const refetched = await getAgent(agentId);
        expect((refetched!.adapterConfig as Record<string, unknown>).image).toBe(
          "harbor.example/a:new",
        );
        expect(refetched!.pendingImageBump).toBeNull();
      },
      { timeout: 3_000, interval: 50 },
    );
  });

  // Non-terminal-transition test is exercised indirectly: the public
  // heartbeat service has no entry point that transitions queued → running
  // synchronously (running is set inside the executeRun pipeline), so this
  // case is covered by inspection of the hook source (only fires inside the
  // `if (TERMINAL_RUN_STATUSES.has(updated.status))` guard) plus the
  // applyImageBumpToAgent + processPendingImageBumpForAgent unit tests in
  // agent-image-bump.test.ts.
});
