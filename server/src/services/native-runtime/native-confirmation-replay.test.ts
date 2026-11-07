import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueThreadInteractions, issues } from "@paperclipai/db";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND } from "@paperclipai/shared";
import { startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { documentService } from "../documents.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { materializeNativeInteractionResponses } from "./native-interaction-bridge.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

describe("native accepted confirmation replay", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("paperclip-confirmation-replay-");
    db = createDb(temporary.connectionString);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function fixture(withPlan = false, interactionKind: "confirmation" | "checkbox" = "confirmation") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const sourceRunId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Confirmation replay", issuePrefix: `R${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Operator", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Create the approved artifact", status: "in_progress",
      workMode: "standard", originKind: ONBOARDING_FIRST_TASK_ORIGIN_KIND, assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, runtimeMode: "native", nativeIssueId: issueId,
      status: "running", invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: sourceRunId }).where(eq(issues.id, issueId));
    const payload: Record<string, unknown> = { acceptLabel: "Approve", rejectLabel: "Request changes", rejectRequiresReason: false, supersedeOnUserComment: false };
    if (interactionKind === "checkbox") Object.assign(payload, {
      options: [{ id: "artifact", label: "Create the requested artifact" }], minSelected: 0, maxSelected: 1,
    });
    let plan: Awaited<ReturnType<ReturnType<typeof documentService>["upsertIssueDocument"]>> | undefined;
    if (withPlan) {
      plan = await documentService(db).upsertIssueDocument({ issueId, key: "plan", title: "Artifact plan", format: "markdown",
        body: "Create the requested file and save its task document.", baseRevisionId: null, createdByAgentId: agentId, createdByRunId: sourceRunId });
      payload.target = { type: "issue_document", key: "plan", revisionId: plan.document.latestRevisionId };
    }
    const input = { idempotencyKey: "approved-artifact", interactionKind, title: "Approve artifact work",
      prompt: "Create the requested file and save its task document.", continuationPolicy: "wake_assignee",
      payload };
    const original = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId: sourceRunId });
    const created = await original.execute({ tool: "request_human_input", callId: randomUUID(), arguments: input }) as { interaction: { id: string } };
    await db.update(heartbeatRuns).set({ status: "succeeded", nativePhase: "committed", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, sourceRunId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const accepted = await issueThreadInteractionService(db).acceptInteraction(issue, created.interaction.id,
      interactionKind === "checkbox" ? { selectedOptionIds: ["artifact"] } : {}, { userId: "local-board" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", nativeIssueId: issueId,
      status: "running", invocationSource: "automation", triggerDetail: "system",
      contextSnapshot: { issueId, interactionId: created.interaction.id, source: "issue.interaction.accept" } });
    const responses = await materializeNativeInteractionResponses({ db, companyId, agentId, issueId, runId,
      interactionIds: [created.interaction.id] });
    const execution = buildNativeExecutionInput({ companyId, agentId, runId,
      issue: { id: issueId, identifier: null, title: issue.title, description: null, workMode: "standard" },
      taskPrompt: "Continue the accepted work.", provider: "codex", normalizedSessionId: randomUUID(), resumedSession: true,
      workspace: { id: randomUUID(), cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      interactionResponses: responses, runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Deliver the requested artifact", criteria: [{ id: "artifact", requirement: "Publish the requested artifact." }] } } });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, sourceRunId, runId, input, execution, accepted: accepted.interaction, plan,
      authority: new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId }) };
  }

  it.each(["confirmation", "checkbox"] as const)("returns the original accepted %s to its resumed native run without another human wait", async interactionKind => {
    const f = await fixture(false, interactionKind);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    const [beforeIssue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const call = { tool: "request_human_input", callId: randomUUID(), arguments: f.input };
    const result = await f.authority.execute(call);
    expect(result).toMatchObject({ disposition: "duplicate", interaction: { id: f.accepted.id, status: "accepted", sourceRunId: f.sourceRunId,
      resolvedByUserId: "local-board", result: { outcome: "accepted" } } });
    if (interactionKind === "checkbox") expect(result).toMatchObject({ interaction: { result: { selectedOptionIds: ["artifact"] } } });
    const rows = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, f.companyId), eq(issueThreadInteractions.issueId, f.issueId)));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("accepted");
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ status: beforeIssue.status, assigneeAgentId: f.agentId, executionRunId: f.runId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(wakes);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toEqual(activity);
    await expect(f.authority.recover(call)).resolves.toEqual({ result });
    await expect(f.authority.execute({ tool: "report_progress", callId: randomUUID(), arguments: {
      idempotencyKey: f.input.idempotencyKey, body: "A different operation cannot reuse this receipt key.",
    } })).rejects.toThrow("paperclip_runner_tool_idempotency_conflict");
    const child = await f.authority.execute({ tool: "create_task", callId: randomUUID(), arguments: {
      idempotencyKey: "approved-child", title: "Create the approved artifact", description: "Create the requested file and task document.",
    } });
    expect(child).toMatchObject({ task: { parentId: f.issueId } });
  });

  it.each(["toolAction", "secretProposal"] as const)("does not admit governed %s payloads through plain confirmation replay", async field => {
    const f = await fixture();
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const value = field === "toolAction" ? {
      version: 1, actionRequestId: randomUUID(), invocationId: randomUUID(), toolName: "write", toolDisplayName: "Write",
      connectionId: null, applicationId: null, appDisplayName: null, risk: "write", previewMarkdown: "Write a resource.",
      argumentsSummaryJson: "{}", argumentsHash: "a".repeat(64), expiresAt,
    } : {
      version: 1, proposalId: randomUUID(), sourceSecretLabel: "Synthetic credential", configPath: "env.TEST_KEY",
      targetAgentId: f.agentId, targetAgentName: "Operator", justification: "Configure synthetic access.", expiresAt,
    };
    const payload = { ...f.accepted.payload, [field]: value };
    await db.update(issueThreadInteractions).set({ payload, result: {
      version: 1, outcome: "accepted", [field]: { version: 1, status: "expired", updatedAt: new Date().toISOString() },
    } }).where(eq(issueThreadInteractions.id, f.accepted.id));
    await expect(f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: { ...f.input, payload } }))
      .rejects.toThrow("Interaction idempotency key already exists for a different request");
  });

  it.each([
    ["prompt", { prompt: "Change the approved scope." }],
    ["title", { title: "Different work" }],
    ["payload", { payload: { acceptLabel: "Approve different work" } }],
    ["target", { payload: { target: { type: "custom", key: "different-work", label: "Different work" } } }],
    ["resolver policy", { resolverPolicy: "human_only" }],
    ["continuation policy", { continuationPolicy: "none" }],
  ])("rejects same-key replay with changed %s", async (_label, change) => {
    const f = await fixture();
    await expect(f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: { ...f.input, ...change } }))
      .rejects.toThrow("Interaction idempotency key already exists for a different request");
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId)))
      .toMatchObject([{ id: f.accepted.id, status: "accepted", sourceRunId: f.sourceRunId }]);
  });

  it.each(["missing", "other interaction", "wrong company", "wrong task", "wrong agent", "wrong run", "rejected"])(
    "does not nominate replay from %s native response authority", async scenario => {
      const f = await fixture();
      const execution = structuredClone(f.execution);
      if (scenario === "missing") execution.interactionResponses = [];
      else if (scenario === "other interaction") execution.interactionResponses[0].interactionId = randomUUID();
      else if (scenario === "rejected") execution.interactionResponses[0].response = { status: "rejected", result: { version: 1, outcome: "rejected" } };
      else {
        const field = { "wrong company": "companyId", "wrong task": "issueId", "wrong agent": "agentId", "wrong run": "runId" } as const;
        execution.binding[field[scenario as keyof typeof field]] = randomUUID();
      }
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.runId));
      await expect(f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: f.input }))
        .rejects.toThrow("Interaction idempotency key already exists for a different request");
    },
  );

  it("keeps a different creating agent from replaying another agent's acceptance", async () => {
    const f = await fixture(), otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId: f.companyId, name: "Other operator", adapterType: "paperclip_runner", status: "active" });
    const execution = structuredClone(f.execution); execution.binding.agentId = otherAgentId;
    await db.update(heartbeatRuns).set({ agentId: otherAgentId, runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, f.issueId));
    const authority = new PaperclipRunnerToolAuthority(db, { ...f, agentId: otherAgentId });
    await expect(authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: f.input }))
      .rejects.toThrow("Interaction idempotency key already exists for a different request");
  });

  it("keeps ordinary service callers subject to source-run equality", async () => {
    const f = await fixture();
    await expect(issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, {
      kind: "request_confirmation", idempotencyKey: f.input.idempotencyKey, sourceRunId: f.runId,
      title: f.input.title, summary: f.input.prompt, continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: f.input.prompt, ...f.input.payload },
    }, { agentId: f.agentId, runId: f.runId })).rejects.toThrow("Interaction idempotency key already exists for a different request");
  });

  it("does not reuse another company's accepted interaction through a valid local binding", async () => {
    const foreign = await fixture(), local = await fixture();
    local.execution.interactionResponses[0].interactionId = foreign.accepted.id;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: local.execution } }).where(eq(heartbeatRuns.id, local.runId));
    await expect(local.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: local.input }))
      .rejects.toThrow("Interaction idempotency key already exists for a different request");
    const [original] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, foreign.accepted.id));
    expect(original).toMatchObject({ companyId: foreign.companyId, issueId: foreign.issueId, sourceRunId: foreign.sourceRunId, status: "accepted" });
  });

  it("rechecks the durable outcome instead of trusting a stale accepted projection", async () => {
    const f = await fixture();
    await db.update(issueThreadInteractions).set({ status: "rejected", result: { version: 1, outcome: "rejected" } })
      .where(eq(issueThreadInteractions.id, f.accepted.id));
    await expect(f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: f.input }))
      .rejects.toThrow("Interaction idempotency key already exists for a different request");
  });

  it.each(["newer proposal", "changed outcome", "missing original"])("rechecks accepted replay after a prior read and %s", async change => {
    const f = await fixture();
    const call = { tool: "request_human_input", callId: randomUUID(), arguments: f.input };
    expect(await f.authority.execute(call)).toMatchObject({ disposition: "duplicate", interaction: { status: "accepted" } });
    if (change === "newer proposal") {
      await f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: { ...f.input, idempotencyKey: "later-proposal" } });
    } else if (change === "changed outcome") {
      await db.update(issueThreadInteractions).set({ status: "rejected", result: { version: 1, outcome: "rejected" } })
        .where(eq(issueThreadInteractions.id, f.accepted.id));
    } else {
      await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.accepted.id));
    }
    await expect(f.authority.execute({ ...call, callId: randomUUID() }))
      .rejects.toThrow("Interaction idempotency key already exists for a different request");
    await expect(f.authority.recover(call))
      .rejects.toThrow("Interaction idempotency key already exists for a different request");
    if (change === "missing original") {
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toHaveLength(0);
    }
  });

  it("returns no recovered result and creates nothing when no current-run receipt exists", async () => {
    const f = await fixture();
    await expect(f.authority.recover({ tool: "request_human_input", callId: randomUUID(), arguments: f.input })).resolves.toBeNull();
    const rows = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: f.accepted.id, status: "accepted", sourceRunId: f.sourceRunId });
  });

  it("preserves a newer pending proposal and continues to block child creation", async () => {
    const f = await fixture();
    const newer = await f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: { ...f.input, idempotencyKey: "new-proposal" } }) as { interaction: { id: string } };
    await expect(f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: f.input }))
      .rejects.toThrow("Interaction idempotency key already exists for a different request");
    await expect(f.authority.execute({ tool: "create_task", callId: randomUUID(), arguments: { idempotencyKey: "blocked-child", title: "Unapproved child" } }))
      .rejects.toThrow("First-task proposal requires human acceptance");
    const rows = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.id === newer.interaction.id)?.status).toBe("pending");
    expect(rows.find(row => row.id === f.accepted.id)?.status).toBe("accepted");
  });

  it("does not let replaying acceptance bypass a revised plan target", async () => {
    const f = await fixture(true);
    await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "plan", title: "Revised artifact plan", format: "markdown",
      body: "Do different work.", baseRevisionId: f.plan!.document.latestRevisionId, createdByAgentId: f.agentId, createdByRunId: f.runId });
    await expect(f.authority.execute({ tool: "create_task", callId: randomUUID(), arguments: { idempotencyKey: "revised-child", title: "Revised scope" } }))
      .rejects.toThrow("First-task proposal requires human acceptance");
  });
});
