export interface TrackedStatusEntry {
  status: string;
  path: string;
}

export interface RootGateSafetyResult {
  ok: boolean;
  repoRoot: string;
  rootDirty: boolean;
  trackedChanges: TrackedStatusEntry[];
  missingRequiredFiles: string[];
  missingWorkspaceManifests: string[];
  mirrorPresent: boolean;
  mirrorHasWorkspaceManifests: boolean;
  problems: string[];
}

export declare function parseTrackedStatusEntries(statusPorcelain: string): TrackedStatusEntry[];

export declare function evaluateRootGateSafety(input: {
  repoRoot: string;
  gitStatusPorcelain?: string;
  fileExists?: (candidatePath: string) => boolean;
  directoryExists?: (candidatePath: string) => boolean;
}): RootGateSafetyResult;
