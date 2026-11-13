export const GIT_BRANCH_OWNERSHIP_METADATA_VERSION = 1;
export const GIT_BRANCH_OWNERSHIP_METADATA_KEY = "gitBranchOwnershipVersion";

function hasCurrentGitBranchOwnershipMetadata(
  metadata: Record<string, unknown> | null | undefined,
) {
  return metadata?.[GIT_BRANCH_OWNERSHIP_METADATA_KEY] === GIT_BRANCH_OWNERSHIP_METADATA_VERSION;
}

export function isRuntimeOwnedGitBranch(
  metadata: Record<string, unknown> | null | undefined,
) {
  return hasCurrentGitBranchOwnershipMetadata(metadata) && metadata?.createdByRuntime === true;
}
