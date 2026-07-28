// Shared between the server (which produces the snapshot at boot) and the UI
// (which renders it), so both sides stay in sync on a single definition.
export type ServerGitLocalChanges =
  | {
      available: true;
      hasLocalChanges: boolean;
      stagedFileCount: number;
      unstagedFileCount: number;
      untrackedFileCount: number;
    }
  | {
      available: false;
      unavailableReason: "git_status_unavailable";
    };

export type ServerGitInfo =
  | {
      available: true;
      fullSha: string;
      shortSha: string;
      branchName: string | null;
      subject: string;
      committedAt: string | null;
      localChanges: ServerGitLocalChanges;
    }
  | {
      available: false;
      unavailableReason: "git_unavailable" | "invalid_git_metadata";
    };

export interface ServerRuntimeOwnership {
  enabled: boolean;
  owner: "local" | "source_api";
}

export interface ServerRuntimeInfo {
  role: "primary" | "shadow";
  shadowSourceApi: string | null;
  shadowSourcePort: number | null;
  targetPort: number | null;
  scheduler: ServerRuntimeOwnership;
  backups: ServerRuntimeOwnership;
}

export interface ServerInfoSnapshot {
  processStartedAt: string;
  git: ServerGitInfo;
  runtime?: ServerRuntimeInfo;
}
