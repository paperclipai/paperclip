import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, cases, caseAccessSources, caseEvents, caseHandoffs, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { caseRoutes } from "../routes/cases.js";
import { errorHandler } from "../middleware/error-handler.js";
import { assertCaseTrustedForExecution, retainCaseAccessSource } from "../services/case-access.js";
import { caseHandoffService } from "../services/case-handoffs.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { retainTaskProviderOutputPolicy } from "../services/task-provider-output-policy.js";
import type { StorageService } from "../storage/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const bindings = ["native", "legacy", "context-issue", "context-task", "native-before-legacy"] as const;

describePostgres("case output provenance", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-case-output-");
    db = createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
  }, 30_000);

  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });

  async function fixture(binding: typeof bindings[number] = "legacy", restricted = true) {
    const companyId = randomUUID(), agentId = randomUUID(), sourceId = randomUUID(), targetId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Case provenance", issuePrefix: `C${companyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "engineer", adapterType: "process" });
    await db.insert(issues).values([{ id: sourceId, companyId, title: "Source", assigneeAgentId: agentId },
      { id: targetId, companyId, title: "Ordinary task", assigneeAgentId: agentId }]);
    await retainTaskProviderOutputPolicy(db, { companyId, issueId: sourceId, disposition: restricted ? "forbidden" : "ordinary" });
    await retainTaskProviderOutputPolicy(db, { companyId, issueId: targetId, disposition: "ordinary" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "assignment",
      ...(binding === "native" || binding === "native-before-legacy" ? { nativeIssueId: sourceId,
        ...(binding === "native-before-legacy" ? { issueId: targetId } : {}) } : binding === "legacy" ? { issueId: sourceId }
        : { contextSnapshot: binding === "context-issue" ? { issueId: sourceId } : { taskId: sourceId } }) });
    if (binding === "context-issue" || binding === "context-task") await db.update(heartbeatRuns).set({ issueId: null }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, sourceId));
    const actor: Express.Request["actor"] = { type: "agent", companyId, agentId, runId };
    const board: Express.Request["actor"] = { type: "board", source: "local_implicit", userId: "case-operator", isInstanceAdmin: true };
    return { companyId, agentId, sourceId, targetId, runId, actor, board };
  }

  function http(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", caseRoutes(db, {} as StorageService));
    app.use(errorHandler);
    return request(app);
  }

  async function record(f: Awaited<ReturnType<typeof fixture>>) {
    const response = await http(f.board).post(`/api/companies/${f.companyId}/cases`)
      .send({ caseType: "work", key: randomUUID(), title: "Original", fields: { fact: "Original fact" } }).expect(201);
    return response.body as { id: string; key: string };
  }

  for (const operation of ["create", "upsert", "update"] as const) {
    it.each(bindings)(`${operation} denies the restricted %s writer without persisting case content`, async binding => {
      const f = await fixture(binding), prior = operation === "create" ? null : await record(f);
      const client = http(f.actor);
      const response = operation === "update" ? await client.patch(`/api/cases/${prior!.id}`).send({ fields: { fact: "Restricted output" } })
        : await client.post(`/api/companies/${f.companyId}/cases`).send({ caseType: "work", key: prior?.key ?? randomUUID(), title: "Restricted output" });
      expect(response.status).toBe(403);
      expect(await db.select().from(cases).where(eq(cases.companyId, f.companyId))).toMatchObject(prior ? [{ id: prior.id, title: "Original", fields: { fact: "Original fact" } }] : []);
      expect((await db.select().from(caseEvents).where(eq(caseEvents.companyId, f.companyId))).every(row => row.actorType === "user")).toBe(true);
    });

    it.each(bindings)(`${operation} preserves ordinary %s writes`, async binding => {
      const f = await fixture(binding, false), prior = operation === "create" ? null : await record(f);
      const client = http(f.actor);
      if (operation === "update") await client.patch(`/api/cases/${prior!.id}`).send({ fields: { fact: "Ordinary output" } }).expect(200);
      else await client.post(`/api/companies/${f.companyId}/cases`).send({ caseType: "work", key: prior?.key ?? randomUUID(), title: "Ordinary output" }).expect(prior ? 200 : 201);
      const rows = await db.select().from(cases).where(eq(cases.companyId, f.companyId));
      expect(rows).toHaveLength(1);
      expect(operation === "update" ? rows[0].fields : rows[0].title).toEqual(operation === "update" ? { fact: "Ordinary output" } : "Ordinary output");
    });
  }

  it.each(bindings)("fresh handoff denies restricted %s instructions before creating a case, task or intent", async binding => {
    const f = await fixture(binding);
    await expect(caseHandoffService(db).handoff(f.companyId, f.actor, { idempotencyKey: randomUUID(),
      case: { create: { caseType: "work", title: "Restricted case" } }, toAgentId: f.agentId,
      phase: "verify", instructions: "Restricted output", workflow_document_text: "Restricted workflow" })).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(cases).where(eq(cases.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(caseHandoffs).where(eq(caseHandoffs.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(2);
  });

  it.each(bindings)("historical %s case writes fail execution admission after source restriction", async binding => {
    const f = await fixture(binding, false), saved = await record(f);
    await db.insert(caseEvents).values({ companyId: f.companyId, caseId: saved.id, kind: "updated", actorType: "agent", actorAgentId: f.agentId, runId: f.runId });
    await expect(assertCaseTrustedForExecution(db, { id: saved.id, companyId: f.companyId })).resolves.toBeUndefined();
    await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.sourceId, disposition: "forbidden" });
    await expect(assertCaseTrustedForExecution(db, { id: saved.id, companyId: f.companyId })).rejects.toMatchObject({ status: 403 });
    await http(f.board).get(`/api/cases/${saved.id}`).expect(200);
  });

  it.each(bindings)("ordinary %s handoff survives replay but cannot dispatch after source restriction", async binding => {
    const f = await fixture(binding, false);
    const input = { idempotencyKey: randomUUID(), case: { create: { caseType: "work", title: "Ordinary case" } },
      toAgentId: f.agentId, phase: "verify", instructions: "Ordinary instructions", workflow_document_text: "Ordinary workflow" };
    const accepted = await caseHandoffService(db).handoff(f.companyId, f.actor, input);
    expect(accepted.state).toBe("pending_dispatch");
    await expect(caseHandoffService(db).authorizePendingDispatch(accepted.handoffId)).resolves.toBeUndefined();
    await retainTaskProviderOutputPolicy(db, { companyId: f.companyId, issueId: f.sourceId, disposition: "forbidden" });
    const replay = await caseHandoffService(db).handoff(f.companyId, f.actor, input);
    expect(replay).toMatchObject({ handoffId: accepted.handoffId, replayed: true });
    expect(await db.select().from(caseHandoffs).where(eq(caseHandoffs.companyId, f.companyId))).toHaveLength(1);
    await expect(caseHandoffService(db).authorizePendingDispatch(accepted.handoffId)).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(cases).where(eq(cases.id, accepted.caseId))).toMatchObject([{ workIssueId: accepted.taskId }]);
  });

  it("retained source and restricted primary task each deny case execution", async () => {
    const f = await fixture(), saved = await record(f);
    await retainCaseAccessSource(db, { companyId: f.companyId, caseId: saved.id, sourceKind: "issue", sourceId: f.sourceId });
    await expect(assertCaseTrustedForExecution(db, { id: saved.id, companyId: f.companyId })).rejects.toMatchObject({ status: 403 });
    await db.delete(caseAccessSources).where(eq(caseAccessSources.caseId, saved.id));
    await db.update(cases).set({ workIssueId: f.sourceId }).where(eq(cases.id, saved.id));
    await expect(assertCaseTrustedForExecution(db, { id: saved.id, companyId: f.companyId })).rejects.toMatchObject({ status: 403 });
    const ordinaryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: ordinaryRunId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.targetId, status: "running", invocationSource: "assignment" });
    await http({ ...f.actor, runId: ordinaryRunId }).patch(`/api/cases/${saved.id}`).send({ title: "Restricted primary output" }).expect(403);
  });

  it("missing retained source remains fail closed after source deletion", async () => {
    const f = await fixture(), saved = await record(f);
    await retainCaseAccessSource(db, { companyId: f.companyId, caseId: saved.id, sourceKind: "issue", sourceId: f.sourceId });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.delete(issues).where(eq(issues.id, f.sourceId));
    await expect(assertCaseTrustedForExecution(db, { id: saved.id, companyId: f.companyId })).rejects.toMatchObject({ status: 403 });
  });
});
