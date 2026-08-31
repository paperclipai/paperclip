import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  materializeLegacyQuestionResponseWakeProjection,
  materializeNativeInteractionResponses,
  NativeInteractionBridgeError,
} from "../services/native-runtime/native-interaction-bridge.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";

describe("P6-19 native interaction bridge", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = "78000000-0000-4000-8000-000000000001";
  const agentId = "78000000-0000-4000-8000-000000000002";
  const issueId = "78000000-0000-4000-8000-000000000003";
  const runId = "78000000-0000-4000-8000-000000000004";
  const confirmationId = "78000000-0000-4000-8000-000000000005";
  const questionsId = "78000000-0000-4000-8000-000000000006";
  const governedId = "78000000-0000-4000-8000-000000000007";
  const selfApprovedId = "78000000-0000-4000-8000-000000000008";
  const suggestedTasksId = "78000000-0000-4000-8000-000000000012";
  const checkboxId = "78000000-0000-4000-8000-000000000013";
  const itemVerdictsId = "78000000-0000-4000-8000-000000000014";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-interaction-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native interaction", issuePrefix: "NIB" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native interaction agent",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Consume an authorized interaction response",
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId, interactionId: confirmationId },
    });
    await db.insert(issueThreadInteractions).values([
      {
        id: confirmationId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "accepted",
        resolvedByUserId: "board-user",
        resolvedAt: new Date(),
        payload: { version: 1, prompt: "Continue?" },
        result: { version: 1, outcome: "accepted" },
      },
      {
        id: questionsId,
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "answered",
        resolvedByUserId: "board-user",
        resolvedAt: new Date(),
        payload: {
          version: 1,
          questions: [{
            id: "choice",
            prompt: "Which path?",
            selectionMode: "single",
            options: [{ id: "safe", label: "Safe" }],
          }],
        },
        result: { version: 1, answers: [{ questionId: "choice", optionIds: ["safe"] }] },
      },
      {
        id: governedId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "accepted",
        resolvedByUserId: "board-user",
        resolvedAt: new Date(),
        payload: {
          version: 1,
          prompt: "Execute write?",
          toolAction: {
            version: 1,
            actionRequestId: "78000000-0000-4000-8000-000000000010",
            invocationId: "78000000-0000-4000-8000-000000000011",
            toolName: "write",
            toolDisplayName: "Write",
            connectionId: null,
            applicationId: null,
            appDisplayName: null,
            risk: "write",
            previewMarkdown: "write",
            argumentsSummaryJson: "{}",
            argumentsHash: "hash",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
        result: { version: 1, outcome: "accepted" },
      },
      {
        id: selfApprovedId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "accepted",
        createdByAgentId: agentId,
        resolvedByAgentId: agentId,
        resolvedByRunId: runId,
        resolvedAt: new Date(),
        payload: { version: 1, prompt: "Self approve?" },
        result: { version: 1, outcome: "accepted" },
      },
      {
        id: suggestedTasksId,
        companyId,
        issueId,
        kind: "suggest_tasks",
        status: "accepted",
        resolvedByUserId: "board-user",
        resolvedAt: new Date(),
        payload: {
          version: 1,
          tasks: [{ clientKey: "calculator", title: "Build calculator" }],
        },
        result: {
          version: 1,
          createdTasks: [{ clientKey: "calculator", issueId: "78000000-0000-4000-8000-000000000015" }],
          skippedClientKeys: [],
        },
      },
      {
        id: checkboxId,
        companyId,
        issueId,
        kind: "request_checkbox_confirmation",
        status: "accepted",
        resolvedByUserId: "board-user",
        resolvedAt: new Date(),
        payload: {
          version: 1,
          prompt: "Choose outputs",
          options: [{ id: "guide", label: "Guide" }],
        },
        result: { version: 1, outcome: "accepted", selectedOptionIds: ["guide"] },
      },
      {
        id: itemVerdictsId,
        companyId,
        issueId,
        kind: "request_item_verdicts",
        status: "pending",
        payload: {
          version: 1,
          prompt: "Review items",
          items: [
            { id: "one", label: "One" },
            { id: "two", label: "Two" },
          ],
        },
        result: {
          version: 1,
          outcome: "resolved",
          complete: false,
          items: [{
            id: "one",
            verdict: "approve",
            resolvedByUserId: "board-user",
            resolvedAt: new Date().toISOString(),
          }],
        },
      },
    ]);
  }, 30_000);

  afterAll(async () => temporary?.cleanup());

  it("projects supported typed responses through the authorized interaction service", async () => {
    await expect(materializeNativeInteractionResponses({
      db,
      companyId,
      issueId,
      runId,
      agentId,
      interactionIds: [questionsId, confirmationId, suggestedTasksId, checkboxId, itemVerdictsId],
    })).resolves.toEqual([
      {
        interactionId: confirmationId,
        kind: "request_confirmation",
        response: { status: "accepted", result: { version: 1, outcome: "accepted" } },
      },
      {
        interactionId: questionsId,
        kind: "ask_user_questions",
        response: {
          status: "answered",
          result: {
            version: 1,
            answers: [{ questionId: "choice", optionIds: ["safe"] }],
            summaryMarkdown: [
              "Resolved questions and answers:",
              "- Which path?: Safe",
            ].join("\n"),
          },
        },
      },
      {
        interactionId: suggestedTasksId,
        kind: "suggest_tasks",
        response: {
          status: "accepted",
          result: {
            version: 1,
            createdTasks: [{ clientKey: "calculator", issueId: "78000000-0000-4000-8000-000000000015" }],
            skippedClientKeys: [],
          },
        },
      },
      {
        interactionId: checkboxId,
        kind: "request_checkbox_confirmation",
        response: {
          status: "accepted",
          result: { version: 1, outcome: "accepted", selectedOptionIds: ["guide"] },
        },
      },
      {
        interactionId: itemVerdictsId,
        kind: "request_item_verdicts",
        response: {
          status: "pending",
          result: {
            version: 1,
            outcome: "resolved",
            complete: false,
            items: [{
              id: "one",
              verdict: "approve",
              resolvedByUserId: "board-user",
              resolvedAt: expect.any(String),
            }],
          },
        },
      },
    ]);
  });

  it("projects answered questions for legacy adapter wake prompts", async () => {
    await expect(materializeLegacyQuestionResponseWakeProjection({
      db,
      companyId,
      issueId,
      runId,
      agentId,
      interactionId: questionsId,
    })).resolves.toEqual({
      interactionId: questionsId,
      summaryMarkdown: [
        "Resolved questions and answers:",
        "- Which path?: Safe",
      ].join("\n"),
    });
  });

  it.each([
    [governedId, "native_interaction_governed_request_unsupported"],
    [selfApprovedId, "native_interaction_self_approval"],
  ])("fails closed for governed or self-approved interaction %s", async (interactionId, code) => {
    const error = await materializeNativeInteractionResponses({
      db,
      companyId,
      issueId,
      runId,
      agentId,
      interactionIds: [interactionId],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(NativeInteractionBridgeError);
    expect(error).toMatchObject({ code });
  });

  it("routes accepted package-result attention through live issue and interaction owners", async () => {
    const delegateId = "78000000-0000-4000-8000-000000000020";
    const outsideCompanyId = "78000000-0000-4000-8000-000000000021";
    const outsideAgentId = "78000000-0000-4000-8000-000000000022";
    await db.insert(companies).values({ id: outsideCompanyId, name: "Outside attention", issuePrefix: "NIO" });
    await db.insert(agents).values([
      {
        id: delegateId,
        companyId,
        name: "Native attention delegate",
        adapterType: "codex_local",
        status: "idle",
      },
      {
        id: outsideAgentId,
        companyId: outsideCompanyId,
        name: "Outside attention delegate",
        adapterType: "codex_local",
        status: "idle",
      },
    ]);

    const scenarios = [
      {
        key: "agent",
        issueId: "78000000-0000-4000-8000-000000000023",
        runId: "78000000-0000-4000-8000-000000000024",
        contractId: "78000000-0000-4000-8000-000000000025",
        disposition: "yielded" as const,
        request: {
          id: "attention-agent",
          requestedCapability: "domain_expertise",
          summary: "Delegate a same-company native investigation",
          target: { ownerClass: "agent", agentId: delegateId, companyId },
        },
      },
      {
        key: "human",
        issueId: "78000000-0000-4000-8000-000000000026",
        runId: "78000000-0000-4000-8000-000000000027",
        contractId: "78000000-0000-4000-8000-000000000028",
        disposition: "needs_review" as const,
        request: {
          id: "attention-human",
          requestedCapability: "subjective_decision",
          requiredAuthority: "board",
          summary: "Choose the acceptable native result",
          target: { ownerClass: "board_user", companyId },
        },
      },
      {
        key: "cross-company",
        issueId: "78000000-0000-4000-8000-000000000029",
        runId: "78000000-0000-4000-8000-000000000030",
        contractId: "78000000-0000-4000-8000-000000000031",
        disposition: "yielded" as const,
        request: {
          id: "attention-cross-company",
          requestedCapability: "domain_expertise",
          summary: "Reject an outside-company native delegate",
          target: { ownerClass: "agent", agentId: outsideAgentId, companyId: outsideCompanyId },
        },
      },
    ];

    for (const scenario of scenarios) {
      const contractSha = `attention-contract:${scenario.key}`;
      await db.insert(issues).values({
        id: scenario.issueId,
        companyId,
        title: `Native attention ${scenario.key}`,
        status: "in_progress",
        assigneeAgentId: agentId,
        workMode: "standard",
      });
      await db.insert(completionContracts).values({
        id: scenario.contractId,
        companyId,
        issueId: scenario.issueId,
        revision: 1,
        schemaVersion: "paperclip.completion-contract.v1",
        policyVersion: "phase6-v1",
        risk: "standard",
        completionAuthority: "server_arbiter",
        incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: { revision: "attention-v1", objective: scenario.key, criteria: [{ id: "objective" }] },
        canonicalSha256: contractSha,
        createdByActorType: "system",
        createdByActorId: "test",
      });
      await db.insert(heartbeatRuns).values({
        id: scenario.runId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolverVersion: "phase6-v1",
        runtimeModeReason: "eligible_opt_in",
        runtimeModeResolvedAt: new Date(),
        nativeIssueId: scenario.issueId,
        nativeSessionId: scenario.runId,
        runnerInstanceId: scenario.contractId,
        completionContractId: scenario.contractId,
        completionContractSha256: contractSha,
        contextSnapshot: { issueId: scenario.issueId },
      });
      const port = new PaperclipControlPlanePort(db, {
        companyId,
        issueId: scenario.issueId,
        runId: scenario.runId,
        agentId,
        sessionId: scenario.runId,
        completionContractId: scenario.contractId,
        completionContractSha256: contractSha,
        sourceInstanceId: scenario.contractId,
        controlPlaneSourceInstanceId: `control:${scenario.key}`,
      });
      await port.completeRun({
        result: {
          schema: "paperclip.run_result.v1",
          reportedWorkDisposition: scenario.disposition,
          summary: `Native attention ${scenario.key}`,
          completionClaim: {
            contractRevision: "attention-v1",
            objectiveSatisfied: false,
            criteria: [{ criterionId: "objective", status: "unknown", evidenceRefs: [] }],
            remainingWork: [{ description: "Resolve attention", blocksCompletion: true }],
          },
          evidence: [],
          verification: [{ commandOrCheck: "attention", status: "not_run" }],
          attentionRequests: [scenario.request],
          artifacts: [],
          ...(scenario.disposition === "yielded" ? {
            continuation: {
              kind: "response_wake" as const,
              summary: "Resume after attention",
              idempotencyKey: `attention:${scenario.key}`,
            },
          } : {}),
        },
        terminal: {
          schema: "paperclip.prp.terminal.v1",
          turnTerminalState: "completed",
          runTerminalState: "succeeded",
          reportedWorkDisposition: scenario.disposition,
        },
        turnId: `turn:${scenario.key}`,
      });
      await finalizeNativeRun({
        db,
        runId: scenario.runId,
        workspaceFinalizeStatus: "succeeded",
        projectRunStatus: true,
      });
    }

    const delegated = await db.select().from(issues).where(and(
      eq(issues.parentId, scenarios[0]!.issueId),
      eq(issues.companyId, companyId),
    ));
    expect(delegated).toEqual([]);
    const agentInteractions = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, scenarios[0]!.issueId));
    expect(agentInteractions).toEqual([
      expect.objectContaining({
        kind: "request_confirmation",
        status: "pending",
        sourceRunId: scenarios[0]!.runId,
        addresseeAgentId: delegateId,
      }),
    ]);
    const humanInteractions = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, scenarios[1]!.issueId));
    expect(humanInteractions).toEqual([
      expect.objectContaining({ kind: "request_confirmation", status: "pending", sourceRunId: scenarios[1]!.runId }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.id, scenarios[0]!.issueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_review" }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.id, scenarios[1]!.issueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_review" }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.parentId, scenarios[2]!.issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, scenarios[2]!.issueId))).resolves.toEqual([]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scenarios[2]!.runId))).resolves.toEqual([
      expect.objectContaining({ status: "succeeded", nativePhase: "committed" }),
    ]);

    for (const scenario of scenarios) {
      const assessments = await db.select().from(workAssessments)
        .where(eq(workAssessments.issueId, scenario.issueId));
      expect(assessments.map((row) => row.triggerKind)).toEqual(["native_result"]);
      const decisions = await db.select().from(statusDecisions)
        .where(eq(statusDecisions.issueId, scenario.issueId));
      expect(decisions).toHaveLength(1);
      const effects = await db.select().from(statusDecisionEffects)
        .where(eq(statusDecisionEffects.decisionId, decisions[0]!.id));
      expect(effects.length).toBeGreaterThan(0);
      await expect(db.select().from(activityLog).where(and(
        eq(activityLog.entityId, scenario.issueId),
        eq(activityLog.runId, scenario.runId),
      ))).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ actorId: "native-status-committer" }),
      ]));
      await expect(db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, scenario.runId))).resolves.toEqual([
        expect.objectContaining({ assessmentId: decisions[0]!.assessmentId, decisionId: decisions[0]!.id }),
      ]);
    }
  }, 30_000);

  it("commits duplicate and stale attention as replay-stable zero-decision audit outcomes", async () => {
    const seedAuditRun = async (input: {
      label: string;
      requests: Record<string, unknown>[];
      interactions: Array<typeof issueThreadInteractions.$inferInsert>;
    }) => {
      const localIssueId = randomUUID();
      const localRunId = randomUUID();
      const localContractId = randomUUID();
      const contractSha = `audit-contract:${input.label}`;
      await db.insert(issues).values({
        id: localIssueId,
        companyId,
        title: `Audit-only native attention ${input.label}`,
        status: "in_progress",
        assigneeAgentId: agentId,
        workMode: "standard",
      });
      await db.insert(completionContracts).values({
        id: localContractId,
        companyId,
        issueId: localIssueId,
        revision: 1,
        schemaVersion: "paperclip.completion-contract.v1",
        policyVersion: "phase6-v1",
        risk: "standard",
        completionAuthority: "server_arbiter",
        incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: {
          revision: "audit-v1",
          objective: "Retain superseded attention for audit",
          criteria: [{ id: "objective", requirement: "Preserve the authoritative issue state" }],
        },
        canonicalSha256: contractSha,
        createdByActorType: "system",
        createdByActorId: "test",
      });
      await db.insert(heartbeatRuns).values({
        id: localRunId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolverVersion: "phase6-v1",
        runtimeModeReason: "eligible_opt_in",
        runtimeModeResolvedAt: new Date(),
        nativeIssueId: localIssueId,
        nativeSessionId: localRunId,
        runnerInstanceId: localContractId,
        completionContractId: localContractId,
        completionContractSha256: contractSha,
        contextSnapshot: { issueId: localIssueId },
      });
      if (input.interactions.length > 0) {
        await db.insert(issueThreadInteractions).values(input.interactions.map((interaction) => ({
          ...interaction,
          companyId: interaction.companyId ?? companyId,
          issueId: interaction.issueId ?? localIssueId,
        })));
      }
      const port = new PaperclipControlPlanePort(db, {
        companyId,
        issueId: localIssueId,
        runId: localRunId,
        agentId,
        sessionId: localRunId,
        completionContractId: localContractId,
        completionContractSha256: contractSha,
        sourceInstanceId: localContractId,
        controlPlaneSourceInstanceId: `audit-control:${input.label}`,
      });
      await port.completeRun({
        result: {
          schema: "paperclip.run_result.v1",
          reportedWorkDisposition: "yielded",
          summary: `Audit-only native attention ${input.label}`,
          completionClaim: {
            contractRevision: "audit-v1",
            objectiveSatisfied: false,
            criteria: [{ criterionId: "objective", status: "unknown", evidenceRefs: [] }],
            remainingWork: [{ description: "The canonical request remains authoritative", blocksCompletion: true }],
          },
          evidence: [],
          verification: [{ commandOrCheck: "audit-only attention", status: "not_run" }],
          attentionRequests: input.requests,
          artifacts: [],
          continuation: {
            kind: "response_wake",
            summary: "Wait for the canonical request",
            idempotencyKey: `audit-only:${input.label}`,
          },
        },
        terminal: {
          schema: "paperclip.prp.terminal.v1",
          turnTerminalState: "completed",
          runTerminalState: "succeeded",
          reportedWorkDisposition: "yielded",
        },
        turnId: `audit-turn:${input.label}`,
      });
      return { issueId: localIssueId, runId: localRunId };
    };

    const cases = ["duplicate", "stale", "mixed"] as const;
    for (const label of cases) {
      const canonicalId = randomUUID();
      const duplicateId = randomUUID();
      const staleId = randomUUID();
      const duplicateRequest = {
        id: `audit:${label}:duplicate`,
        requestedCapability: "duplicate",
        requiredAuthority: "agent",
        target: { ownerClass: "current_agent", companyId },
        summary: `Duplicate attention ${label}`,
        responseState: "none",
        targetInteractionId: duplicateId,
        canonicalRequestId: canonicalId,
      };
      const staleRequest = {
        id: `audit:${label}:stale`,
        requestedCapability: "context_lookup",
        requiredAuthority: "agent",
        target: { ownerClass: "current_agent", companyId },
        summary: `Stale attention ${label}`,
        responseState: "stale",
        targetInteractionId: staleId,
      };
      const requests = label === "duplicate"
        ? [duplicateRequest]
        : label === "stale" ? [staleRequest] : [duplicateRequest, staleRequest];
      const interactions: Array<typeof issueThreadInteractions.$inferInsert> = [];
      if (label !== "stale") {
        interactions.push(
          {
            id: canonicalId,
            kind: "request_confirmation",
            status: "pending",
            payload: { version: 1, prompt: `Canonical ${label}` },
          },
          {
            id: duplicateId,
            kind: "request_confirmation",
            status: "expired",
            resolvedAt: new Date(),
            payload: { version: 1, prompt: `Duplicate ${label}` },
            result: { version: 1, outcome: "superseded_by_newer_request", supersededByInteractionId: canonicalId },
          },
        );
      }
      if (label !== "duplicate") {
        interactions.push({
          id: staleId,
          kind: "request_confirmation",
          status: "expired",
          resolvedAt: new Date(),
          payload: { version: 1, prompt: `Stale ${label}` },
          result: { version: 1, outcome: "superseded_by_comment", commentId: randomUUID() },
        });
      }
      const seeded = await seedAuditRun({ label, requests, interactions });
      const finalized = await finalizeNativeRun({
        db,
        runId: seeded.runId,
        workspaceFinalizeStatus: "succeeded",
        projectRunStatus: true,
      });
      expect(finalized).toMatchObject({ phase: "committed", decisionId: expect.any(String) });
      const finalDecisionId = finalized.decisionId;

      await expect(db.select().from(issues).where(eq(issues.id, seeded.issueId))).resolves.toEqual([
        expect.objectContaining({
          status: label === "stale" ? "in_progress" : "in_review",
          statusVersion: 1,
          lastStatusDecisionId: expect.any(String),
        }),
      ]);
      await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId))).resolves.toEqual([
        expect.objectContaining({
          status: "succeeded",
          nativePhase: "committed",
          resultJson: expect.objectContaining({
            finalizationPhase: "committed",
            decisionId: expect.any(String),
            authoritativeDecision: label === "stale" ? "in_progress" : "in_review",
            ignoredAttentionRequests: expect.any(Array),
          }),
        }),
      ]);
      await expect(db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, seeded.runId))).resolves.toEqual([
        expect.objectContaining({ phase: "committed", decisionId: expect.any(String), failureCode: null }),
      ]);
      await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId))).resolves.toHaveLength(1);
      await expect(db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.issueId, seeded.issueId)))
        .resolves.not.toHaveLength(0);
      const issueWakeups = (await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId)))
        .filter((request) => (request.payload as Record<string, unknown> | null)?.issueId === seeded.issueId);
      if (label === "stale") {
        expect(issueWakeups).toEqual([
          expect.objectContaining({ payload: expect.objectContaining({ issueId: seeded.issueId }) }),
        ]);
      } else {
        // Duplicate actionable attention is owned by the review interaction;
        // it must not wake the agent before that human decision is resolved.
        expect(issueWakeups).toEqual([]);
      }

      const beforeReplay = await db.select({
        id: issueThreadInteractions.id,
        summary: issueThreadInteractions.summary,
        updatedAt: issueThreadInteractions.updatedAt,
      }).from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.issueId, seeded.issueId),
      ));
      const assessmentCount = await db.select().from(workAssessments)
        .where(eq(workAssessments.runId, seeded.runId)).then((rows) => rows.length);
      await expect(finalizeNativeRun({
        db,
        runId: seeded.runId,
        workspaceFinalizeStatus: "succeeded",
        projectRunStatus: true,
      })).resolves.toMatchObject({ phase: "committed", decisionId: finalDecisionId });
      const afterReplay = await db.select({
        id: issueThreadInteractions.id,
        summary: issueThreadInteractions.summary,
        updatedAt: issueThreadInteractions.updatedAt,
      }).from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, seeded.issueId));
      expect(afterReplay).toEqual(beforeReplay);
      await expect(db.select().from(workAssessments)
        .where(eq(workAssessments.runId, seeded.runId)).then((rows) => rows.length)).resolves.toBe(assessmentCount);
      const coordinatorBeforeCommittedReplay = await db.select({ attempt: nativeRunFinalizations.attempt })
        .from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seeded.runId))
        .then((rows) => rows[0] ?? null);
      await expect(finalizeNativeRun({
        db,
        runId: seeded.runId,
        workspaceFinalizeStatus: "succeeded",
        projectRunStatus: true,
      })).resolves.toMatchObject({ phase: "committed", decisionId: finalDecisionId });
      await expect(db.select({ attempt: nativeRunFinalizations.attempt })
        .from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seeded.runId))
        .then((rows) => rows[0] ?? null)).resolves.toEqual(coordinatorBeforeCommittedReplay);
    }

    const outsideCompanyId = randomUUID();
    const outsideIssueId = randomUUID();
    const outsideInteractionId = randomUUID();
    await db.insert(companies).values({ id: outsideCompanyId, name: "Outside audit target", issuePrefix: "OAT" });
    await db.insert(issues).values({
      id: outsideIssueId,
      companyId: outsideCompanyId,
      title: "Outside audit target",
      status: "in_progress",
      workMode: "standard",
    });
    await db.insert(issueThreadInteractions).values({
      id: outsideInteractionId,
      companyId: outsideCompanyId,
      issueId: outsideIssueId,
      kind: "request_confirmation",
      status: "expired",
      resolvedAt: new Date(),
      payload: { version: 1, prompt: "Outside stale response" },
      result: { version: 1, outcome: "superseded_by_comment", commentId: randomUUID() },
    });
    for (const [label, targetInteractionId] of [
      ["missing", randomUUID()],
      ["cross-company", outsideInteractionId],
    ] as const) {
      const seeded = await seedAuditRun({
        label: `invalid-${label}`,
        requests: [{
          id: `audit:invalid:${label}`,
          requestedCapability: "context_lookup",
          requiredAuthority: "agent",
          target: { ownerClass: "current_agent", companyId },
          summary: `Invalid audit target ${label}`,
          responseState: "stale",
          targetInteractionId,
        }],
        interactions: [],
      });
      await expect(finalizeNativeRun({
        db,
        runId: seeded.runId,
        workspaceFinalizeStatus: "succeeded",
        projectRunStatus: true,
      })).resolves.toMatchObject({ phase: "committed", failureCode: null });
      await expect(db.select().from(issues).where(eq(issues.id, seeded.issueId))).resolves.toEqual([
        expect.objectContaining({ status: "in_progress", statusVersion: 1, lastStatusDecisionId: expect.any(String) }),
      ]);
      await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId))).resolves.toHaveLength(1);
      await expect(db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, seeded.runId)).then((rows) => rows[0]?.resultJson)).resolves.toEqual(
        expect.objectContaining({ ignoredAttentionRequests: expect.any(Array) }),
      );
    }
    await expect(db.select({ summary: issueThreadInteractions.summary })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, outsideInteractionId))).resolves.toEqual([{ summary: null }]);
  }, 30_000);
});
