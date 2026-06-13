export interface BundleDraft {
  mode: "managed" | "external";
  rootPath: string;
  entryFile: string;
}

/**
 * Decide whether to keep the user's in-progress draft or re-sync to the
 * latest persisted bundle state.
 *
 * Returns `current` when the user has unsaved edits (any field differs from
 * persisted).  Otherwise returns a fresh draft from persisted values so the
 * UI stays in sync after a bundle refetch.
 */
export function resolveBundleDraft(
  current: BundleDraft | null,
  persisted: BundleDraft,
): BundleDraft {
  if (
    current &&
    (current.mode !== persisted.mode ||
      current.rootPath !== persisted.rootPath ||
      current.entryFile !== persisted.entryFile)
  ) {
    return current;
  }
  return { ...persisted };
}
