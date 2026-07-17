import { describe, expect, it } from "vitest";
import {
  instanceExperimentalSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
} from "./instance.js";

describe("instance experimental settings validators", () => {
  it("defaults the server info debug view off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableServerInfoDebugView).toBe(false);
  });

  it("defaults workspace branch repair settings on", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableWorkspaceBranchReconcileForward).toBe(true);
    expect(settings.enableWorkspaceDirtyQuarantineRepair).toBe(true);
  });

  it("defaults the goals sidebar link off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableGoalsSidebarLink).toBe(false);
  });

  it("defaults worktree run execution off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableWorktreeRunExecution).toBe(false);
    expect(settings.worktreeRunExecutionActivatedAt).toBeNull();
    expect(settings.worktreeRunExecutionActivationInstanceId).toBeNull();
  });

  it("strips server-managed worktree run execution fields from patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableWorktreeRunExecution: true,
        worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
        worktreeRunExecutionActivationInstanceId: "copied-instance",
      }),
    ).toEqual({
      enableWorktreeRunExecution: true,
    });
  });

  it("defaults built-in agents off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableBuiltInAgents).toBe(false);
  });

  it("defaults apps off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableApps).toBe(false);
  });

  it("accepts worktree run execution patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableWorktreeRunExecution: true,
      }),
    ).toEqual({
      enableWorktreeRunExecution: true,
    });
  });

  it("defaults the decisions sidebar link off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableDecisions).toBe(false);
  });

  it("accepts decisions patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableDecisions: true,
      }),
    ).toEqual({
      enableDecisions: true,
    });
  });

  it("accepts server info debug view patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableServerInfoDebugView: true,
      }),
    ).toEqual({
      enableServerInfoDebugView: true,
    });
  });

  it("accepts workspace branch forward reconciliation patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableWorkspaceBranchReconcileForward: false,
        enableWorkspaceDirtyQuarantineRepair: false,
      }),
    ).toEqual({
      enableWorkspaceBranchReconcileForward: false,
      enableWorkspaceDirtyQuarantineRepair: false,
    });
  });

  it("accepts goals sidebar link patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableGoalsSidebarLink: true,
      }),
    ).toEqual({
      enableGoalsSidebarLink: true,
    });
  });

  it("accepts built-in agents patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableBuiltInAgents: true,
      }),
    ).toEqual({
      enableBuiltInAgents: true,
    });
  });

  it("accepts apps patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableApps: true,
      }),
    ).toEqual({
      enableApps: true,
    });
  });
});
