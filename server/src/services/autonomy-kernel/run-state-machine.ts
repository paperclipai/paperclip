import type { AutonomyRunKernelState, AutonomyTerminalClassification } from "@paperclipai/shared";
import type { RecordTransitionInput } from "./types.js";

const allowedTransitions: ReadonlyMap<AutonomyRunKernelState | null, ReadonlySet<AutonomyRunKernelState>> = new Map<
  AutonomyRunKernelState | null,
  ReadonlySet<AutonomyRunKernelState>
>([
  [null, new Set<AutonomyRunKernelState>(["planned"])],
  ["planned", new Set<AutonomyRunKernelState>(["preflight", "terminal"])],
  ["preflight", new Set<AutonomyRunKernelState>(["authorized", "preflight_failed", "terminal"])],
  ["preflight_failed", new Set<AutonomyRunKernelState>(["terminal"])],
  ["authorized", new Set<AutonomyRunKernelState>(["queued", "terminal"])],
  ["queued", new Set<AutonomyRunKernelState>(["running", "terminal"])],
  ["running", new Set<AutonomyRunKernelState>(["evidence_extraction", "terminal"])],
  ["evidence_extraction", new Set<AutonomyRunKernelState>(["evidence_validation", "terminal"])],
  ["evidence_validation", new Set<AutonomyRunKernelState>(["issue_update", "terminal"])],
  ["issue_update", new Set<AutonomyRunKernelState>(["continuation_decision", "terminal"])],
  ["continuation_decision", new Set<AutonomyRunKernelState>(["queued", "terminal"])],
  ["terminal", new Set<AutonomyRunKernelState>()],
]);

const terminalClassifications = new Set<AutonomyTerminalClassification>([
  "succeeded_with_evidence",
  "blocked_with_owner",
  "approval_required_visible",
  "failed_preflight",
  "failed_auth",
  "failed_agent_runtime",
  "failed_no_evidence",
  "failed_invalid_evidence",
  "failed_policy_violation",
  "failed_budget",
  "failed_controller_invariant",
  "failed_validator_error",
  "cancelled_by_policy",
  "cancelled_by_user",
  "timed_out",
]);

const preflightFailureClassifications = new Set<AutonomyTerminalClassification>([
  "failed_preflight",
  "failed_auth",
  "failed_budget",
  "failed_policy_violation",
  "failed_controller_invariant",
]);

export type RunStateMachineErrorCode =
  | "INVALID_TRANSITION"
  | "TERMINAL_IMMUTABLE"
  | "TERMINAL_CLASSIFICATION_REQUIRED"
  | "TERMINAL_CLASSIFICATION_FOR_NON_TERMINAL"
  | "UNKNOWN_TERMINAL_CLASSIFICATION"
  | "GENERIC_SUCCESS_FORBIDDEN"
  | "SUCCESS_REQUIRES_EVIDENCE"
  | "CONTROLLER_OVERRIDE_REQUIRES_INCIDENT"
  | "PREFLIGHT_FAILED_CLASSIFICATION_REQUIRED";

export class RunStateMachineError extends Error {
  readonly code: RunStateMachineErrorCode;
  readonly fromState: AutonomyRunKernelState | null;
  readonly toState: AutonomyRunKernelState;

  constructor(
    code: RunStateMachineErrorCode,
    message: string,
    input: Pick<RecordTransitionInput, "fromState" | "toState">,
  ) {
    super(message);
    this.name = "RunStateMachineError";
    this.code = code;
    this.fromState = input.fromState;
    this.toState = input.toState;
  }
}

export function getAllowedRunTransitions(
  fromState: AutonomyRunKernelState | null,
): AutonomyRunKernelState[] {
  return Array.from(allowedTransitions.get(fromState) ?? []);
}

export function isTerminalClassification(value: unknown): value is AutonomyTerminalClassification {
  return typeof value === "string" && terminalClassifications.has(value as AutonomyTerminalClassification);
}

export function validateRunTransition(input: RecordTransitionInput): void {
  const rawTerminalClassification = input.terminalClassification as unknown;
  const terminalClassification = input.terminalClassification ?? null;
  const incidentIds = input.incidentIds ?? [];
  const evidenceEntryIds = input.evidenceEntryIds ?? [];

  if (input.fromState === "terminal") {
    if (!input.controllerOverride) {
      throw new RunStateMachineError(
        "TERMINAL_IMMUTABLE",
        "Terminal autonomy run states are immutable without an explicit controller override.",
        input,
      );
    }
    if (incidentIds.length === 0) {
      throw new RunStateMachineError(
        "CONTROLLER_OVERRIDE_REQUIRES_INCIDENT",
        "Controller overrides from terminal state require a linked incident.",
        input,
      );
    }
  }

  const allowed = allowedTransitions.get(input.fromState);
  if (!allowed?.has(input.toState) && !(input.fromState === "terminal" && input.controllerOverride)) {
    throw new RunStateMachineError(
      "INVALID_TRANSITION",
      `Invalid autonomy run transition from ${input.fromState ?? "<initial>"} to ${input.toState}.`,
      input,
    );
  }

  if (input.toState === "terminal") {
    if (!terminalClassification) {
      throw new RunStateMachineError(
        "TERMINAL_CLASSIFICATION_REQUIRED",
        "Terminal autonomy run transitions require an explicit terminal classification.",
        input,
      );
    }
    if (rawTerminalClassification === "succeeded") {
      throw new RunStateMachineError(
        "GENERIC_SUCCESS_FORBIDDEN",
        "Generic success is not a valid autonomy terminal classification; use succeeded_with_evidence.",
        input,
      );
    }
    if (!isTerminalClassification(terminalClassification)) {
      throw new RunStateMachineError(
        "UNKNOWN_TERMINAL_CLASSIFICATION",
        `Unknown autonomy terminal classification: ${terminalClassification}.`,
        input,
      );
    }
    if (terminalClassification === "succeeded_with_evidence" && evidenceEntryIds.length === 0) {
      throw new RunStateMachineError(
        "SUCCESS_REQUIRES_EVIDENCE",
        "succeeded_with_evidence terminal classification requires at least one evidence entry.",
        input,
      );
    }
    if (input.fromState === "preflight_failed" && !preflightFailureClassifications.has(terminalClassification)) {
      throw new RunStateMachineError(
        "PREFLIGHT_FAILED_CLASSIFICATION_REQUIRED",
        "preflight_failed runs must terminate with a preflight/auth/budget/policy/controller failure classification.",
        input,
      );
    }
    return;
  }

  if (terminalClassification) {
    throw new RunStateMachineError(
      "TERMINAL_CLASSIFICATION_FOR_NON_TERMINAL",
      "Terminal classifications may only be set on transitions to terminal.",
      input,
    );
  }
}
