// Shared between the server (which produces the snapshot at boot) and the UI
// (which renders it), so both sides stay in sync on a single definition.
export type ServerGitInfo =
  | {
      available: true;
      fullSha: string;
      shortSha: string;
      subject: string;
      committedAt: string | null;
    }
  | {
      available: false;
      unavailableReason: "git_unavailable" | "invalid_git_metadata";
    };

export interface ServerInfoSnapshot {
  processStartedAt: string;
  git: ServerGitInfo;
}
