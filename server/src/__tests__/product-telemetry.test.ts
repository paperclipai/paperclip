import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agents, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { scopedTelemetryCompanyId, scopedTelemetryPerson } from "../telemetry-company-scope.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const calls = vi.hoisted(() => [] as Array<{ event: string; dims: Record<string, unknown>; companyId: string | undefined }>);
const people = vi.hoisted(() => [] as Array<{ event: string; person: unknown }>);

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>("@paperclipai/shared/telemetry");
  const record = (event: string) => (_client: unknown, dims: Record<string, unknown>) => {
    calls.push({ event, dims, companyId: scopedTelemetryCompanyId() });
    people.push({ event, person: scopedTelemetryPerson() ?? null });
  };
  return {
    ...actual,
    trackTaskCreated: record("task.created"),
    trackTaskCompleted: record("task.completed"),
    trackTaskBlocked: record("task.blocked"),
    trackPlanCreated: record("plan.created"),
    trackPlanApproved: record("plan.approved"),
    trackArtifactCreated: record("artifact.created"),
    trackModelConnected: record("model.connected"),
  };
});

import { issueService } from "../services/issues.ts";
import { documentService } from "../services/documents.ts";
import { workProductService } from "../services/work-products.ts";
import { aiConnectionService } from "../services/ai-connections.ts";
import { hasUnfinishedBlockers } from "../services/issue-dependency-wakeups.ts";
import { emitSystemTaskBlockedAfterCommit, taskBlockedReason, telemetryActorKind } from "../services/product-telemetry.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("product telemetry classification", () => {
  it("classifies the acting kind", () => {
    expect(telemetryActorKind({ agentId: "a", userId: "u" })).toBe("agent");
    expect(telemetryActorKind({ userId: "u" })).toBe("user");
    expect(telemetryActorKind({})).toBe("system");
  });

  it.each([
    [{ hasOpenBlockers: true, unblockDescriptor: { owner: "board" as const, action: "x" }, actorKind: "agent" as const }, "waiting_on_task"],
    [{ hasOpenBlockers: false, unblockDescriptor: { owner: "board" as const, action: "x" }, actorKind: "agent" as const }, "waiting_for_person"],
    [{ hasOpenBlockers: false, unblockDescriptor: { owner: { userId: "u" }, action: "x" }, actorKind: "agent" as const }, "waiting_for_person"],
    [{ hasOpenBlockers: false, unblockDescriptor: { owner: { agentId: "a" }, action: "x" }, actorKind: "user" as const }, "waiting_for_agent"],
    [{ hasOpenBlockers: false, unblockDescriptor: null, actorKind: "system" as const }, "needs_recovery"],
    [{ hasOpenBlockers: false, unblockDescriptor: null, actorKind: "user" as const }, "unspecified"],
  ])("maps %o to %s", (input, expected) => {
    expect(taskBlockedReason(input)).toBe(expected);
  });
});

