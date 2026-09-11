import { z } from "zod";

export const RUNNER_GOAL_MAX_OBJECTIVE_CHARS = 4_000;

export const runnerGoalAvailabilitySchema = z.enum([
  "available",
  "unsupported",
  "policy_disabled",
]);
export type RunnerGoalAvailability = z.infer<typeof runnerGoalAvailabilitySchema>;

export const runnerGoalCapabilityActionSchema = z.enum(["set", "pause", "resume", "clear"]);
export type RunnerGoalCapabilityAction = z.infer<typeof runnerGoalCapabilityActionSchema>;

export const runnerGoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "limited",
  "usage_limited",
  "budget_limited",
  "complete",
]);
export type RunnerGoalStatus = z.infer<typeof runnerGoalStatusSchema>;

export const runnerGoalActionSchema = z.enum([
  "create",
  "edit",
  "replace",
  "pause",
  "resume",
  "clear",
]);
export type RunnerGoalAction = z.infer<typeof runnerGoalActionSchema>;

export const runnerGoalPendingActionSchema = z.enum([
  "starting",
  "editing",
  "replacing",
  "pausing",
  "resuming",
  "clearing",
  "continuing",
]);
export type RunnerGoalPendingAction = z.infer<typeof runnerGoalPendingActionSchema>;

export interface RunnerGoalCapability {
  availability: RunnerGoalAvailability;
  verified?: boolean;
  actions: RunnerGoalCapabilityAction[];
  autonomousUpdates: boolean;
  persistentAcrossResume: boolean;
  maxObjectiveChars: number;
  tokenBudgetControl: boolean;
  usageReporting: boolean;
  reasonCode?: string | null;
  reason?: string | null;
}

export interface RunnerGoalSnapshot {
  objective: string;
  status: RunnerGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  elapsedSeconds: number;
  iterations: number;
  lastReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  workingNow: boolean;
}

export interface RunnerGoalProjection {
  issueId: string;
  agentId: string | null;
  adapterType: string | null;
  sessionId: string | null;
  capability: RunnerGoalCapability;
  goal: RunnerGoalSnapshot | null;
  workingNow: boolean;
  activeRunId: string | null;
  pendingAction: RunnerGoalPendingAction | null;
  revision: number;
  observedAt: string | null;
}

const objectiveSchema = z
  .string()
  .trim()
  .min(1)
  .max(RUNNER_GOAL_MAX_OBJECTIVE_CHARS);

export const runnerGoalActionRequestSchema = z
  .object({
    requestId: z.string().trim().min(1).max(160),
    agentId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    action: runnerGoalActionSchema,
    objective: objectiveSchema.optional(),
    tokenBudget: z.number().int().positive().nullable().optional(),
    confirmReplace: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    const objectiveAction = value.action === "create" || value.action === "edit" || value.action === "replace";
    if (objectiveAction && value.objective === undefined) {
      context.addIssue({
        code: "custom",
        path: ["objective"],
        message: `${value.action} requires a nonblank objective`,
      });
    }
    if (!objectiveAction && (value.objective !== undefined || value.tokenBudget !== undefined)) {
      context.addIssue({
        code: "custom",
        path: [value.objective !== undefined ? "objective" : "tokenBudget"],
        message: `${value.action} does not accept an objective or token budget`,
      });
    }
    if (value.action === "replace" && value.confirmReplace !== true) {
      context.addIssue({
        code: "custom",
        path: ["confirmReplace"],
        message: "replace requires explicit confirmation",
      });
    }
  });

export type RunnerGoalActionRequest = z.infer<typeof runnerGoalActionRequestSchema>;

export interface RunnerGoalActionAccepted {
  requestId: string;
  status: "accepted" | "pending" | "completed" | "failed";
  projection: RunnerGoalProjection;
}
