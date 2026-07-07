import { describe, expect, it } from "vitest";
import type { CompanySkillTestRunStatus } from "@paperclipai/shared";
import {
  buildReRunRequest,
  evaluateRunGate,
  findOutputDocument,
  INLINE_INTERACTION_KINDS,
  isAgentSelectable,
  isInteractionAnswerable,
  isRunActive,
  isTerminalRunStatus,
  routeInteraction,
  runBadgeStatus,
  runOutputMode,
  runShortId,
  shouldPollRun,
  showRunErrorCard,
  testTaskLinkState,
} from "./skill-studio";

const ALL_STATUSES: CompanySkillTestRunStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

describe("run-status derivation", () => {
  it("classifies terminal vs non-terminal statuses", () => {
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("succeeded")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
  });

  it("polls only while non-terminal (V1 2s policy)", () => {
    expect(shouldPollRun("queued")).toBe(true);
    expect(shouldPollRun("running")).toBe(true);
    for (const status of ["succeeded", "failed", "cancelled"] as CompanySkillTestRunStatus[]) {
      expect(shouldPollRun(status)).toBe(false);
    }
  });

  it("isRunActive is the inverse of terminal", () => {
    for (const status of ALL_STATUSES) {
      expect(isRunActive({ status })).toBe(!isTerminalRunStatus(status));
    }
  });

  it("maps every status onto a StatusBadge status (D6)", () => {
    for (const status of ALL_STATUSES) {
      expect(runBadgeStatus(status)).toBe(status);
    }
  });

  it("shows an error card only for failed runs (cancelled has none)", () => {
    expect(showRunErrorCard("failed")).toBe(true);
    expect(showRunErrorCard("cancelled")).toBe(false);
    expect(showRunErrorCard("succeeded")).toBe(false);
    expect(showRunErrorCard("running")).toBe(false);
  });

  describe("output mode", () => {
    it("succeeded with output renders the output", () => {
      expect(runOutputMode({ status: "succeeded", outputBody: "# Result" })).toBe("output");
    });
    it("succeeded with no output renders none", () => {
      expect(runOutputMode({ status: "succeeded", outputBody: "" })).toBe("none");
      expect(runOutputMode({ status: "succeeded", outputBody: null })).toBe("none");
    });
    it("failed with partial output is a draft-at-failure", () => {
      expect(runOutputMode({ status: "failed", outputBody: "partial" })).toBe("draft");
    });
    it("cancelled with partial output is a draft-at-failure", () => {
      expect(runOutputMode({ status: "cancelled", outputBody: "partial" })).toBe("draft");
    });
    it("failed with no output renders none", () => {
      expect(runOutputMode({ status: "failed", outputBody: "   " })).toBe("none");
    });
    it("non-terminal with no output is pending, with output shows it streaming", () => {
      expect(runOutputMode({ status: "running", outputBody: "" })).toBe("pending");
      expect(runOutputMode({ status: "queued", outputBody: null })).toBe("pending");
      expect(runOutputMode({ status: "running", outputBody: "live" })).toBe("output");
    });
  });

  describe("test-task deep link state", () => {
    it("is enabled for a live harness issue", () => {
      expect(testTaskLinkState({ taskExpired: false, harnessIssue: { id: "i1" } })).toEqual({
        enabled: true,
        reason: null,
      });
    });
    it("is disabled when the task expired", () => {
      expect(testTaskLinkState({ taskExpired: true, harnessIssue: { id: "i1" } })).toEqual({
        enabled: false,
        reason: "Test task expired",
      });
    });
    it("is disabled when the harness issue was deleted", () => {
      expect(testTaskLinkState({ taskExpired: false, harnessIssue: null })).toEqual({
        enabled: false,
        reason: "Test task expired",
      });
    });
  });
});

