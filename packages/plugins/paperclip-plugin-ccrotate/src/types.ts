export type CcrotateTarget = "claude" | "codex";

export interface CcrotateSshConfig {
  host: string;
  user: string;
  port: number;
  identityFile: string;
  strictHostKeyChecking: boolean;
}

export interface CcrotateDriverConfig {
  ssh: CcrotateSshConfig;
  target: CcrotateTarget;
  remoteWorkspaceRoot: string;
  midRunRetries: number;
  rateLimitPatterns: string[];
}

export interface CcrotateLeaseState {
  providerLeaseId: string;
  remoteCwd: string;
  rotatedEmail: string | null;
  rotatedAt: string;
  target: CcrotateTarget;
}
