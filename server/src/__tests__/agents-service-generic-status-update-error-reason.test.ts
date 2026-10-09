import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service generic status update — errorReason invariant", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-generic-status-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    overrides: Partial<typeof agents.$inferInsert> = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent-${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      ...overrides,
    });
    return agentId;
  }

  it("clears a stale errorReason when a generic update moves status out of error", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, {
      status: "error",
      errorReason: "Adapter exited with code 1",
    });

    const updated = await agentService(db).update(agentId, { status: "idle" });

    expect(updated).toMatchObject({ id: agentId, status: "idle", errorReason: null });
  });

  it("cleans an already-idle record when a caller explicitly PATCHes status=idle again", async () => {
    const companyId = await seedCompany();
    // Simulates a record left over from before this invariant was enforced:
    // status is already idle, but a diagnostic errorReason is still persisted.
    const agentId = await seedAgent(companyId, {
      status: "idle",
      errorReason: "stale diagnostic from a prior incident",
    });

    const updated = await agentService(db).update(agentId, { status: "idle" });

    expect(updated).toMatchObject({ id: agentId, status: "idle", errorReason: null });
  });

  it("does not touch errorReason when the patch leaves status untouched", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, {
      status: "error",
      errorReason: "Adapter exited with code 1",
    });

    const updated = await agentService(db).update(agentId, { title: "Renamed" });

    expect(updated).toMatchObject({
      id: agentId,
      status: "error",
      errorReason: "Adapter exited with code 1",
      title: "Renamed",
    });
  });

  it("preserves an explicit errorReason when status is set to error", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { status: "idle" });

    const updated = await agentService(db).update(agentId, {
      status: "error",
      errorReason: "Secret is not bound to agent at env.ANTHROPIC_API_KEY",
    });

    expect(updated).toMatchObject({
      id: agentId,
      status: "error",
      errorReason: "Secret is not bound to agent at env.ANTHROPIC_API_KEY",
    });
  });

  it("overrides a caller-supplied errorReason when the same patch moves status away from error", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, {
      status: "error",
      errorReason: "Adapter exited with code 1",
    });

    // A caller that sets status away from error while also (incorrectly) supplying
    // an errorReason must not be able to leave a stale reason on a non-error agent.
    const updated = await agentService(db).update(agentId, {
      status: "paused",
      errorReason: "should not persist",
    });

    expect(updated).toMatchObject({ id: agentId, status: "paused", errorReason: null });
  });

  it("still rejects status changes on terminated agents", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { status: "terminated" });

    await expect(agentService(db).update(agentId, { status: "idle" })).rejects.toMatchObject({
      status: 409,
      message: "Terminated agents cannot be resumed",
    });
  });

  it("still rejects direct activation of pending_approval agents", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { status: "pending_approval" });

    await expect(agentService(db).update(agentId, { status: "idle" })).rejects.toMatchObject({
      status: 409,
      message: "Pending approval agents cannot be activated directly",
    });
  });
});
