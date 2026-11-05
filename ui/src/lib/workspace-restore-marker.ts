import { t } from "@/i18n";
import { safeWorkspaceRestorePath } from "@paperclipai/shared";

export function workspaceRestoreMarkerDetail(input: {
  result: Record<string, unknown> | null | undefined;
  savedPlan: boolean;
  hasResponse: boolean;
}): string {
  const parts = [input.savedPlan
    ? t("display:copy_07f5c36f0671")
    : t("display:copy_3c7a34bda5cf")];
  parts.push("Workspace files need recovery.");
  if (!input.hasResponse && input.result?.finalResponseRecorded === false) {
    parts.push("No final response was recorded.");
  }
  const relativePath = safeWorkspaceRestorePath(input.result?.workspaceRestorePath);
  if (relativePath) parts.push(`Affected path: ${relativePath}.`);
  return parts.join(" ");
}
