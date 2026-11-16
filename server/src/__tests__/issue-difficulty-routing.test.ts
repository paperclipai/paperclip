import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { activityLog, agents, companies, companyMemberships, createDb, decisionInvocations, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import type { DifficultyRoutingConfig } from "@paperclipai/shared";
import { aiConnectionService } from "../services/ai-connections.js";
import { decisionModelService } from "../services/decision-models.js";
import { decisionReceipt, type DecisionProviderOutcome } from "../services/decision-model-provider.js";
import { buildDifficultyRequest, resolveIssueDifficultyRouting, withDifficultyRoutingOverrides } from "../services/heartbeat/difficulty-routing.js";
import type { AgentCliClassify } from "../services/heartbeat/difficulty-classifiers.js";
import { issueDifficultyRoutingRoutes } from "../routes/issue-difficulty-routing.js";
import { errorHandler } from "../middleware/index.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-difficulty-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "difficulty-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-difficulty-db-");
  db = createDb(database.connectionString);
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

const routingConfig: DifficultyRoutingConfig = {
  enabled: true,
  tiers: { L1: { model: "gpt-mini", effort: "low" }, L2: { model: "gpt-main", effort: "medium" }, L3: { model: "gpt-max", effort: "high" } },
};
const answer = (choice: string, probability = 0.8): DecisionProviderOutcome => ({
  answers: { difficulty: { type: "choice", choice, probabilities: { [choice]: probability } } },
  receipt: decisionReceipt("openai", { usage: { inputTokens: 50, outputTokens: 1 } }),
});

let sequence = 0;
async function fixture(options: { decisions?: boolean; runtimeConfig?: Record<string, unknown>; overrides?: Record<string, unknown> | null; adapterType?: string; adapterConfig?: Record<string, unknown> } = {}) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Difficulty tests", issuePrefix: `DR${++sequence}` });
  await db.insert(companyMemberships).values({ companyId, principalId: "alice", principalType: "user", status: "active", membershipRole: "owner" });
  const runtimeConfig = options.runtimeConfig ?? { difficultyRouting: routingConfig };
  await db.insert(agents).values({ id: agentId, companyId, name: "Coder", adapterType: "codex_local", runtimeConfig });
  await db.insert(issues).values({ id: issueId, companyId, title: "Fix a typo in the README", description: "One word is misspelled.",
    status: "in_progress", priority: "medium", assigneeAgentId: agentId, assigneeAdapterOverrides: options.overrides ?? null });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "on_demand", responsibleUserId: "alice",
    contextSnapshot: { issueId } });
  const provider = vi.fn().mockResolvedValue(answer("L1"));
  const service = decisionModelService(db, { provider });
  if (options.decisions !== false) {
    const binding = await aiConnectionService(db).save(companyId, "alice", { provider: "openai", method: "api_key", name: "Decision key",
      ownership: "shared", apiKey: "fixture-key", agentIds: [], allAgents: true }, "fixture-key");
    await service.configure(companyId, "alice", { ...binding, enabled: true, allowBackground: true });
  }
  const loadIssue = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
  const agent = { id: agentId, companyId, adapterType: options.adapterType ?? "codex_local", adapterConfig: options.adapterConfig ?? {}, runtimeConfig };
  const resolve = async (issue?: Awaited<ReturnType<typeof loadIssue>>, extra: { classifyWithAgentCli?: AgentCliClassify; signal?: AbortSignal } = {}) =>
    resolveIssueDifficultyRouting({ db, decide: service.decide, agent, runId, issue: issue ?? await loadIssue(), ...extra });
  return { companyId, agentId, issueId, runId, provider, loadIssue, resolve, agent };
}

