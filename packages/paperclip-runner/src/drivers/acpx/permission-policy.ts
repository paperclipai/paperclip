import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
import type { QualifiedAcpxAgent } from "./qualified-profiles.js";

export interface AcpxPermissionRequestLike {
  inferredKind?: unknown;
  raw?: unknown;
}

export type AcpxPermissionDisposition =
  "allow_once" | "reject_once" | "delegate";

export interface AcpxPermissionPolicyOptions {
  /** Descriptive configuration only; never proof that a request is authorized. */
  runnerOwnedMcpServerNames?: ReadonlySet<string>;
  /** Descriptive configuration only; never proof that a request is authorized. */
  allConfiguredMcpServersAreRunnerOwned?: boolean;
}

export interface AcpxRuntimePermissionPolicy {
  autoApprove?: readonly string[];
  escalate?: readonly string[];
  defaultAction: "approve" | "deny" | "escalate";
}

export function acpxRuntimePermissionPolicy(
  mode: NativeAcpxPermissionMode,
): AcpxRuntimePermissionPolicy {
  if (mode === "approve-all") return { defaultAction: "approve" };
  if (mode === "deny-all") return { defaultAction: "deny" };
  // ACPX derives permission kinds from provider-originated requests. Until the
  // host can bind a request to independent authority, no kind is safe to
  // auto-approve. Escalation delegates to the coordinator and otherwise fails
  // closed through the non-interactive permission policy.
  return { defaultAction: "escalate" };
}

/**
 * Decide the local part of an ACP permission request. `delegate` means the
 * caller must ask the coordinator and fail closed when no delegate exists.
 */
export function decideAcpxPermission(
  _agent: QualifiedAcpxAgent,
  mode: NativeAcpxPermissionMode,
  _request: AcpxPermissionRequestLike,
  _options: AcpxPermissionPolicyOptions = {},
): AcpxPermissionDisposition {
  if (mode === "deny-all") return "reject_once";
  if (mode === "approve-all") return "allow_once";
  // inferredKind and raw semantic/MCP metadata both originate outside the
  // runner trust boundary. Neither can grant local read or semantic authority.
  // A future verified decision must carry runner-issued call identity bound to
  // the run-scoped catalog; absent that proof, the coordinator decides.
  return "delegate";
}
