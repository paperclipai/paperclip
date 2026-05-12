import type {
  CredentialBroker,
  CredentialDeliveryMode,
  ExecutionTargetSummary,
} from "@paperclipai/plugin-sdk";

/**
 * Pure smart-resolver for credential delivery mode.
 *
 * Given a dispatch's bindings, runtime, and the registered-broker
 * landscape, decide which of `env` / `paperclip-broker` / `byo-broker`
 * should be used. See `docs/superpowers/specs/2026-05-12-credential-broker-design.md` §1.3.
 *
 * Strict invariants:
 *   - No IO. No clock. No logging.
 *   - Explicit config always wins.
 *   - When no OAuth bindings are involved, `env` is the answer
 *     (the broker has nothing to broker).
 *   - For external-runtime dispatches (OpenClaw, Hermes, BYO),
 *     `paperclip-broker` is never selected — Paperclip cannot inject
 *     into a process it doesn't spawn.
 *   - When the registered broker isn't reachable from the runtime,
 *     fall back rather than fail. The caller decides whether to
 *     also throw based on `PAPERCLIP_REQUIRE_BROKER`.
 */

export interface OAuthBindingSummary {
  envVarName: string;
  connectionId: string;
  field: "access";
}

export type DeliveryReason =
  | "explicit_config"
  | "no_oauth_bindings"
  | "external_runtime_with_byo_targets"
  | "external_runtime_no_broker_targets"
  | "broker_available_and_reachable"
  | "broker_unreachable_from_runtime"
  | "no_broker_registered"
  | "provider_not_broker_compatible";

export interface ResolveCredentialDeliveryInput {
  /** When the agent config explicitly sets the mode, honor it. */
  explicit: CredentialDeliveryMode | undefined;
  executionTarget: ExecutionTargetSummary;
  oauthBindings: OAuthBindingSummary[];
  registeredBroker: CredentialBroker | undefined;
  hasBrokerTargetsFor: (connectionId: string) => boolean;
  providerBrokerSupported: (connectionId: string) => boolean;
}

export interface ResolveCredentialDeliveryResult {
  mode: CredentialDeliveryMode;
  reason: DeliveryReason;
}

/**
 * Execution-target kinds that represent runtimes Paperclip does NOT control.
 *
 * `external` is the explicit "externally-hired" kind. `webhook` covers
 * adapters that dispatch via a webhook to an operator-controlled gateway
 * (OpenClaw). Any other kind is treated as Paperclip-spawned.
 */
const EXTERNAL_RUNTIME_KINDS = new Set(["external", "webhook"]);

export function resolveCredentialDelivery(
  input: ResolveCredentialDeliveryInput,
): ResolveCredentialDeliveryResult {
  if (input.explicit) {
    return { mode: input.explicit, reason: "explicit_config" };
  }

  if (input.oauthBindings.length === 0) {
    return { mode: "env", reason: "no_oauth_bindings" };
  }

  const allProvidersSupportBroker = input.oauthBindings.every((b) =>
    input.providerBrokerSupported(b.connectionId),
  );
  if (!allProvidersSupportBroker) {
    return { mode: "env", reason: "provider_not_broker_compatible" };
  }

  if (EXTERNAL_RUNTIME_KINDS.has(input.executionTarget.kind)) {
    const allHaveTargets = input.oauthBindings.every((b) =>
      input.hasBrokerTargetsFor(b.connectionId),
    );
    return allHaveTargets
      ? { mode: "byo-broker", reason: "external_runtime_with_byo_targets" }
      : { mode: "env", reason: "external_runtime_no_broker_targets" };
  }

  if (!input.registeredBroker) {
    return { mode: "env", reason: "no_broker_registered" };
  }

  if (!input.registeredBroker.isReachableFrom(input.executionTarget)) {
    return { mode: "env", reason: "broker_unreachable_from_runtime" };
  }

  return { mode: "paperclip-broker", reason: "broker_available_and_reachable" };
}
