import { describe, expect, it } from "vitest";
import { buildCompactWorkingStatePacket, isStaleCompactWorkingStatePacket } from "../services/compact-working-state.js";

function validSameRoleCompactPacket(overrides: Record<string, unknown> = {}) {
  return {
    sourceRunId: "92a19da5-0000-0000-0000-000000000000",
    sourceSessionId: "4bb94f0e",
    acceptance: [
      {
        id: "AC1",
        text: "Resident-window telemetry is persisted on heartbeat runs.",
        status: "pending",
        assertedBy: "agent",
        verified: false,
        evidence: [],
      },
    ],
    changes: { files: [], commits: [] },
    tests: { written: [], runs: [] },
    requiredHandoff: { required: false, to: null, status: "in_progress", reason: null },
    artifacts: [{ kind: "run_log", ref: "paperclip:run:92a19da5:log" }],
    rawTranscriptRefs: [{ ref: "paperclip:run:92a19da5:transcript", replayByDefault: false }],
    ...overrides,
  };
}

function validBuilderInput(overrides: Record<string, unknown> = {}) {
  const packet = validSameRoleCompactPacket();
  return {
    issue: {
      identifier: "PB-81",
      id: "8b5a9a0b-0000-0000-0000-000000000000",
      objective: "Implement the scoped fix for PB-81.",
    },
    currentRun: { id: "92a19da5-0000-0000-0000-000000000000" },
    persistedSession: { id: "4bb94f0e" },
    currentAgent: { role: "engineer", name: "pipeline-engineer" },
    stage: "implementation",
    selfReport: {
      from: "engineer",
      to: "engineer",
      workingNotes: "Current approach: keep the change scoped to telemetry parsing.",
      acceptance: packet.acceptance,
      tests: packet.tests,
      blocker: null,
      requiredHandoff: packet.requiredHandoff,
      next: "Continue implementation from the listed working notes and acceptance state.",
    },
    observedChanges: packet.changes,
    artifacts: packet.artifacts,
    rawTranscriptRefs: packet.rawTranscriptRefs,
    ...overrides,
  };
}

describe("compact working-state builder provenance", () => {
  it("[BLIND] derives same-role from/to from the current agent role, not self-report", () => {
    const packet = buildCompactWorkingStatePacket(validBuilderInput({
      currentAgent: { role: "engineer", name: "pipeline-engineer" },
      selfReport: {
        ...(validBuilderInput().selfReport as Record<string, unknown>),
        from: "planner",
        to: "planner",
      },
    }));

    expect(packet.from).toBe("engineer");
    expect(packet.to).toBe("engineer");
  });

  it("[BLIND] does not derive continuation role from agent.name", () => {
    const packet = buildCompactWorkingStatePacket(validBuilderInput({
      currentAgent: { role: "code-reviewer", name: "engineer" },
      selfReport: {
        ...(validBuilderInput().selfReport as Record<string, unknown>),
        from: "engineer",
        to: "engineer",
      },
    }));

    expect(packet.from).toBe("code-reviewer");
    expect(packet.to).toBe("code-reviewer");
  });

  it("[BLIND] builds sourceSessionId from the persisted session identity Paperclip would resume", () => {
    const packet = buildCompactWorkingStatePacket(validBuilderInput({
      persistedSession: { id: "persisted-session-42" },
      artifacts: [{ kind: "run_log", ref: "paperclip:run:artifact-session-99:log" }],
    }));

    expect(packet.sourceSessionId).toBe("persisted-session-42");
  });

  it("[BLIND] stale checks compare first-class run and session ids, not artifact refs", () => {
    const packet = validSameRoleCompactPacket({
      sourceRunId: "run-a",
      sourceSessionId: "session-a",
      artifacts: [{ kind: "run_log", ref: "paperclip:run:different-run:log" }],
    });

    expect(isStaleCompactWorkingStatePacket(packet, {
      sourceRunId: "run-a",
      sourceSessionId: "session-a",
    })).toBe(false);
    expect(isStaleCompactWorkingStatePacket(packet, {
      sourceRunId: "run-a",
      sourceSessionId: "session-b",
    })).toBe(true);
  });

  it("[BLIND] lets the builder reject empty workingNotes for an in-flight state that requires notes", () => {
    expect(() => buildCompactWorkingStatePacket(validBuilderInput({
      requireWorkingNotes: true,
      selfReport: {
        ...(validBuilderInput().selfReport as Record<string, unknown>),
        workingNotes: "",
      },
    }))).toThrow(/workingNotes|self-report/i);
  });

  it("[BLIND] fails build when semantic self-report is missing and no machine source derives it", () => {
    const missingNotes = validBuilderInput();
    delete (missingNotes.selfReport as Record<string, unknown>).workingNotes;
    expect(() => buildCompactWorkingStatePacket(missingNotes)).toThrow(/workingNotes|self-report/i);

    const missingStage = validBuilderInput({ stage: undefined });
    delete (missingStage.selfReport as Record<string, unknown>).stage;
    expect(() => buildCompactWorkingStatePacket(missingStage)).toThrow(/stage|self-report/i);
  });
});
