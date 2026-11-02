import { safeWorkspaceRestorePath } from "@paperclipai/shared";

export function workspaceRestoreMarkerDetail(input: {
  result: Record<string, unknown> | null | undefined;
  savedPlan: boolean;
  hasResponse: boolean;
}): string {
  const parts = [input.savedPlan
    ? "Workspace restore failed after the plan was saved. The saved plan is available."
    : "Workspace restore failed."];
  parts.push("Workspace files need recovery.");
  if (!input.hasResponse && input.result?.finalResponseRecorded === false) {
    parts.push("No final response was recorded.");
  }
  const relativePath = safeWorkspaceRestorePath(input.result?.workspaceRestorePath);
  if (relativePath) parts.push(`Affected path: ${relativePath}.`);
  return parts.join(" ");
}

/** Recognize only this module's built-in marker text, never arbitrary diagnostics. */
export function parseWorkspaceRestoreMarkerDetail(value: string): {
  savedPlan: boolean;
  missingFinalResponse: boolean;
  relativePath: string | null;
} | null {
  const match = /^Workspace restore failed( after the plan was saved\. The saved plan is available)?\. Workspace files need recovery\.( No final response was recorded\.)?(?: Affected path: (.+)\.)?$/.exec(value);
  if (!match || match[0] !== value) return null;
  const relativePath = match[3] ?? null;
  if (relativePath !== null && safeWorkspaceRestorePath(relativePath) !== relativePath) return null;
  return { savedPlan: Boolean(match[1]), missingFinalResponse: Boolean(match[2]), relativePath };
}