describe("issue difficulty routing", () => {
  it("rates a new task once, stores the tier, and maps it to the adapter's model and effort keys", async () => {
    const f = await fixture();
    const first = await f.resolve();
    expect(first).toMatchObject({ applied: true, reused: false, adapterConfig: { model: "gpt-mini", modelReasoningEffort: "low" },
      routing: { tier: "L1", source: "auto", classifier: "decision_model", agentId: f.agentId, model: "gpt-mini", effort: "low", confidence: 0.8 } });
    expect(f.provider).toHaveBeenCalledOnce();
    const [invocation] = await db.select().from(decisionInvocations).where(eq(decisionInvocations.companyId, f.companyId));
    expect(invocation).toMatchObject({ feature: "issue.difficulty_routing", issueId: f.issueId, runId: f.runId, status: "succeeded" });
    expect((await f.loadIssue()).difficultyRouting).toMatchObject({ tier: "L1", decisionInvocationId: invocation.id });
    const second = await f.resolve();
    expect(second).toMatchObject({ applied: true, reused: true, routing: { tier: "L1" } });
    expect(f.provider).toHaveBeenCalledOnce();
  });

  it("falls back to rules when the decision model is not configured and no subscription classifier is available", async () => {
    const f = await fixture({ decisions: false });
    expect(await f.resolve()).toMatchObject({ applied: true, reused: false, routing: { tier: "L1", source: "auto", classifier: "rules", confidence: null } });
    expect((await f.loadIssue()).difficultyRouting).toMatchObject({ tier: "L1", classifier: "rules" });
  });

  it("rates with the agent's subscription CLI when the decision model is not configured", async () => {
    const f = await fixture({ decisions: false });
    const cli = vi.fn<AgentCliClassify>().mockResolvedValue("L3");
    expect(await f.resolve(undefined, { classifyWithAgentCli: cli })).toMatchObject({ applied: true,
      adapterConfig: { model: "gpt-max", modelReasoningEffort: "high" }, routing: { tier: "L3", classifier: "agent_cli" } });
    expect(cli).toHaveBeenCalledWith(expect.objectContaining({ title: "Fix a typo in the README" }), undefined);
  });

  it("does not call the subscription CLI when the decision model answers", async () => {
    const f = await fixture();
    const cli = vi.fn<AgentCliClassify>().mockResolvedValue("L3");
    expect(await f.resolve(undefined, { classifyWithAgentCli: cli })).toMatchObject({ routing: { tier: "L1", classifier: "decision_model" } });
    expect(cli).not.toHaveBeenCalled();
  });

  it("falls back to rules when the subscription CLI fails or gives no tier", async () => {
    const failed = await fixture({ decisions: false });
    expect(await failed.resolve(undefined, { classifyWithAgentCli: vi.fn<AgentCliClassify>().mockRejectedValue(new Error("codex exited with 1")) }))
      .toMatchObject({ applied: true, routing: { tier: "L1", classifier: "rules" } });
    const unanswered = await fixture({ decisions: false });
    expect(await unanswered.resolve(undefined, { classifyWithAgentCli: vi.fn<AgentCliClassify>().mockResolvedValue(null) }))
      .toMatchObject({ routing: { classifier: "rules" } });
  });

  it("stops without a tier when the run is cancelled during the subscription check", async () => {
    const f = await fixture({ decisions: false });
    const controller = new AbortController();
    const cli = vi.fn<AgentCliClassify>().mockImplementation(async () => { controller.abort(); throw new Error("aborted"); });
    await expect(f.resolve(undefined, { classifyWithAgentCli: cli, signal: controller.signal })).rejects.toThrow("aborted");
    expect((await f.loadIssue()).difficultyRouting).toBeNull();
  });

  it("falls back to rules when the decision answer is not a tier", async () => {
    const f = await fixture();
    f.provider.mockResolvedValue(answer("L9"));
    expect(await f.resolve()).toMatchObject({ applied: true, routing: { classifier: "rules" } });
  });

  it("keeps a manual model or effort override and does not call the decision model", async () => {
    const f = await fixture({ overrides: { adapterConfig: { modelReasoningEffort: "xhigh" } } });
    expect(await f.resolve()).toEqual({ applied: false, reason: "manual_override" });
    expect(f.provider).not.toHaveBeenCalled();
  });

  it("does nothing for agents without difficulty routing", async () => {
    const f = await fixture({ runtimeConfig: {} });
    expect(await f.resolve()).toEqual({ applied: false, reason: "disabled" });
    expect(f.provider).not.toHaveBeenCalled();
  });

  it("does nothing for runner harnesses that ignore task model overrides", async () => {
    const f = await fixture({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "pi" } });
    expect(await f.resolve()).toEqual({ applied: false, reason: "unsupported" });
    expect(f.provider).not.toHaveBeenCalled();
  });

  it("falls back to rules when the decision call throws", async () => {
    const f = await fixture();
    const outcome = await resolveIssueDifficultyRouting({
      db, decide: vi.fn().mockRejectedValue(new Error("request too large")), agent: f.agent, runId: f.runId, issue: await f.loadIssue(),
    });
    expect(outcome).toMatchObject({ applied: true, routing: { tier: "L1", classifier: "rules" } });
  });

  it("keeps a newer tier choice when a run reuses an older snapshot", async () => {
    const f = await fixture();
    const pinned = { tier: "L2", source: "manual", agentId: f.agentId, model: "old", effort: "medium",
      confidence: null, decidedAt: "2026-01-01T00:00:00.000Z", decisionInvocationId: null };
    await db.update(issues).set({ difficultyRouting: pinned }).where(eq(issues.id, f.issueId));
    const snapshot = await f.loadIssue();
    const newer = { ...pinned, tier: "L3", decidedAt: "2026-01-02T00:00:00.000Z" };
    await db.update(issues).set({ difficultyRouting: newer }).where(eq(issues.id, f.issueId));
    expect(await f.resolve(snapshot)).toMatchObject({ applied: true, reused: true, routing: { tier: "L2", model: "gpt-main" } });
    expect((await f.loadIssue()).difficultyRouting).toEqual(newer);
    await db.update(issues).set({ difficultyRouting: null }).where(eq(issues.id, f.issueId));
    await f.resolve(snapshot);
    expect((await f.loadIssue()).difficultyRouting).toBeNull();
  });

  it("rates the task again after it moves to another agent", async () => {
    const f = await fixture();
    await db.update(issues).set({ difficultyRouting: { tier: "L3", source: "auto", agentId: randomUUID(), model: "x", effort: "high",
      confidence: null, decidedAt: new Date().toISOString(), decisionInvocationId: null } }).where(eq(issues.id, f.issueId));
    expect(await f.resolve()).toMatchObject({ applied: true, reused: false, routing: { tier: "L1", agentId: f.agentId } });
  });

  it("applies a manual tier from the API and does not replace it with an automatic one", async () => {
    const f = await fixture();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "alice", source: "session", companyIds: [f.companyId],
        memberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }] } as typeof req.actor;
      next();
    });
    app.use("/api", issueDifficultyRoutingRoutes(db)); app.use(errorHandler);
    expect((await request(app).put(`/api/issues/${f.issueId}/difficulty-routing`).send({ tier: "L4" })).status).toBe(400);
    const put = await request(app).put(`/api/issues/${f.issueId}/difficulty-routing`).send({ tier: "L3" });
    expect(put.status).toBe(200);
    expect(put.body.difficultyRouting).toMatchObject({ tier: "L3", source: "manual", model: "gpt-max", effort: "high" });
    expect(await f.resolve()).toMatchObject({ applied: true, reused: true, adapterConfig: { model: "gpt-max", modelReasoningEffort: "high" } });
    expect(f.provider).not.toHaveBeenCalled();
    const reset = await request(app).delete(`/api/issues/${f.issueId}/difficulty-routing`);
    expect(reset.body).toEqual({ difficultyRouting: null });
    expect((await f.loadIssue()).difficultyRouting).toBeNull();
    const actions = (await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, f.issueId)))).map(row => row.action);
    expect(actions).toEqual(expect.arrayContaining(["issue.difficulty_routing.set", "issue.difficulty_routing.reset"]));
    const other = await fixture();
    expect((await request(app).put(`/api/issues/${other.issueId}/difficulty-routing`).send({ tier: "L1" })).status).toBe(404);
  });
});

