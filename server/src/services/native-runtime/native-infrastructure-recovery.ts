import {
  NATIVE_RECOVERY_AUTHORITY_REGISTRY,
  issueExecutionPolicySchema,
  type NativeRecoveryPolicy,
} from "@paperclipai/shared";
import type { NativeEvidenceAssessment } from "./evidence-classifier.js";

const HUMAN_DECISION_KINDS = new Set(["approval", "credential", "human_input"]);
const OPERATIONAL_VERIFICATION_STATUSES = new Set(["not_run", "passed"]);

export type NativeInfrastructureRecoveryClassification =
  | {
      authorized: false;
      reasonCode:
        | "policy_absent"
        | "policy_invalid"
        | "runtime_not_native"
        | "governance_pending"
        | "human_decision_requested"
        | "verification_not_operational"
        | "attention_kind_not_recoverable"
        | "recovery_budget_exhausted";
    }
  | {
      authorized: true;
      cause: NativeRecoveryPolicy["recoverableCauses"][number];
      fingerprint: string;
      summary: string;
      attempt: number;
      maxAttempts: number;
      exhausted: boolean;
    };

function readPolicy(executionPolicy: unknown): NativeRecoveryPolicy | null {
  const parsed = issueExecutionPolicySchema.safeParse(executionPolicy);
  if (!parsed.success || !parsed.data.nativeRecovery) return null;
  const policy = parsed.data.nativeRecovery;
  const authority = NATIVE_RECOVERY_AUTHORITY_REGISTRY[policy.authorityRouteKey];
  if (
    !authority ||
    policy.routeKey !== policy.authorityRouteKey ||
    policy.authority !== authority.authority ||
    policy.authoritySourcePath !== authority.sourcePath ||
    policy.snapshotSha256.toLowerCase() !== authority.snapshotSha256
  ) {
    return null;
  }
  return policy;
}

function recoveryCause(
  assessment: Pick<NativeEvidenceAssessment, "verificationAssessments">,
  policy: NativeRecoveryPolicy,
) {
  const reported = assessment.verificationAssessments
    .map((entry) => entry.reportedReasonCode ?? entry.reasonCode)
    .find((candidate) => policy.recoverableCauses.includes(candidate as never));
  return reported as NativeRecoveryPolicy["recoverableCauses"][number] | undefined;
}

/**
 * Classify only a server-authorized, canary-scoped infrastructure recovery.
 * Model prose is never inspected. The policy, verification reason codes and
 * attention-kind allowlist are all required before a human-looking review can
 * be converted into an agent continuation.
 */
export function classifyNativeInfrastructureRecovery(input: {
  executionPolicy: unknown;
  runtimeMode?: "native" | "legacy";
  governanceGate?: unknown | null;
  assessment: Pick<
    NativeEvidenceAssessment,
    | "attentionRequests"
    | "verificationAssessments"
    | "hasFailedVerification"
    | "acceptedEvidenceRefs"
  >;
  attempt?: number | null;
}): NativeInfrastructureRecoveryClassification {
  // Recovery is fail-closed with respect to the execution lane: the caller
  // must prove this is the native Runner path. Missing mode is not an implicit
  // native opt-in, which keeps codex_local and older callers unchanged.
  if (input.runtimeMode !== "native") {
    return { authorized: false, reasonCode: "runtime_not_native" };
  }
  if (input.governanceGate) {
    return { authorized: false, reasonCode: "governance_pending" };
  }
  const policy = readPolicy(input.executionPolicy);
  if (input.executionPolicy == null) {
    return { authorized: false, reasonCode: "policy_absent" };
  }
  if (!policy) return { authorized: false, reasonCode: "policy_invalid" };
  if (input.assessment.attentionRequests.length === 0) {
    return { authorized: false, reasonCode: "attention_kind_not_recoverable" };
  }
  if (
    input.assessment.attentionRequests.some((request) =>
      HUMAN_DECISION_KINDS.has(request.kind),
    )
  ) {
    return { authorized: false, reasonCode: "human_decision_requested" };
  }
  if (
    input.assessment.attentionRequests.some(
      (request) =>
        !policy.recoverableAttentionKinds.includes(request.kind as never) ||
        (request.kind === "external_action" &&
          request.ownerClass !== "external_system"),
    )
  ) {
    return { authorized: false, reasonCode: "attention_kind_not_recoverable" };
  }
  if (
    input.assessment.hasFailedVerification ||
    input.assessment.verificationAssessments.length === 0 ||
    !input.assessment.verificationAssessments.some(
      (entry) => entry.claimStatus === "not_run",
    ) ||
    input.assessment.verificationAssessments.some(
      (entry) => !OPERATIONAL_VERIFICATION_STATUSES.has(entry.claimStatus),
    )
  ) {
    return { authorized: false, reasonCode: "verification_not_operational" };
  }
  const cause = recoveryCause(input.assessment, policy);
  if (!cause) {
    return { authorized: false, reasonCode: "verification_not_operational" };
  }
  // A review after accepted work is a real review unless the result is still
  // purely an environment/tool recovery. This prevents the canary policy from
  // becoming a general-purpose approval bypass.
  if (input.assessment.acceptedEvidenceRefs.length > 0) {
    return { authorized: false, reasonCode: "verification_not_operational" };
  }
  const attempt = Math.max(0, input.attempt ?? 0);
  const fingerprint = [
    "native-infrastructure-recovery",
    policy.routeKey,
    policy.snapshotSha256,
    cause,
    input.assessment.attentionRequests
      .map((request) => `${request.sourceKind}:${request.sourceIndex}`)
      .sort()
      .join(","),
  ].join(":");
  const summary = input.assessment.attentionRequests
    .map((request) => request.summary)
    .join("; ")
    .slice(0, 2_000);
  return {
    authorized: true,
    cause,
    fingerprint,
    summary,
    attempt,
    maxAttempts: policy.maxAttempts,
    exhausted: attempt + 1 >= policy.maxAttempts,
  };
}
