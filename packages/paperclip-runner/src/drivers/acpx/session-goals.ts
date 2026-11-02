import type { AcpxRuntimeGoalCapability, AcpxRuntimeGoalSnapshot } from "./runtime-host.js";

/** Only the negotiated extension, never the harness name, grants controls. */
export function acpxGoalProjection(
  capability: AcpxRuntimeGoalCapability | null,
  goal: AcpxRuntimeGoalSnapshot | null,
  workingNow: boolean,
) {
  const available = capability?.version === 1
    && capability.controlMethod === "_session/goal"
    && capability.actions.includes("set")
    && capability.actions.includes("clear");
  const timestamp = (value: number | string | null | undefined): string | null => {
    if (value == null) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };
  return {
    schema: "paperclip.session_goal.snapshot.v1",
    sessionGoals: {
      availability: available ? "available" : "unsupported",
      actions: available ? [...new Set(capability.actions)] : [],
      autonomousUpdates: available,
      persistentAcrossResume: available,
      maxObjectiveChars: 4_000,
      // v1 of the ACP goal extension does not negotiate budget control.
      tokenBudgetControl: false,
      usageReporting: available,
      ...(!available ? {
        reasonCode: "persistent_session_goal_extension_required",
        reason: "This persistent ACP session does not advertise a compatible goal extension with set and clear controls.",
      } : {}),
    },
    goal: available && goal ? {
      objective: goal.objective,
      status: goal.status,
      tokenBudget: goal.tokenBudget ?? null,
      tokensUsed: goal.tokensUsed ?? null,
      elapsedSeconds: goal.timeUsedSeconds ?? null,
      iterations: goal.iterations ?? null,
      lastReason: goal.lastReason ?? null,
      createdAt: timestamp(goal.createdAt),
      updatedAt: timestamp(goal.updatedAt),
      completedAt: goal.status === "complete" ? timestamp(goal.updatedAt) : null,
      workingNow,
    } : null,
    workingNow,
  };
}
