import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companyMemberships, heartbeatRuns, issues, issueThreadInteractions } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { documentService } from "../services/documents.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

if (!support.supported) console.warn(`Skipping onboarding approval history tests: ${support.reason}`);
describe.skipIf(!support.supported)("onboarding approval producer/consumer contract", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  let decisionUserId: string;
  let cookie: string;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer({ humanSessions: true });
    const board = await server.fixture({ connectionScenario: "fresh", disableWakeOnDemand: true });
    decisionUserId = board.responsibleUserId!;
    cookie = await server.humanSession(decisionUserId);
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });

  type Fixture = Awaited<ReturnType<typeof server.fixture>>;
  const selected = { id: "discovery", label: "Read-only discovery", description: "Write the architecture document." };
  const request = async (f: Fixture, kind: "confirmation" | "checkbox", key: string, payload: Record<string, unknown> = {}) => {
    const receipt = await f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: {
      interactionKind: kind, idempotencyKey: key, title: key, prompt: key, continuationPolicy: "wake_assignee", payload: { version: 1, ...payload },
    } }) as { interaction: { id: string } };
    return receipt.interaction.id;
  };
  const accept = async (f: Fixture, id: string, selectedOptionIds?: string[]) => {
    const response = await fetch(`${server.apiUrl}/api/issues/${f.issueId}/interactions/${id}/accept`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", origin: server.apiUrl },
      body: JSON.stringify(selectedOptionIds ? { selectedOptionIds } : {}),
    });
    const data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(200);
    expect(data).toMatchObject({ status: "accepted", resolvedByUserId: decisionUserId });
  };
  const approvedHistory = async (kind: "confirmation" | "checkbox") => {
    const f = await server.fixture({ disableWakeOnDemand: true, connectionScenario: "fresh" });
    await server.db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user",
      principalId: decisionUserId, status: "active", membershipRole: "member" });
    await server.db.update(issues).set({ originKind: "onboarding_first_task" }).where(eq(issues.id, f.issueId));
    const plan = (await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key: "plan", format: "markdown",
      body: "Step 1: read-only discovery and architecture document. Step 2: implementation needs separate approval.",
      createdByAgentId: f.agentId, createdByRunId: f.runId })).document;
    const planId = await request(f, kind, "Approve plan", {
      target: { type: "issue_document", key: "plan", issueId: f.issueId, documentId: plan.id, revisionId: plan.latestRevisionId },
      ...(kind === "checkbox" ? { options: [selected, { id: "implementation", label: "Implement the application" }],
        defaultSelectedOptionIds: [selected.id, "implementation"], minSelected: 1 } : {}),
    });
    await accept(f, planId, kind === "checkbox" ? [selected.id] : undefined);
    const hiringId = await request(f, "checkbox", "Hire a platform engineer", {
      options: [{ id: "engineer", label: "Hire one Platform Engineer" }], minSelected: 1, defaultSelectedOptionIds: ["engineer"],
    });
    await accept(f, hiringId, ["engineer"]);
    // Agent creation is fixture setup here; the live journey exercises hiring.
    const workerId = randomUUID();
    await server.db.insert(agents).values({ id: workerId, companyId: f.companyId, name: "Platform Engineer",
      status: "active", adapterType: "paperclip_runner", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    const executionId = await request(f, "confirmation", "Start Step 1: Discovery");
    return { f, plan, planId, hiringId, executionId, workerId };
  };

  const resume = async (f: Fixture) => {
    const runId = randomUUID();
    await server.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await server.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      responsibleUserId: f.responsibleUserId, status: "running", runtimeMode: "native", nativeIssueId: f.issueId,
      invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: f.issueId } });
    await server.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    await initializeRunIdentity(server.db, { companyId: f.companyId, runId, issueId: f.issueId,
      responsibleUserId: f.responsibleUserId!, cause: "instruction" });
    return { ...f, runId, authority: new PaperclipRunnerToolAuthority(server.db, { ...f, runId }) };
  };

  for (const kind of ["confirmation", "checkbox"] as const) {
    it.each(["native", "REST issue", "REST child", "decomposition"] as const)(
      `${kind} plan → hiring → separate execution approval → %s, including later-run context`, async path => {
        const history = await approvedHistory(kind);
        const { plan, workerId } = history;
        let f = history.f;
        const nativeInput = { tool: "create_task", callId: randomUUID(), arguments: {
          title: "Step 1: Discovery and architecture", assigneeActorId: workerId, status: "todo", idempotencyKey: "step-1",
        } };
        const before = await f.snapshot();
        // Plan and hiring acceptance alone cannot answer a separate pending execution request.
        await expect(f.authority.execute(nativeInput)).rejects.toMatchObject({ status: 403 });
        expect((await f.snapshot()).issues).toEqual(before.issues);
        await accept(f, history.executionId);
        f = await resume(f);
        const context = await f.authority.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} }) as {
          acceptedPlan: { revisionId: string; approvedOptions?: unknown[] };
        };
        expect(context.acceptedPlan).toMatchObject({ revisionId: plan.latestRevisionId, markdown: plan.body });
        if (kind === "checkbox") expect(context.acceptedPlan.approvedOptions).toEqual([selected]);
        else expect(context.acceptedPlan).not.toHaveProperty("approvedOptions");

        const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
        const post = async () => {
          const route = path === "decomposition" ? `/api/issues/${f.issueId}/accepted-plan-decompositions`
            : path === "REST child" ? `/api/issues/${f.issueId}/children` : `/api/companies/${f.companyId}/issues`;
          const child = { title: "Step 1: Discovery and architecture", status: "backlog", workMode: "standard", priority: "medium", assigneeAgentId: workerId };
          const body = path === "decomposition" ? { acceptedPlanRevisionId: plan.latestRevisionId, children: [child] }
            : path === "REST child" ? child : { ...child, parentId: f.issueId, idempotencyKey: "step-1" };
          const response = await fetch(`${server.apiUrl}${route}`, { method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
          const data = await response.json();
          expect(response.ok, JSON.stringify(data)).toBe(true);
          return path === "decomposition" ? data.childIssueIds[0] as string : (data.issue?.id ?? data.id) as string;
        };
        let childId: string;
        if (path === "native") {
          const created = await f.authority.execute(nativeInput) as { task: { id: string }; scheduledWakeIds: string[] };
          childId = created.task.id;
          expect(created.scheduledWakeIds).toEqual([`created-child:${childId}`]);
          const reconnected = new PaperclipRunnerToolAuthority(server.db, f);
          expect(await reconnected.execute({ ...nativeInput, callId: randomUUID() })).toEqual(created);
        } else {
          childId = await post();
          // The child REST schema has no idempotency key; replay belongs to the other entry points.
          if (path !== "REST child") expect(await post()).toBe(childId);
        }
        const children = await server.db.select().from(issues).where(and(eq(issues.companyId, f.companyId), eq(issues.parentId, f.issueId)));
        expect(children).toMatchObject([{ id: childId, assigneeAgentId: workerId, title: "Step 1: Discovery and architecture" }]);
        const creationEvents = await server.db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, childId)));
        expect(creationEvents.filter(event => ["issue.created", "issue.child_created"].includes(event.action))).toHaveLength(1);
        const [saved] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, history.planId));
        expect(saved.status).toBe("accepted");
        if (kind === "checkbox") expect(saved.result).toMatchObject({ selectedOptionIds: [selected.id] });
      });
  }
});