describeEmbeddedPostgres("product telemetry emit sites", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;

  let home: string;

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-product-telemetry-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "product-telemetry-fixture");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-product-telemetry-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    calls.length = 0;
    people.length = 0;
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
  });

  async function seedIssue(values: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: `Task ${id.slice(0, 6)}`, status: "todo", priority: "medium", ...values });
    return id;
  }

  const sent = (event: string) => calls.filter((call) => call.event === event);

  it("emits task.created once per committed task in the company scope, with the creator kind", async () => {
    const parent = await issueService(db).create(companyId, { title: "Parent", createdByUserId: "user-1" });
    await issueService(db).create(companyId, { title: "Child", parentId: parent.id, createdByAgentId: agentId });
    await issueService(db).create(companyId, { title: "First task", createdByUserId: "user-1", originKind: "onboarding_first_task" });

    expect(sent("task.created")).toEqual([
      { event: "task.created", dims: { createdByKind: "user", isSubtask: false }, companyId },
      { event: "task.created", dims: { createdByKind: "agent", isSubtask: true }, companyId },
      { event: "task.created", dims: { createdByKind: "onboarding", isSubtask: false }, companyId },
    ]);
    expect(scopedTelemetryCompanyId()).toBeUndefined();
    expect(people.map((entry) => entry.person)).toEqual([
      { userId: "user-1", attributedVia: "task_creator" },
      { userId: "user-1", attributedVia: "task_assigner" },
      { userId: "user-1", attributedVia: "task_creator" },
    ]);
  });

  it("attributes agent-driven lifecycle events to the task's person on the direct path", async () => {
    const fromPerson = await seedIssue({ status: "in_progress", createdByUserId: "creator-1", responsibleUserId: "owner-1" });
    const fromOwner = await seedIssue({ status: "in_progress", responsibleUserId: "owner-1" });
    const unowned = await seedIssue({ status: "in_progress" });
    people.length = 0;
    await issueService(db).update(fromPerson, { status: "done", actorAgentId: agentId });
    await issueService(db).update(fromOwner, { status: "done", actorAgentId: agentId });
    await issueService(db).update(unowned, { status: "done", actorAgentId: agentId });

    expect(people).toEqual([
      { event: "task.completed", person: { userId: "creator-1", attributedVia: "task_creator" } },
      { event: "task.completed", person: { userId: "owner-1", attributedVia: "task_assigner" } },
      { event: "task.completed", person: null },
    ]);
  });

  it("emits nothing for a create whose transaction rolls back", async () => {
    await expect(db.transaction(async (tx) => {
      await issueService(tx as unknown as typeof db).create(companyId, { title: "Rolled back", createdByUserId: "user-1" }, tx);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(sent("task.created")).toEqual([]);
  });

  it("emits task.completed once per transition to done", async () => {
    const id = await seedIssue({ status: "in_progress" });
    await issueService(db).update(id, { status: "done", actorAgentId: agentId });
    await issueService(db).update(id, { status: "done", actorAgentId: agentId });
    await issueService(db).update(id, { status: "todo", actorUserId: "user-1" });
    await issueService(db).update(id, { status: "done" });

    expect(sent("task.completed").map((call) => [call.dims, call.companyId])).toEqual([
      [{ completedByKind: "agent", isSubtask: false }, companyId],
      [{ completedByKind: "system", isSubtask: false }, companyId],
    ]);
  });

  it("emits task.blocked with the blocking reason at the transition", async () => {
    const blocker = await seedIssue({ status: "todo" });
    const waiting = await seedIssue({ status: "todo" });
    const recovering = await seedIssue({ status: "in_progress" });
    const forPerson = await seedIssue({ status: "in_progress" });
    const cancelledBlocker = await seedIssue({ status: "cancelled" });
    const waitingOnCancelled = await seedIssue({ status: "todo" });
    await issueService(db).update(waiting, { status: "blocked", blockedByIssueIds: [blocker], actorAgentId: agentId });
    await issueService(db).update(recovering, { status: "blocked" });
    await issueService(db).update(forPerson, { status: "blocked", unblockDescriptor: { owner: "board", action: "Approve" }, actorAgentId: agentId });
    await issueService(db).update(forPerson, { status: "blocked", actorAgentId: agentId });
    await issueService(db).update(waitingOnCancelled, { status: "blocked", blockedByIssueIds: [cancelledBlocker], actorUserId: "user-1" });

    expect(sent("task.blocked").map((call) => call.dims)).toEqual([
      { blockedReason: "waiting_on_task", blockedByKind: "agent" },
      { blockedReason: "needs_recovery", blockedByKind: "system" },
      { blockedReason: "waiting_for_person", blockedByKind: "agent" },
      { blockedReason: "waiting_on_task", blockedByKind: "user" },
    ]);
  });

  it("emits a direct system block with the task's real blockers and unblock owner", async () => {
    const blocker = await seedIssue({ status: "cancelled" });
    const dependent = await seedIssue({ status: "blocked" });
    const ownerWait = await seedIssue({ status: "blocked", unblockDescriptor: { owner: { userId: "user-1" }, action: "Share access" } });
    const recovery = await seedIssue({ status: "blocked" });
    await issueService(db).update(dependent, { blockedByIssueIds: [blocker] });
    calls.length = 0;
    const load = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
    await db.transaction(async (tx) => {
      await emitSystemTaskBlockedAfterCommit(tx, await load(dependent), "in_progress");
      await emitSystemTaskBlockedAfterCommit(tx, await load(ownerWait), "todo");
      await emitSystemTaskBlockedAfterCommit(tx, await load(recovery), "in_progress");
      await emitSystemTaskBlockedAfterCommit(tx, await load(recovery), "blocked");
      expect(sent("task.blocked")).toEqual([]);
    });

    expect(sent("task.blocked").map((call) => [call.dims, call.companyId])).toEqual([
      [{ blockedReason: "waiting_on_task", blockedByKind: "system" }, companyId],
      [{ blockedReason: "waiting_for_person", blockedByKind: "system" }, companyId],
      [{ blockedReason: "needs_recovery", blockedByKind: "system" }, companyId],
    ]);
  });

  it("keeps the block write when the blocker read fails", async () => {
    const id = await seedIssue({ status: "in_progress" });
    await db.transaction(async (tx) => {
      await tx.update(issues).set({ status: "blocked" }).where(eq(issues.id, id));
      expect(await hasUnfinishedBlockers(tx, { companyId: "not-a-uuid", id })).toBe(false);
      await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, id));
    });
    expect((await db.select({ status: issues.status }).from(issues).where(eq(issues.id, id)))[0]?.status).toBe("blocked");
  });

  it("emits plan.created for the first plan revision only", async () => {
    const id = await seedIssue();
    const documents = documentService(db);
    const first = await documents.upsertIssueDocument({ issueId: id, key: "plan", format: "markdown", body: "1. Do it", createdByAgentId: agentId });
    await documents.upsertIssueDocument({ issueId: id, key: "plan", format: "markdown", body: "1. Do it well",
      baseRevisionId: first.document.latestRevisionId, createdByAgentId: agentId });
    await documents.upsertIssueDocument({ issueId: id, key: "notes", format: "markdown", body: "Not a plan", createdByUserId: "user-1" });

    expect(sent("plan.created")).toEqual([
      { event: "plan.created", dims: { createdByKind: "agent", atTaskCreation: false }, companyId },
    ]);
  });

  it("emits artifact.created with the work product type and provider", async () => {
    const id = await seedIssue();
    await workProductService(db).createForIssue(id, companyId, {
      type: "pull_request", provider: "github", title: "Fix", status: "open", url: "https://example.invalid/pr/1",
    });
    await workProductService(db).createForIssue(id, companyId, {
      type: "preview_url", provider: "acme-private-deploys", title: "Preview", status: "active",
    });
    expect(sent("artifact.created")).toEqual([
      { event: "artifact.created", dims: { artifactType: "pull_request", provider: "github", creationFlow: "direct" }, companyId },
      { event: "artifact.created", dims: { artifactType: "preview_url", provider: "custom", creationFlow: "direct" }, companyId },
    ]);
    expect(JSON.stringify(sent("artifact.created"))).not.toContain("acme");
    expect(people.filter((entry) => entry.event === "artifact.created").map((entry) => entry.person)).toEqual([null, null]);
    const owned = await seedIssue({ createdByUserId: "creator-1" });
    people.length = 0;
    await workProductService(db).createForIssue(owned, companyId, { type: "branch", provider: "github", title: "Branch", status: "active" });
    expect(people).toEqual([{ event: "artifact.created", person: { userId: "creator-1", attributedVia: "task_creator" } }]);
  });

  it("emits model.connected for a new model connection and not for its reconnect", async () => {
    await db.insert(companyMemberships).values({ companyId, principalId: "alice", principalType: "user", status: "active", membershipRole: "member" });
    const service = aiConnectionService(db);
    const first = await service.save(companyId, "alice", { provider: "anthropic", method: "api_key", ownership: "personal", name: "Alice key",
      apiKey: "fixture-key", agentIds: [], allAgents: true }, "fixture-key");
    await service.save(companyId, "alice", { provider: "openrouter", method: "api_key", ownership: "shared", name: "Shared router",
      apiKey: "fixture-router", agentIds: [], allAgents: true, routing: { kind: "openrouter", protocol: "chat", auth: "bearer", models: [] } }, "fixture-router");
    await service.save(companyId, "alice", { provider: "anthropic", method: "api_key", ownership: "personal", name: "Alice key",
      apiKey: "fixture-key-2", agentIds: [], allAgents: true, connectionId: first.connectionId }, "fixture-key-2");

    expect(sent("model.connected")).toEqual([
      { event: "model.connected", dims: { provider: "anthropic", connectionMethod: "api_key", ownership: "personal", routingKind: null, firstForCompany: true }, companyId },
      { event: "model.connected", dims: { provider: "openrouter", connectionMethod: "api_key", ownership: "shared", routingKind: "openrouter", firstForCompany: false }, companyId },
    ]);
    expect(JSON.stringify(sent("model.connected"))).not.toContain("Alice");
  });
});
