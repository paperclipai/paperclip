import type { DeliveryReason } from "./resolve-credential-delivery.js";

/**
 * Structured warn-log emitted every time the credential broker
 * smart-resolver falls back to plaintext `env` delivery.
 *
 * Operators can grep their logs for the `credential-broker-fallback-to-env`
 * event to see exactly which runs still hand plaintext bearers to the
 * agent and why. Each reason carries a tailored remediation hint.
 *
 * Compatible with the pino-style `(obj, msg)` calling convention used
 * elsewhere in the server.
 */

/** Minimal logger surface — pino-compatible. */
export interface CredentialBrokerLogger {
  warn(obj: object, msg: string): void;
}

export interface FallbackLogInput {
  runId: string;
  agentId: string;
  executionTargetKind: string;
  sandboxProvider?: string;
  reason: DeliveryReason;
  bindings: Array<{ envVarName: string; connectionId: string }>;
}

const HINTS: Record<DeliveryReason, string> = {
  explicit_config:
    "Agent config explicitly opts in to env delivery — no action needed.",
  no_oauth_bindings: "Dispatch has no oauth_token bindings.",
  external_runtime_with_byo_targets:
    "Unexpected fallback — using byo-broker should have applied. " +
    "This event indicates the resolver was overridden after the fact.",
  external_runtime_no_broker_targets:
    "Externally-hired runtime with no registered broker push targets. " +
    "Register a broker push target on each oauth connection to switch to byo-broker, " +
    "or set credentialDelivery: env on the agent config to silence this warning.",
  broker_available_and_reachable:
    "Unexpected fallback — using paperclip-broker should have applied. " +
    "This event indicates the resolver was overridden after the fact.",
  broker_unreachable_from_runtime:
    "The registered credential broker is not reachable from this runtime " +
    "(typical for remote sandboxes against an embedded-mode broker). Install/enable " +
    "the broker in standalone mode reachable from this sandbox, or set " +
    "credentialDelivery: env on the agent config to silence this warning.",
  no_broker_registered:
    "No credential broker plugin is registered. Install @paperclipai/credential-broker-builtin " +
    "(M2) or another registerCredentialBroker() plugin, or set credentialDelivery: env on the " +
    "agent config to silence this warning.",
  provider_not_broker_compatible:
    "One or more bindings reference an OAuth provider whose YAML has broker.supported: false. " +
    "Either await the provider's M3 rollout or set credentialDelivery: env on the agent config.",
};

export function logCredentialBrokerFallbackToEnv(
  logger: CredentialBrokerLogger,
  input: FallbackLogInput,
): void {
  logger.warn(
    {
      event: "credential-broker-fallback-to-env",
      runId: input.runId,
      agentId: input.agentId,
      executionTarget: {
        kind: input.executionTargetKind,
        sandboxProvider: input.sandboxProvider,
      },
      reason: input.reason,
      bindings: input.bindings,
      hint: HINTS[input.reason],
    },
    "credential broker fell back to plaintext env delivery",
  );
}
