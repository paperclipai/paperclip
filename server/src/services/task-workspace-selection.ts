import { and, inArray, isNull } from "drizzle-orm";
import { executionWorkspaces } from "@paperclipai/db";

/** Lifecycle eligibility shared by discovery and selection; callers add scope and privacy. */
export function taskWorkspaceSelectableCondition() {
  return and(
    inArray(executionWorkspaces.status, ["active", "idle"]),
    isNull(executionWorkspaces.closedAt),
  )!;
}