describe("disabled-Run matrix", () => {
  const ready = { hasAgent: true, hasInput: true, skillFileCount: 3 };

  it("enables Run when agent + input + files are all present", () => {
    expect(evaluateRunGate(ready)).toEqual({ disabled: false, reason: null });
  });

  it("blocks on zero skill files first", () => {
    expect(evaluateRunGate({ ...ready, skillFileCount: 0 })).toEqual({
      disabled: true,
      reason: "This skill has no files to test",
    });
  });

  it("blocks when no agent is selected", () => {
    expect(evaluateRunGate({ ...ready, hasAgent: false })).toEqual({
      disabled: true,
      reason: "Pick an agent to run",
    });
  });

  it("blocks when the input is empty", () => {
    expect(evaluateRunGate({ ...ready, hasInput: false })).toEqual({
      disabled: true,
      reason: "Add or paste input text to run",
    });
  });

  it("blocks when a run is already in flight", () => {
    expect(evaluateRunGate({ ...ready, runInFlight: true })).toEqual({
      disabled: true,
      reason: "A run is already in progress",
    });
  });

  it("zero files takes priority over missing agent and input", () => {
    expect(
      evaluateRunGate({ hasAgent: false, hasInput: false, skillFileCount: 0 }).reason,
    ).toBe("This skill has no files to test");
  });

  it("missing agent takes priority over missing input", () => {
    expect(
      evaluateRunGate({ hasAgent: false, hasInput: false, skillFileCount: 2 }).reason,
    ).toBe("Pick an agent to run");
  });
});

describe("interaction inline-vs-fallback routing", () => {
  it("renders ask_user_questions and request_confirmation inline", () => {
    expect(routeInteraction("ask_user_questions")).toBe("inline");
    expect(routeInteraction("request_confirmation")).toBe("inline");
    expect(INLINE_INTERACTION_KINDS.has("ask_user_questions")).toBe(true);
  });

  it("routes every other kind to the fallback summary row", () => {
    for (const kind of [
      "suggest_tasks",
      "request_checkbox_confirmation",
      "request_board_approval",
      "some_future_kind",
    ]) {
      expect(routeInteraction(kind)).toBe("fallback");
    }
  });

  it("only answers inline interactions that are still pending", () => {
    expect(isInteractionAnswerable({ kind: "ask_user_questions", status: "pending" })).toBe(true);
    expect(isInteractionAnswerable({ kind: "ask_user_questions", status: "answered" })).toBe(false);
    expect(isInteractionAnswerable({ kind: "request_confirmation", status: "accepted" })).toBe(false);
    // Fallback kinds are never answerable inline even while pending.
    expect(isInteractionAnswerable({ kind: "suggest_tasks", status: "pending" })).toBe(false);
  });
});

describe("agent picker + run labels", () => {
  it("marks paused agents as unselectable", () => {
    expect(isAgentSelectable({ status: "active" })).toBe(true);
    expect(isAgentSelectable({ status: "idle" })).toBe(true);
    expect(isAgentSelectable({ status: "paused" })).toBe(false);
  });

  it("builds a short run id", () => {
    expect(runShortId({ id: "abcdef01-2345-6789-abcd-ef0123456789" })).toBe("#abcdef0");
  });

  it("finds the output document by the run's output key", () => {
    const detail = {
      outputDocumentKey: "output",
      documents: [
        { key: "notes", title: "Notes", updatedAt: new Date(), body: "n" },
        { key: "output", title: "Output", updatedAt: new Date(), body: "o" },
      ],
    };
    expect(findOutputDocument(detail)?.body).toBe("o");
    expect(findOutputDocument({ outputDocumentKey: "missing", documents: detail.documents })).toBeNull();
  });

  describe("buildReRunRequest", () => {
    it("reproduces a saved-input run from its own snapshots (never live picker state)", () => {
      const req = buildReRunRequest({
        agentId: "agent-9",
        inputId: "input-3",
        inputSnapshot: "snapshotted text",
        skillVersionId: "ver-7",
      });
      expect(req).toEqual({
        agentId: "agent-9",
        inputId: "input-3",
        content: undefined,
        skillVersionId: "ver-7",
      });
    });

    it("replays an ad-hoc run via its input snapshot as literal content", () => {
      const req = buildReRunRequest({
        agentId: "agent-1",
        inputId: null,
        inputSnapshot: "ad-hoc paste body",
        skillVersionId: "ver-2",
      });
      expect(req.inputId).toBeUndefined();
      expect(req.content).toBe("ad-hoc paste body");
      expect(req.agentId).toBe("agent-1");
      expect(req.skillVersionId).toBe("ver-2");
    });

    it("always carries the run's agent id so a re-run never posts a null agent", () => {
      const req = buildReRunRequest({
        agentId: "agent-42",
        inputId: null,
        inputSnapshot: "x",
        skillVersionId: "v",
      });
      expect(req.agentId).toBe("agent-42");
    });
  });
});
