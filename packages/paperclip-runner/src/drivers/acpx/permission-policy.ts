import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
import { paperclipSemanticAction } from "../../catalog/semantic-action-catalog.js";
import { capabilityCanonicalOperation } from "../../catalog/canonical-operations.js";
import { canonicalRunnerToolName } from "../runner-tool-bridge.js";
import type { QualifiedAcpxAgent } from "./qualified-profiles.js";

export class AcpxApprovalRequiredError extends Error {
  readonly code = "approval_required";
  constructor() {
    super(
      "Approval required. This operation is not an automatically allowed Paperclip action, " +
      "and this runner has no interactive approval handler. Review the operation and " +
      "update the agent's permission setting before retrying.",
    );
    this.name = "AcpxApprovalRequiredError";
  }
}

// Review additions explicitly: a newly catalogued mutation must not inherit
// automatic provider permission. These operations implement the bounded plan,
// task, and handoff workflow; governance decisions, generic APIs, and workspace
// controls deliberately stay outside it. Asking a human does not approve work.
const AUTOMATIC_PAPERCLIP_WORKFLOW_ACTIONS = new Set([
  "report_progress", "answer_status_question", "write_document",
  "request_human_input", "register_deliverable", "finish_task", "block_task",
  "request_review", "create_task", "reassign_task", "set_dependencies",
  "create_project", "request_approval",
]);

/** Exact SDK rules for the run's runner-owned Paperclip MCP connection. */
export function claudePaperclipPermissionRules(
  tools: readonly Readonly<Record<string, unknown>>[],
  mode: NativeAcpxPermissionMode,
): string[] {
  if (mode !== "approve-reads" && mode !== "approve-paperclip") return [];
  const names = tools.flatMap((tool) => {
    if (typeof tool.name !== "string") return [];
    const name = canonicalRunnerToolName(tool.name);
    // Effects come from Paperclip's implementation catalog, never tool hints
    // or the provider's permission-request metadata. Unknown operations stay
    // subject to approval even when their names or annotations claim a read.
    const action = paperclipSemanticAction(name);
    // The semantic catalog groups approval reads under "governance". The
    // canonical side-effect class distinguishes those reads from decisions.
    const liveAction = capabilityCanonicalOperation(name);
    const isRead = liveAction
      ? liveAction.surfaces.includes("live") && liveAction.sideEffectClass === "read"
      : action?.effect === "read";
    // This only bypasses the provider's redundant permission prompt. The
    // authenticated bridge and controller still validate run authority,
    // company scope, claims, task mode, and governed-action approvals.
    return isRead || (action && (
      mode === "approve-paperclip" && AUTOMATIC_PAPERCLIP_WORKFLOW_ACTIONS.has(name)
    ))
      ? [`mcp__paperclip__${name}`]
      : [];
  });
  return [...new Set(names)].sort();
}

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
  // auto-approve here. Assigned Paperclip actions are allowed earlier at the
  // Claude SDK dispatch boundary. Other requests require an approval handler.
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
  // runner trust boundary. Neither can grant local semantic authority.
  // Assigned Paperclip actions use exact SDK rules on the runner-owned MCP
  // connection. Anything reaching this fallback still requires approval.
  return "delegate";
}
