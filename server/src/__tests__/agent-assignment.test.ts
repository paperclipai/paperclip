import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import type { AiConnectionUsage } from "@paperclipai/shared";
import { agentAssignmentService, quotaSignal, type ProbeAgentUsage } from "../services/agent-assignment.js";
import type { AuthorizationActor } from "../services/authorization.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-assignment-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "assignment-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-assignment-db-");
  db = createDb(database.connectionString);
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

const usage = (limits: Array<Partial<AiConnectionUsage["limits"][number]>>, status: AiConnectionUsage["status"] = "ok"): AiConnectionUsage => ({
  connectionId: randomUUID(), grantId: randomUUID(), provider: "openai", method: "subscription", status, checkedAt: new Date().toISOString(),
  source: "test", planType: "plus", overage: null,
  limits: limits.map((limit, index) => ({ id: `w${index}`, label: `window ${index}`, scope: null, windowDurationSeconds: 18000, resetsAt: null,
    usedPercent: null, remainingPercent: null, used: null, limit: null, remaining: null, unit: null, limitReached: null, allowed: null, ...limit })),
});

const subscription = { provider: "openai", method: "subscription", mode: "responsible_user" };
const apiKey = { provider: "openai", method: "api_key", mode: "responsible_user" };

let sequence = 0;
async function fixture() {
  const companyId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Assignment tests", issuePrefix: `AA${++sequence}` });
  await db.insert(companyMemberships).values({ companyId, principalId: "alice", principalType: "user", status: "active", membershipRole: "owner" });
  const actor = { type: "board", userId: "alice", source: "session", companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }] } as unknown as AuthorizationActor;
  const addAgent = async (name: string, runtimeConfig: Record<string, unknown>, extra: Partial<typeof agents.$inferInsert> = {}) => {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name, adapterType: "codex_local", runtimeConfig, ...extra });
    return id;
  };
  const addIssue = async (extra: Partial<typeof issues.$inferInsert> = {}) => {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: "Write release notes", status: "todo", priority: "medium", responsibleUserId: "alice", ...extra });
    return id;
  };
  const usageByAgent = new Map<string, AiConnectionUsage | null>();
  const probeUsage: ProbeAgentUsage = async ({ agent }) => usageByAgent.get(agent.id) ?? null;
  const wakeup = vi.fn().mockResolvedValue(undefined);
  const service = agentAssignmentService(db, { probeUsage, wakeup });
  const assign = (issueId: string, request: { strategy?: "balanced" | "cost" | "quality" | "speed"; requiredCapabilities?: string[] } = {}) =>
    service.autoAssign({ issueId, actor, userId: "alice", activityActor: { actorType: "user", actorId: "alice" },
      request: { strategy: request.strategy ?? "balanced", requiredCapabilities: request.requiredCapabilities ?? [] } });
  const load = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0];
  return { companyId, actor, addAgent, addIssue, usageByAgent, service, assign, load, wakeup };
}

