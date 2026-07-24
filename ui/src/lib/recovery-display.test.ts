import { describe, expect, it } from "vitest";
import {
  deriveActiveRecoveryDisplayState,
  deriveRecoveryDisplayState,
  recoveryChipLabel,
} from "./recovery-display";

describe("recoveryChipLabel", () => {
  it("returns the workspace-specific label when kind is workspace_validation and state is needed", () => {
    expect(recoveryChipLabel("needed", "workspace_validation")).toBe(
      "Workspace recovery needed",
    );
  });

  it("falls back to the generic label for other needed kinds", () => {
    expect(recoveryChipLabel("needed", "missing_disposition")).toBe("Recovery needed");
    expect(recoveryChipLabel("needed", "stranded_assigned_issue")).toBe("Recovery needed");
    expect(recoveryChipLabel("needed", "issue_graph_liveness")).toBe("Recovery needed");
  });

  it("does not override the chip label for non-needed states", () => {
    expect(recoveryChipLabel("in_progress", "workspace_validation")).toBe(
      "Recovery in progress",
    );
    expect(recoveryChipLabel("escalated", "workspace_validation")).toBe(
      "Recovery escalated",
    );
    expect(recoveryChipLabel("observe_only", "workspace_validation")).toBe(
      "Observing active run",
    );
  });
});

describe("deriveRecoveryDisplayState", () => {
  const base = {
    status: "active" as const,
    kind: "missing_disposition" as const,
    outcome: null,
  };

  it("classifies workspace_validation active as needed", () => {
    expect(deriveRecoveryDisplayState({ ...base, kind: "workspace_validation" })).toBe(
      "needed",
    );
    expect(
      deriveActiveRecoveryDisplayState({ ...base, kind: "workspace_validation" }),
    ).toBe("needed");
  });
});
