const SCHEMA = "paperclip/environment-stop-error/v1";
const REASONS = ["resource_unrecoverable", "recovery_failed", "recovery_incomplete"] as const;
const TERMINAL_REASONS: ReadonlySet<string> = new Set(["resource_unrecoverable", "recovery_failed"]);

export type PluginEnvironmentStopFailureReason = typeof REASONS[number];

export interface PluginEnvironmentStopFailure {
  reason: PluginEnvironmentStopFailureReason;
  terminal: boolean;
}

const MESSAGES: Record<PluginEnvironmentStopFailureReason, string> = {
  resource_unrecoverable: "The provider reports that the environment resource cannot recover from its error state, so it cannot be stopped.",
  recovery_failed: "The environment resource returned to an error state after a recovery attempt, so it cannot be stopped.",
  recovery_incomplete: "The environment resource did not finish recovery from its error state before the stop deadline.",
};

function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try { return Object.getOwnPropertyDescriptor(value, name)?.value; }
  catch { return undefined; }
}

function validate(value: unknown): PluginEnvironmentStopFailure | null {
  const reason = field(value, "reason");
  if (!REASONS.includes(reason as PluginEnvironmentStopFailureReason)) return null;
  return { reason: reason as PluginEnvironmentStopFailureReason, terminal: TERMINAL_REASONS.has(reason as string) };
}

export class PluginEnvironmentStopError extends Error {
  readonly failure: PluginEnvironmentStopFailure | null;

  constructor(reason: PluginEnvironmentStopFailureReason) {
    const failure = validate({ reason });
    super(failure ? MESSAGES[failure.reason] : "The environment resource could not be stopped.");
    this.name = "PluginEnvironmentStopError";
    this.failure = failure;
  }
}

export function environmentStopErrorData(error: unknown): unknown {
  if (!(error instanceof PluginEnvironmentStopError)) return undefined;
  const failure = validate(field(error, "failure"));
  return failure ? { schema: SCHEMA, failure: { reason: failure.reason } } : undefined;
}

export function readEnvironmentStopFailure(error: unknown): PluginEnvironmentStopFailure | null {
  const data = field(error, "data");
  return field(data, "schema") === SCHEMA ? validate(field(data, "failure")) : null;
}
