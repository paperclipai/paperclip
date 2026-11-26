import type { IssueRecoveryAction } from "@paperclipai/shared";
import { isNativeWorkspaceExportRepairCause } from "@paperclipai/shared";
import { asObject, cn } from "../lib/utils";

/** Infrastructure repair belongs to the harness/operator, never a task form. */
export function WorkspaceExportRecovery({ action, className }: {
  className?: string; action: IssueRecoveryAction | null;
}) {
  const ownerRecovery = action?.cause === "native_workspace_finalization_owner_unverified";
  if (!action || (!ownerRecovery && !isNativeWorkspaceExportRepairCause(action.cause)) || action.ownerType !== "board"
    || !["active", "escalated"].includes(action.status) || typeof action.evidence.runId !== "string") return null;
  const queued = !!action.evidence.workspaceOwnerStop || action.wakePolicy?.kind === "resume_native_run";
  const automatic = queued || (ownerRecovery && asObject(action.evidence.workspaceOwnerRecovery).state === "resuming");
  return <p role="status" className={cn("text-sm text-muted-foreground", className)}>
    {automatic ? "Restoring saved work…" : "Workspace recovery needs operator assistance. The agent’s result is saved."}
  </p>;
}
