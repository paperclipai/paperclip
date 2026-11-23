import type { ProviderFailure } from "../contracts/provider-failure.generated.js";
import { providerFailureFromError } from "../drivers/provider-failure.js";
import type { CodexRpcNotification } from "../drivers/codex/app-server-transport.js";
import type { CapabilityLiveTransportFactory } from "../live/live-session.js";

/** Eval-only operator facts. Raw provider text and identities never enter this DTO. */
export type EvalProviderFailureDiagnostic = Pick<ProviderFailure,
  "phase" | "category" | "httpStatus" | "retryability">;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function evalFailureDiagnosticFromError(error: unknown): EvalProviderFailureDiagnostic | null {
  const failure = providerFailureFromError(error);
  if (!failure) return null;
  return { phase: failure.phase, category: failure.category, retryability: failure.retryability,
    ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }) };
}

export function evalProviderFailureDiagnostic(notification: CodexRpcNotification): EvalProviderFailureDiagnostic | null {
  if (notification.method !== "turn/completed") return null;
  const params = record(notification.params), turn = record(params.turn);
  if ((turn.status ?? params.status) !== "failed") return null;
  return evalFailureDiagnosticFromError(turn.error ?? params.error)
    ?? { phase: "turn", category: "unknown", retryability: "unknown" };
}

/** Observe the real notification before the board evidence projection redacts it. */
export function observeEvalProviderFailures(
  factory: CapabilityLiveTransportFactory,
  recordFailure: (failure: EvalProviderFailureDiagnostic) => void,
): CapabilityLiveTransportFactory {
  return options => {
    const bundle = factory(options);
    const notifications = bundle.transport.notifications.bind(bundle.transport);
    bundle.transport.notifications = async function* () {
      for await (const notification of notifications()) {
        const diagnostic = evalProviderFailureDiagnostic(notification);
        if (diagnostic) recordFailure(diagnostic);
        yield notification;
      }
    };
    return bundle;
  };
}
