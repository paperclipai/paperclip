import { describe, expect, it } from "vitest";
import { createTestTelemetryCtx, makeEvent } from "./helpers.js";
import { METRIC_NAMES } from "../src/constants.js";
import {
  handleRunStartedMetrics,
  handleRunFinishedMetrics,
  handleRunFailedMetrics,
  handleRunCancelledMetrics,
  handleCostMetrics,
  handleIssueCreatedMetrics,
  handleIssueUpdatedMetrics,
  handleAgentStatusChangedMetrics,
  handleApprovalCreatedMetrics,
  handleApprovalDecidedMetrics,
  handleGenericMetrics,
} from "../src/telemetry/metrics-handlers.js";

describe("handleRunStartedMetrics", () => {
  it("increments the runs started counter with agent_id and invocation_source", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    const event = makeEvent("agent.run.started", {
      agentId: "agent-1",
      invocationSource: "assignment",
    });

    await handleRunStartedMetrics(event, ctx);

    const counter = meter._counters.get(METRIC_NAMES.agentRunsStarted);
    expect(counter).toBeDefined();
    expect(counter!.add).toHaveBeenCalledWith(1, {
      agent_id: "agent-1",
      agent_name: "unknown",
      invocation_source: "assignment",
    });
  });

  it("handles missing payload fields gracefully", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleRunStartedMetrics(makeEvent("agent.run.started", {}), ctx);

    const counter = meter._counters.get(METRIC_NAMES.agentRunsStarted);
    expect(counter!.add).toHaveBeenCalledWith(1, {
      agent_id: "",
      agent_name: "unknown",
      invocation_source: "",
    });
  });
});

describe("handleRunFinishedMetrics", () => {
  it("records duration histogram and GenAI operation duration", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    const event = makeEvent("agent.run.finished", {
      agentId: "agent-1",
      durationMs: 5000,
      provider: "claude_local",
      model: "claude-opus-4-20250514",
    });

    await handleRunFinishedMetrics(event, ctx);

    const durationHist = meter._histograms.get(METRIC_NAMES.agentRunDuration);
    expect(durationHist).toBeDefined();
    expect(durationHist!.record).toHaveBeenCalledWith(5000, {
      agent_id: "agent-1",
      agent_name: "unknown",
      status: "finished",
    });

    const genAIHist = meter._histograms.get("gen_ai.client.operation.duration");
    expect(genAIHist).toBeDefined();
    expect(genAIHist!.record).toHaveBeenCalledWith(5, {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-opus-4-20250514",
    });
  });

  it("skips recording when durationMs is null", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleRunFinishedMetrics(makeEvent("agent.run.finished", {}), ctx);

    expect(meter._histograms.size).toBe(0);
  });
});

describe("handleRunFailedMetrics", () => {
  it("increments error counter", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleRunFailedMetrics(
      makeEvent("agent.run.failed", { agentId: "a-1", error: "timeout" }),
      ctx,
    );

    const counter = meter._counters.get(METRIC_NAMES.agentRunErrors);
    expect(counter!.add).toHaveBeenCalledWith(1, {
      agent_id: "a-1",
      agent_name: "unknown",
      error: "timeout",
    });
  });
});

describe("handleRunCancelledMetrics", () => {
  it("increments generic events counter", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleRunCancelledMetrics(
      makeEvent("agent.run.cancelled"),
      ctx,
    );

    const counter = meter._counters.get(METRIC_NAMES.eventsTotal);
    expect(counter!.add).toHaveBeenCalledWith(1, {
      event_type: "agent.run.cancelled",
    });
  });
});

describe("handleCostMetrics", () => {
  it("records token counters, cost counter, and GenAI token usage histogram", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleCostMetrics(
      makeEvent("cost_event.created", {
        agentId: "a-1",
        provider: "claude_local",
        model: "claude-sonnet-4-20250514",
        inputTokens: 1000,
        outputTokens: 200,
        costCents: 3.5,
        billingType: "usage",
        biller: "anthropic",
      }),
      ctx,
    );

    // Paperclip-specific counters
    const inputCounter = meter._counters.get(METRIC_NAMES.tokensInput);
    expect(inputCounter!.add).toHaveBeenCalledWith(
      1000,
      expect.objectContaining({ agent_id: "a-1", provider: "anthropic" }),
    );

    const outputCounter = meter._counters.get(METRIC_NAMES.tokensOutput);
    expect(outputCounter!.add).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ model: "claude-sonnet-4-20250514" }),
    );

    const costCounter = meter._counters.get(METRIC_NAMES.costCents);
    expect(costCounter!.add).toHaveBeenCalledWith(
      3.5,
      expect.objectContaining({ billing_type: "usage" }),
    );

    // GenAI token usage histogram
    const tokenHist = meter._histograms.get("gen_ai.client.token.usage");
    expect(tokenHist).toBeDefined();
    expect(tokenHist!.record).toHaveBeenCalledTimes(2);
    expect(tokenHist!.record).toHaveBeenCalledWith(1000, {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-4-20250514",
      "gen_ai.token.type": "input",
    });
    expect(tokenHist!.record).toHaveBeenCalledWith(200, {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-4-20250514",
      "gen_ai.token.type": "output",
    });
  });

  it("skips null token/cost fields without error", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleCostMetrics(makeEvent("cost_event.created", {}), ctx);

    // Counters created but add never called for tokens/cost
    const inputCounter = meter._counters.get(METRIC_NAMES.tokensInput);
    expect(inputCounter!.add).not.toHaveBeenCalled();
  });
});

