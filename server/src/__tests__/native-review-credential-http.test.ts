import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentApiKeys, agents, authUsers, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issueThreadInteractions, issues, nativeRunResults, statusDecisionEffects, statusDecisions, workAssessments } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("native completion review HTTP credentials", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "native-review-test-secret";
    delete process.env.PAPERCLIP_INSTANCE_ID;
    temp = await startEmbeddedPostgresTestDatabase("native-review-credentials-");
    db = createDb(temp.connectionString);
    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
  }, 20_000);

  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    await db?.$client.end({ timeout: 1 });
    await temp?.cleanup();
  });

  async function fixture(targetKey = "native_completion_review", board = false) {
    const companyId = randomUUID(), issueId = randomUUID(), interactionId = randomUUID(), decisionId = randomUUID();
    const userId = `reviewer-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Test owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Test", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    const [worker, reviewer] = await db.insert(agents).values([
      { companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, permissions: {}, createdByUserId: userId },
      { companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, permissions: {}, createdByUserId: userId },
    ]).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Review", status: "in_review", statusVersion: 3, responsibleUserId: userId, assigneeAgentId: targetKey === "native_completion_review" ? worker!.id : reviewer!.id });
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: randomUUID(), createdByActorType: "user", createdByActorId: userId }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: worker!.id, nativeIssueId: issueId, runtimeMode: "native", status: "succeeded", responsibleUserId: userId, completionContractId: contract!.id, completionContractSha256: contract!.canonicalSha256 }).returning();
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId: source!.id, completionContractId: contract!.id, serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: {}, canonicalSha256: randomUUID() }).returning();
    const [assessment] = await db.insert(workAssessments).values({ companyId, issueId, runId: source!.id, contractId: contract!.id, resultId: result!.id, triggerKind: "native_result", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: 2, policyVersion: "test", assessmentJson: {}, inputDigest: randomUUID() }).returning();
    await db.insert(statusDecisions).values({ id: decisionId, companyId, issueId, runId: source!.id, assessmentId: assessment!.id, decisionVersion: 1, policyVersion: "test", fromStatus: "in_progress", toStatus: "in_review", reasonCode: "explicit_review", decisionJson: { projectedStatusVersion: 3 }, decisionDigest: randomUUID(), applicationState: "applied" });
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId, kind: "request_confirmation", status: "pending", sourceRunId: source!.id, addresseeAgentId: board ? null : reviewer!.id, addresseeUserId: board ? "local-board" : null, createdByAgentId: worker!.id, payload: { version: 1, prompt: "Review?", target: { type: "custom", key: targetKey, revisionId: decisionId } } });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: reviewer!.id, nativeIssueId: issueId, runtimeMode: "native", status: "running", responsibleUserId: userId, contextSnapshot: { issueId, nativeReviewInteractionId: interactionId, nativeReviewDecisionId: decisionId } }).returning();
    await db.update(issues).set({ lastStatusDecisionId: decisionId, executionRunId: run!.id }).where(eq(issues.id, issueId));
    const key = `pcp_${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId, agentId: reviewer!.id, name: "Test", keyHash: createHash("sha256").update(key).digest("hex"), responsibleUserId: userId });
    const jwt = createLocalAgentJwt(reviewer!.id, companyId, "process", run!.id, userId)!;
    return { issueId, interactionId, runId: run!.id, decisionId, key, jwt };
  }

  it.each(["accept", "reject"])("denies an agent API key and run header before %s", async (action) => {
    const f = await fixture();
    const path = `/api/issues/${f.issueId}/interactions/${f.interactionId}/${action}`;
    const before = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, f.decisionId));
    const response = await request(app).post(path).set("Authorization", `Bearer ${f.key}`).set("X-Paperclip-Run-Id", f.runId).send(action === "reject" ? { reason: "Changes needed" } : {});
    expect(response.status).toBe(403);
    expect(response.body.error).toContain("signed agent run credential");
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.interactionId)))[0]?.status).toBe("pending");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]?.status).toBe("in_review");
    expect(await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, f.decisionId))).toEqual(before);
  });

  it.each(["accept", "reject"])("resolves a current review with a signed run credential: %s", async (action) => {
    const f = await fixture();
    const response = await request(app).post(`/api/issues/${f.issueId}/interactions/${f.interactionId}/${action}`).set("Authorization", `Bearer ${f.jwt}`).set("X-Paperclip-Run-Id", f.runId).send(action === "reject" ? { reason: "Changes needed" } : {});
    expect(response.status).toBe(200);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.interactionId)))[0]?.status).toBe(action === "accept" ? "accepted" : "rejected");
  });

  it("rejects a signed token with a different run header in middleware", async () => {
    const f = await fixture();
    const response = await request(app).post(`/api/issues/${f.issueId}/interactions/${f.interactionId}/accept`).set("Authorization", `Bearer ${f.jwt}`).set("X-Paperclip-Run-Id", randomUUID()).send({});
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.code).toBe("agent_jwt_run_id_mismatch");
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.interactionId)))[0]?.status).toBe("pending");
  });

  it("does not reject ordinary confirmations solely for using an agent key", async () => {
    const f = await fixture("ordinary_confirmation");
    const response = await request(app).post(`/api/issues/${f.issueId}/interactions/${f.interactionId}/accept`).set("Authorization", `Bearer ${f.key}`).set("X-Paperclip-Run-Id", f.runId).send({});
    expect(response.status).toBe(200);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.interactionId)))[0]?.status).toBe("accepted");
  });

  it("leaves board review resolution on its existing authorization path", async () => {
    const f = await fixture("native_completion_review", true);
    const response = await request(app).post(`/api/issues/${f.issueId}/interactions/${f.interactionId}/accept`).send({});
    expect(response.status).toBe(200);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.interactionId)))[0]?.status).toBe("accepted");
  });
});