describe("automatic agent assignment", () => {
  it("filters candidates, explains every exclusion, assigns the best agent, and wakes it", async () => {
    const f = await fixture();
    const coder = await f.addAgent("Coder", { aiConnection: subscription, autoAssignment: { enabled: true, capabilities: ["code"], quality: 4 } });
    const writer = await f.addAgent("Writer", { aiConnection: subscription, autoAssignment: { enabled: true, capabilities: ["docs"], quality: 5 } });
    await f.addAgent("Manual only", { aiConnection: subscription });
    await f.addAgent("Paused", { autoAssignment: { enabled: true, capabilities: ["code"] } }, { status: "paused" });
    const issueId = await f.addIssue();
    const routing = await f.assign(issueId, { requiredCapabilities: ["code"] });
    expect(routing).toMatchObject({ mode: "auto", status: "assigned", selectedAgentId: coder, fallback: null });
    const byName = Object.fromEntries(routing.candidates.map((candidate) => [candidate.name, candidate]));
    expect(byName.Coder).toMatchObject({ eligible: true, rank: 1 });
    expect(byName.Writer.excludedReasons).toEqual(["Missing capabilities: code"]);
    expect(byName["Manual only"].excludedReasons).toContain("Not opted in to automatic assignment");
    expect(byName.Paused.excludedReasons).toContain("Paused");
    expect(byName.Coder.scores?.quota).toMatchObject({ source: "unknown", value: 0.5 });
    const issue = await f.load(issueId);
    expect(issue).toMatchObject({ assigneeAgentId: coder, statusVersion: 1 });
    expect(issue.assignmentRouting).toMatchObject({ selectedAgentId: coder });
    expect(f.wakeup).toHaveBeenCalledWith(coder, expect.objectContaining({ source: "assignment", reason: "issue_assigned" }));
    const [activity] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.auto_assigned")));
    expect(activity.details).toMatchObject({ selectedAgentId: coder, strategy: "balanced" });
    expect(writer).toBeTruthy();
  });

  it("weighs cost, quality, quota, and load by strategy", async () => {
    const f = await fixture();
    const cheap = await f.addAgent("Subscription", { aiConnection: subscription, autoAssignment: { enabled: true, capabilities: [], quality: 2 } });
    const strong = await f.addAgent("API", { aiConnection: apiKey, autoAssignment: { enabled: true, capabilities: [], quality: 5 } });
    expect((await f.assign(await f.addIssue(), { strategy: "cost" })).selectedAgentId).toBe(cheap);
    expect((await f.assign(await f.addIssue(), { strategy: "quality" })).selectedAgentId).toBe(strong);
    f.usageByAgent.set(cheap, usage([{ remainingPercent: 3 }]));
    f.usageByAgent.set(strong, usage([{ remainingPercent: 90 }]));
    expect((await f.assign(await f.addIssue(), { strategy: "balanced" })).selectedAgentId).toBe(strong);
    f.usageByAgent.clear();
    for (let i = 0; i < 15; i += 1) {
      await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId, agentId: cheap, status: "running", invocationSource: "on_demand", contextSnapshot: {} });
    }
    expect((await f.assign(await f.addIssue(), { strategy: "speed" })).selectedAgentId).toBe(strong);
  });

  it("excludes exhausted accounts and records an unavailable result without assigning", async () => {
    const f = await fixture();
    const only = await f.addAgent("Only", { aiConnection: subscription, autoAssignment: { enabled: true, capabilities: [] } });
    f.usageByAgent.set(only, usage([{ usedPercent: 100, limitReached: true, resetsAt: "2026-11-17T05:00:00.000Z" }]));
    const issueId = await f.addIssue();
    const routing = await f.assign(issueId);
    expect(routing).toMatchObject({ status: "no_candidate", selectedAgentId: null });
    expect(routing.candidates[0].excludedReasons).toEqual(["window 0 is used up until 2026-11-17T05:00:00.000Z"]);
    expect(await f.load(issueId)).toMatchObject({ assigneeAgentId: null, assignmentRouting: { status: "no_candidate" } });
    expect(f.wakeup).not.toHaveBeenCalled();
  });

  it("does not bypass assignment policy", async () => {
    const f = await fixture();
    await f.addAgent("Protected", { autoAssignment: { enabled: true, capabilities: [] } },
      { permissions: { authorizationPolicy: { protectedAgent: { blockAssignment: true, blockReason: "Reserved" } } } });
    const routing = await f.assign(await f.addIssue());
    expect(routing.status).toBe("no_candidate");
    expect(routing.candidates[0].excludedReasons[0]).toMatch(/^Not permitted/);
  });

  it("never moves assigned or running work, and lets one of two concurrent requests win", async () => {
    const f = await fixture();
    const one = await f.addAgent("One", { autoAssignment: { enabled: true, capabilities: [] } });
    await f.addAgent("Two", { autoAssignment: { enabled: true, capabilities: [] } });
    await expect(f.assign(await f.addIssue({ assigneeAgentId: one }))).rejects.toThrow(/without an assignee/);
    await expect(f.assign(await f.addIssue({ status: "in_progress" }))).rejects.toThrow(/does not apply/);
    const issueId = await f.addIssue();
    const results = await Promise.allSettled([f.assign(issueId), f.assign(issueId)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await f.load(issueId)).statusVersion).toBe(1);
  });

  it("moves an auto-assigned task once when its agent is out of allowance before any work", async () => {
    const f = await fixture();
    const first = await f.addAgent("First", { autoAssignment: { enabled: true, capabilities: [], quality: 5 } });
    const second = await f.addAgent("Second", { autoAssignment: { enabled: true, capabilities: [], quality: 1 } });
    const issueId = await f.addIssue();
    expect((await f.assign(issueId, { strategy: "quality" })).selectedAgentId).toBe(first);
    const target = { companyId: f.companyId, issueId, agentId: first };
    expect(await f.service.fallbackEligible(target)).toBe(true);
    expect(await f.service.fallbackFromProviderLimit({ ...target, resetAt: "2026-11-17T05:00:00.000Z" })).toBe(true);
    const moved = await f.load(issueId);
    expect(moved).toMatchObject({ assigneeAgentId: second,
      assignmentRouting: { selectedAgentId: second, fallback: { fromAgentId: first, reason: "Usage limit until 2026-11-17T05:00:00.000Z" } } });
    expect(await f.service.fallbackEligible({ ...target, agentId: second })).toBe(false);
    const manual = await f.addIssue({ assigneeAgentId: first });
    expect(await f.service.fallbackEligible({ ...target, issueId: manual })).toBe(false);
  });
});

describe("quota signal", () => {
  it("uses the smallest reported remaining share and never invents one", () => {
    expect(quotaSignal(null).score).toMatchObject({ value: 0.5, source: "unknown" });
    expect(quotaSignal(usage([], "unsupported")).score.source).toBe("unknown");
    expect(quotaSignal(usage([{ remainingPercent: 80 }, { usedPercent: 70 }])).score).toMatchObject({ value: 0.3, source: "observed" });
    expect(quotaSignal(usage([{ remaining: 0, limit: 10 }])).exhausted).toMatch(/used up/);
  });
});