describe("handleIssueCreatedMetrics", () => {
  it("increments issues created counter", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleIssueCreatedMetrics(
      makeEvent("issue.created", { projectId: "proj-1", priority: "high" }),
      ctx,
    );

    const counter = meter._counters.get(METRIC_NAMES.issuesCreated);
    expect(counter!.add).toHaveBeenCalledWith(1, {
      project_id: "proj-1",
      priority: "high",
    });
  });
});

describe("handleIssueUpdatedMetrics", () => {
  it("increments transition counter on status change", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleIssueUpdatedMetrics(
      makeEvent("issue.updated", {
        status: "in_progress",
        previousStatus: "todo",
        projectId: "proj-1",
      }),
      ctx,
    );

    const counter = meter._counters.get(METRIC_NAMES.issueTransitions);
    expect(counter!.add).toHaveBeenCalledWith(1, {
      status: "in_progress",
      project_id: "proj-1",
    });
  });

  it("increments completion counter when status transitions to done", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleIssueUpdatedMetrics(
      makeEvent("issue.updated", {
        status: "done",
        previousStatus: "in_progress",
        projectId: "proj-1",
      }),
      ctx,
    );

    const completed = meter._counters.get(METRIC_NAMES.issuesCompleted);
    expect(completed!.add).toHaveBeenCalledWith(1, { project_id: "proj-1" });
  });

  it("does not increment completion counter when already done", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleIssueUpdatedMetrics(
      makeEvent("issue.updated", {
        status: "done",
        previousStatus: "done",
        projectId: "proj-1",
      }),
      ctx,
    );

    const completed = meter._counters.get(METRIC_NAMES.issuesCompleted);
    expect(completed).toBeUndefined();
  });
});

describe("handleAgentStatusChangedMetrics", () => {
  it("increments status change counter", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleAgentStatusChangedMetrics(
      makeEvent("agent.status_changed", { agentId: "a-1", status: "paused" }),
      ctx,
    );

    const counter = meter._counters.get(METRIC_NAMES.agentStatusChanges);
    expect(counter!.add).toHaveBeenCalledWith(1, {
      agent_id: "a-1",
      agent_name: "unknown",
      status: "paused",
    });
  });
});

describe("handleApprovalCreatedMetrics", () => {
  it("increments approval counter and stores pending state", async () => {
    const { ctx, meter, state } = createTestTelemetryCtx();
    await handleApprovalCreatedMetrics(
      makeEvent("approval.created", { companyId: "co-1" }),
      ctx,
    );

    const counter = meter._counters.get(METRIC_NAMES.approvalsCreated);
    expect(counter!.add).toHaveBeenCalledWith(1, { company_id: "co-1" });

    // State should store pending count = 1
    const stored = state._store.get("instance::approvals:pending:co-1");
    expect(stored).toBe(1);
  });

  it("increments existing pending count", async () => {
    const { ctx, state } = createTestTelemetryCtx();
    state._store.set("instance::approvals:pending:co-1", 3);

    await handleApprovalCreatedMetrics(
      makeEvent("approval.created", { companyId: "co-1" }),
      ctx,
    );

    expect(state._store.get("instance::approvals:pending:co-1")).toBe(4);
  });
});

describe("handleApprovalDecidedMetrics", () => {
  it("increments decided counter and decrements pending state", async () => {
    const { ctx, meter, state } = createTestTelemetryCtx();
    state._store.set("instance::approvals:pending:co-1", 2);

    await handleApprovalDecidedMetrics(
      makeEvent("approval.decided", { companyId: "co-1", decision: "approved" }),
      ctx,
    );

    const counter = meter._counters.get(METRIC_NAMES.approvalsDecided);
    expect(counter!.add).toHaveBeenCalledWith(1, {
      decision: "approved",
      company_id: "co-1",
    });

    expect(state._store.get("instance::approvals:pending:co-1")).toBe(1);
  });

  it("does not go below zero", async () => {
    const { ctx, state } = createTestTelemetryCtx();
    state._store.set("instance::approvals:pending:co-1", 0);

    await handleApprovalDecidedMetrics(
      makeEvent("approval.decided", { companyId: "co-1", decision: "rejected" }),
      ctx,
    );

    expect(state._store.get("instance::approvals:pending:co-1")).toBe(0);
  });
});

describe("handleGenericMetrics", () => {
  it("increments total events counter", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleGenericMetrics(makeEvent("activity.logged"), ctx);

    const counter = meter._counters.get(METRIC_NAMES.eventsTotal);
    expect(counter!.add).toHaveBeenCalledWith(1, {
      event_type: "activity.logged",
    });
  });
});
