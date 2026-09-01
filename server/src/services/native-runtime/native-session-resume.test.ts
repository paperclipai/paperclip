import { describe, expect, it } from "vitest";
import { canonicalNativeRuntimeContextDigest } from "../../vendor/paperclip-runner/index.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { rebindNativeSessionCheckpoint } from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const issueId = "20000000-0000-4000-8000-000000000002";
const agentId = "30000000-0000-4000-8000-000000000003";
const previousRunId = "40000000-0000-4000-8000-000000000004";
const currentRunId = "50000000-0000-4000-8000-000000000005";
const normalizedSessionId = "60000000-0000-4000-8000-000000000006";

function execution(runId: string, cwd = "/workspace") {
  return buildNativeExecutionInput({
    companyId,
    runId,
    issue: { id: issueId, identifier: "DOT-2", title: "Test", description: null, workMode: "standard" },
    taskPrompt: "Only the current turn",
    agentId,
    workspace: { id: runId, cwd, repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId,
    provider: "codex",
    completionContract: {
      id: "70000000-0000-4000-8000-000000000007",
      sha256: `sha256:${"a".repeat(64)}`,
      schemaVersion: "paperclip.run-result.v1",
      contract: {
        revision: "1",
        objective: "Test session resumption",
        criteria: [{ id: "objective", requirement: "Answer the current turn" }],
      },
    },
    runtimeContext: nativeRuntimeContextFixture(),
  });
}

function planningExecution(runId: string, revisionId: string) {
  return buildNativeExecutionInput({
    companyId,
    runId,
    issue: { id: issueId, identifier: "DOT-2", title: "Test", description: null, workMode: "planning" },
    taskPrompt: "Revise the plan",
    agentId,
    workspace: { id: runId, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId,
    provider: "codex",
    executionMode: "plan",
    planningContext: {
      documentId: "80000000-0000-4000-8000-000000000008",
      baseRevisionId: revisionId,
      baseRevisionNumber: revisionId.endsWith("9") ? 9 : 8,
      markdown: `Plan at ${revisionId}`,
      sha256: `sha256:${"b".repeat(64)}`,
      reviewContext: {},
    },
    completionContract: execution(runId).completionContract,
    runtimeContext: nativeRuntimeContextFixture(),
  });
}

function previousRun(overrides: Record<string, unknown> = {}) {
  return {
    id: previousRunId,
    companyId,
    agentId,
    nativeSessionId: normalizedSessionId,
    runnerProfileJson: {
      nativeExecutionInput: execution(previousRunId),
      sessionCheckpoint: {
        backendKind: "runner",
        driverKind: "codex_app_server",
        sessionId: "provider-thread-123",
        providerSessionId: "provider-thread-123",
        cursor: "42",
        identity: { runId: previousRunId, sessionId: normalizedSessionId, companyId, issueId, agentId },
        semanticResult: { schema: "paperclip.run-result.v1", reportedWorkDisposition: "done", summary: "old" },
        terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" },
        activeTurnId: "old-turn",
        terminalTurns: [{ turnId: "old-turn", state: "completed" }],
        pendingRuntimeRequests: [{ requestId: "old-request" }],
        lineage: [{ threadId: "provider-thread-123" }],
      },
      ...overrides,
    },
  };
}

describe("rebindNativeSessionCheckpoint", () => {
  it("retains provider identity but clears prior turn and event state", () => {
    const rebound = rebindNativeSessionCheckpoint({
      previousRun: previousRun(),
      currentExecution: execution(currentRunId),
    });
    expect(rebound).toMatchObject({
      sessionId: "provider-thread-123",
      providerSessionId: "provider-thread-123",
      driverKind: "codex_app_server",
      cursor: null,
      semanticResult: null,
      terminal: null,
      activeTurnId: null,
      terminalTurns: [],
      pendingRuntimeRequests: [],
      providerRecoveryPolicy: "allow_replacement_after_resume_failure",
      identity: { runId: currentRunId, sessionId: normalizedSessionId, companyId, issueId, agentId },
    });
  });

  it("allows a provider replacement only after a durable response wake", () => {
    const source = previousRun();
    const profile = source.runnerProfileJson as Record<string, unknown>;
    const checkpoint = profile.sessionCheckpoint as Record<string, unknown>;
    checkpoint.semanticResult = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary: "Waiting for a response.",
      continuation: {
        kind: "response_wake",
        idempotencyKey: "interaction-response:one",
      },
    };

    expect(
      rebindNativeSessionCheckpoint({
        previousRun: source,
        currentExecution: execution(currentRunId),
      }),
    ).toMatchObject({
      providerRecoveryPolicy: "allow_replacement_after_governed_wait",
      semanticResult: null,
      activeTurnId: null,
    });
  });

  it("refuses to resume when the workspace changes", () => {
    expect(rebindNativeSessionCheckpoint({
      previousRun: previousRun(),
      currentExecution: execution(currentRunId, "/different-workspace"),
    })).toBeNull();
  });

  it("rotates when assigned context changes but permits a fresh run-scoped MCP binding", () => {
    const reboundCredential = execution(currentRunId);
    reboundCredential.runtimeContext.mcp.bindingId = "native-mcp:fresh-run";
    expect(rebindNativeSessionCheckpoint({
      previousRun: previousRun(),
      currentExecution: reboundCredential,
    })).not.toBeNull();

    const changedAssignment = execution(currentRunId);
    const withoutAggregate = {
      prompt: changedAssignment.runtimeContext.prompt,
      instructions: changedAssignment.runtimeContext.instructions,
      skills: changedAssignment.runtimeContext.skills,
      mcp: {
        assignmentSetId: `sha256:${"1".repeat(64)}`,
        digest: "1".repeat(64),
        bindingId: "native-mcp:fresh-run",
      },
    };
    changedAssignment.runtimeContext = {
      ...withoutAggregate,
      aggregateDigest: canonicalNativeRuntimeContextDigest(withoutAggregate),
    };
    expect(rebindNativeSessionCheckpoint({
      previousRun: previousRun(),
      currentExecution: changedAssignment,
    })).toBeNull();
  });

  it("refuses a checkpoint whose prior-run binding was rewritten", () => {
    const source = previousRun();
    const profile = source.runnerProfileJson as Record<string, unknown>;
    const checkpoint = profile.sessionCheckpoint as Record<string, unknown>;
    checkpoint.identity = { ...(checkpoint.identity as Record<string, unknown>), runId: currentRunId };
    expect(rebindNativeSessionCheckpoint({ previousRun: source, currentExecution: execution(currentRunId) })).toBeNull();
  });

  it("reuses plan mode across canonical revisions but never across a mode change", () => {
    const source = previousRun({ nativeExecutionInput: planningExecution(previousRunId, "revision-8") });
    expect(rebindNativeSessionCheckpoint({
      previousRun: source,
      currentExecution: planningExecution(currentRunId, "revision-9"),
    })).not.toBeNull();
    expect(rebindNativeSessionCheckpoint({
      previousRun: source,
      currentExecution: execution(currentRunId),
    })).toBeNull();
  });
});

describe("buildNativeExecutionInput wake projection", () => {
  it("writes native v4 and pins every provider's complete effective configuration", () => {
    const common = {
      companyId,
      runId: currentRunId,
      issue: { id: issueId, identifier: "DOT-4", title: "Permissions", description: null, workMode: "standard" },
      taskPrompt: "Verify permissions",
      agentId,
      workspace: { id: currentRunId, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId,
      completionContract: execution(currentRunId).completionContract,
      runtimeContext: nativeRuntimeContextFixture(),
    } as const;
    const codex = buildNativeExecutionInput({
      ...common,
      provider: "codex",
      codexApprovalPolicy: "on-request",
    });
    const opencode = buildNativeExecutionInput({
      ...common,
      provider: "opencode",
      model: "openrouter/z-ai/glm-5.2",
      opencodePermissionMode: "ask",
    });
    const acpx = buildNativeExecutionInput({
      ...common,
      provider: "acpx",
      acpxAgent: "claude",
      model: "claude-sonnet-5",
      acpxPermissionMode: "deny-all",
    });
    const defaultOpenCode = buildNativeExecutionInput({
      ...common,
      provider: "opencode",
      model: "openrouter/z-ai/glm-5.2",
    });
    const defaultAcpx = buildNativeExecutionInput({
      ...common,
      provider: "acpx",
      model: "gpt-5.6-sol",
    });

    expect(codex).toMatchObject({
      schema: "paperclip.native-execution-input.v4",
      provider: { kind: "codex", approvalPolicy: "on-request" },
    });
    expect(opencode).toMatchObject({
      schema: "paperclip.native-execution-input.v4",
      provider: { kind: "opencode", permissionMode: "ask" },
    });
    expect(acpx).toMatchObject({
      schema: "paperclip.native-execution-input.v4",
      provider: { kind: "acpx", permissionMode: "deny-all" },
    });
    expect(defaultOpenCode).toMatchObject({
      provider: { kind: "opencode", permissionMode: "ask" },
    });
    expect(defaultAcpx).toMatchObject({
      provider: {
        kind: "acpx",
        agent: "codex",
        permissionMode: "approve-reads",
      },
    });
    expect(JSON.stringify([codex, opencode, acpx]))
      .not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|PAPERCLIP_API_KEY/);
  });

  it("places child completion summaries in the closed provider prompt", () => {
    const input = buildNativeExecutionInput({
      companyId,
      runId: currentRunId,
      issue: {
        id: issueId,
        identifier: "DOT-146",
        title: "Finish after child handoff",
        description: "Use the child result.",
        workMode: "standard",
      },
      taskPrompt: "Paperclip task context:\n- Issue: DOT-146",
      wakePayload: {
        reason: "issue_children_completed",
        issue: {
          id: issueId,
          identifier: "DOT-146",
          title: "Finish after child handoff",
          description: "Use the child result.",
          status: "in_progress",
          priority: "medium",
          workMode: "standard",
        },
        childIssueSummaries: [{
          id: "child-147",
          identifier: "DOT-147",
          title: "Build utility",
          status: "done",
          summary: "Created three files and passed 7/7 tests.",
        }],
        childIssueSummaryTruncated: false,
        checkedOutByHarness: true,
      },
      resumedSession: true,
      agentId,
      workspace: {
        id: currentRunId,
        cwd: "/workspace",
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      normalizedSessionId,
      provider: "opencode",
      model: "openrouter/z-ai/glm-5.2",
      completionContract: {
        id: "70000000-0000-4000-8000-000000000007",
        sha256: `sha256:${"a".repeat(64)}`,
        schemaVersion: "paperclip.run-result.v1",
        contract: {
          revision: "1",
          objective: "Finish after the child",
          criteria: [{ id: "objective", requirement: "Report the child result" }],
        },
      },
      runtimeContext: nativeRuntimeContextFixture(),
    });

    expect(input.task.prompt).toContain("## Paperclip Resume Delta");
    expect(input.task.prompt).toContain("reason: issue_children_completed");
    expect(input.task.prompt).toContain("DOT-147 Build utility (done)");
    expect(input.task.prompt).toContain("Created three files and passed 7/7 tests.");
    expect(input.task.prompt).toContain("Paperclip task context:\n- Issue: DOT-146");
    expect(input.task.prompt).not.toContain("Use the child result.");
  });
});
