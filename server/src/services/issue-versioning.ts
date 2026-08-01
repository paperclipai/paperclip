import type { PluginVersionedIssue } from "@paperclipai/plugin-sdk";

export {
  IssueVersionConflictError,
  bumpIssueVersions,
  runIssueMutation,
  versionedIssuePatch,
  type DbOrTx,
  type DbTransaction,
  type IssueMutationPatch,
  type IssueMutationPlan,
  type IssueMutationResult,
  type RunIssueMutationInput,
} from "@paperclipai/db";

/**
 * Narrow an issue row that is about to cross the plugin boundary to the
 * versioned shape the SDK promises. Fails closed if the row somehow lost its
 * `version` column instead of silently handing plugins an unversioned issue.
 */
export function requireVersionedIssue(issue: unknown): PluginVersionedIssue {
  const candidate = issue as PluginVersionedIssue | null | undefined;
  if (!candidate || !Number.isSafeInteger(candidate.version) || candidate.version < 1) {
    throw new Error("Issue row is missing a positive integer version");
  }
  return candidate;
}