describe("difficulty routing helpers", () => {
  it("adds tier settings on top of existing task overrides", () => {
    expect(withDifficultyRoutingOverrides(null, {})).toBeNull();
    expect(withDifficultyRoutingOverrides(null, { model: "m" })).toEqual({ adapterConfig: { model: "m" }, useProjectWorkspace: null });
    expect(withDifficultyRoutingOverrides({ adapterConfig: { chrome: true }, useProjectWorkspace: true }, { model: "m" }))
      .toEqual({ adapterConfig: { chrome: true, model: "m" }, useProjectWorkspace: true });
  });

  it("truncates long titles and descriptions in the decision request", () => {
    const requestBody = buildDifficultyRequest({ id: randomUUID(), title: "t".repeat(40000), description: "x".repeat(7000), priority: "high", workMode: "standard",
      projectId: null, assigneeAgentId: null, assigneeAdapterOverrides: null, difficultyRouting: null });
    expect(requestBody.state).toMatchObject({ descriptionTruncated: true, priority: "high", inProject: false });
    expect(((requestBody.state as Record<string, string>).description).length).toBe(6000);
    expect(((requestBody.state as Record<string, string>).title).length).toBe(500);
    expect(Object.keys((requestBody.questions.difficulty as { criteria: Record<string, string> }).criteria)).toEqual(["L1", "L2", "L3"]);
  });
});
