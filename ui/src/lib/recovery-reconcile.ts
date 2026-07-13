import type { IssueRecoveryAction } from "@paperclipai/shared";
import type { CurrentBoardAccess } from "../api/access";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Best-effort client mirror of the backend `runtime:manage` gate that the break-glass override
 * reconcile (`POST /execution-workspaces/:id/reconcile-branch` in `override` mode) actually
 * enforces. The server re-checks `runtime:manage` for every reconcile and is authoritative, so
 * this is defense-in-depth: it hides the "reconcile anyway" affordance from viewers rather than
 * showing a button that always 403s. For human board members `runtime:manage` grants on the
 * same non-viewer, active-membership condition as recovery resolution (see
 * `server/src/services/authorization.ts`), so the shape matches; per-permission-key overrides
 * are not surfaced to the client and remain the server's call.
 */
export function canBoardManageRuntime(
  companyId: string | null | undefined,
  boardAccess: CurrentBoardAccess | undefined,
) {
  if (!companyId || !boardAccess) return false;
  if (boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin) return true;
  if (!boardAccess.memberships || boardAccess.memberships.length === 0) {
    return boardAccess.companyIds.includes(companyId);
  }

  const membership = boardAccess.memberships.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  if (!membership) return false;
  return membership.membershipRole !== "viewer" && membership.membershipRole !== null;
}

/**
 * The execution workspace a reconcile action should target. The recovery card is rendered from a
 * specific `workspace_validation` recovery action whose evidence pins the workspace that diverged;
 * that workspace — not the page-level `issue.executionWorkspaceId` — is the authoritative target.
 * The page-level id can drift (e.g. a re-issue rebinds the issue to a new workspace) while the card
 * still shows the older action, so we prefer the action's evidence and only fall back to the
 * page-level id when the evidence carries no workspace reference.
 *
 * The branch-incoherence failure (the one that renders the reconcile-forward / break-glass actions)
 * records the workspace under `persistedExecutionWorkspaceId`; the not-reusable failure records it
 * under `executionWorkspaceId`. We accept either key so both divergence shapes pin correctly.
 */
export function readRecoveryReconcileWorkspaceId(
  action: IssueRecoveryAction | null | undefined,
): string | null {
  if (!action || action.kind !== "workspace_validation") return null;
  const workspaceValidation = asRecord(action.evidence?.workspaceValidation);
  if (!workspaceValidation) return null;
  const persisted = workspaceValidation.persistedExecutionWorkspaceId;
  if (typeof persisted === "string" && persisted.length > 0) return persisted;
  const executionWorkspaceId = workspaceValidation.executionWorkspaceId;
  if (typeof executionWorkspaceId === "string" && executionWorkspaceId.length > 0) {
    return executionWorkspaceId;
  }
  return null;
}
