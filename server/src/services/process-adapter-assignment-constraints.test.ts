import { describe, expect, it } from "vitest";
import {
  DEFAULT_HUMAN_ACTION_LOCK_RESTRICTED_ADAPTER_TYPES,
  PROCESS_ADAPTER_HUMAN_ACTION_LOCK_BLOCKED_REASON,
  checkProcessAdapterAutoAssignmentConstraint,
  resolveHumanActionLockRestrictedAdapterTypes,
} from "./process-adapter-assignment-constraints.js";

const baseInput = {
  adapterType: "process",
  currentRunId: "run-current",
  executionLockedAt: new Date("2026-08-05T00:00:00Z"),
  executionLockRunId: "run-other",
  hasPendingHumanAction: true,
};

describe("checkProcessAdapterAutoAssignmentConstraint", () => {
  it("blocks a process adapter from claiming an issue locked by another run and awaiting human action", () => {
    const result = checkProcessAdapterAutoAssignmentConstraint(baseInput);
    expect(result).toEqual({
      allowed: false,
      reason: PROCESS_ADAPTER_HUMAN_ACTION_LOCK_BLOCKED_REASON,
      adapterType: "process",
    });
  });

  it("allows an adapter type that is not in the restricted set", () => {
    const result = checkProcessAdapterAutoAssignmentConstraint({
      ...baseInput,
      adapterType: "claude_local",
    });
    expect(result).toEqual({ allowed: true });
  });

  it("allows claiming when the issue is not execution-locked", () => {
    const result = checkProcessAdapterAutoAssignmentConstraint({
      ...baseInput,
      executionLockedAt: null,
    });
    expect(result).toEqual({ allowed: true });
  });

  it("allows a run to reclaim the execution lock it already owns", () => {
    const result = checkProcessAdapterAutoAssignmentConstraint({
      ...baseInput,
      executionLockRunId: "run-current",
    });
    expect(result).toEqual({ allowed: true });
  });

  it("allows claiming a locked issue when there is no pending human action", () => {
    const result = checkProcessAdapterAutoAssignmentConstraint({
      ...baseInput,
      hasPendingHumanAction: false,
    });
    expect(result).toEqual({ allowed: true });
  });

  it("respects an explicitly passed restrictedAdapterTypes set", () => {
    const blocked = checkProcessAdapterAutoAssignmentConstraint({
      ...baseInput,
      adapterType: "codex_local",
      restrictedAdapterTypes: new Set(["codex_local"]),
    });
    expect(blocked.allowed).toBe(false);

    const allowed = checkProcessAdapterAutoAssignmentConstraint({
      ...baseInput,
      adapterType: "process",
      restrictedAdapterTypes: new Set(["codex_local"]),
    });
    expect(allowed).toEqual({ allowed: true });
  });
});

describe("resolveHumanActionLockRestrictedAdapterTypes", () => {
  it("defaults to the process adapter type when unconfigured", () => {
    expect(resolveHumanActionLockRestrictedAdapterTypes({})).toEqual(
      new Set(DEFAULT_HUMAN_ACTION_LOCK_RESTRICTED_ADAPTER_TYPES),
    );
  });

  it("parses a comma-separated env override", () => {
    expect(
      resolveHumanActionLockRestrictedAdapterTypes({
        PROCESS_ADAPTER_AUTO_ASSIGNMENT_RESTRICTED_TYPES: "process, codex_local ,claude_local",
      }),
    ).toEqual(new Set(["process", "codex_local", "claude_local"]));
  });

  it("falls back to the default when the env override is blank", () => {
    expect(
      resolveHumanActionLockRestrictedAdapterTypes({
        PROCESS_ADAPTER_AUTO_ASSIGNMENT_RESTRICTED_TYPES: "  , ,",
      }),
    ).toEqual(new Set(DEFAULT_HUMAN_ACTION_LOCK_RESTRICTED_ADAPTER_TYPES));
  });
});
