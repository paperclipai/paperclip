export type AgentSkillSyncMode = "unsupported" | "persistent" | "ephemeral";

export type AgentSkillAssignmentMode = "add" | "remove" | "replace";

export type AgentSkillState =
  | "available"
  | "configured"
  | "installed"
  | "missing"
  | "stale"
  | "external";

export type AgentSkillOrigin =
  | "company_managed"
  | "user_installed"
  | "external_unknown";

export interface AgentDesiredSkillEntry {
  key: string;
  versionId: string | null;
}

export interface AgentSkillEntry {
  key: string;
  runtimeName: string | null;
  versionId?: string | null;
  currentVersionId?: string | null;
  desired: boolean;
  managed: boolean;
  state: AgentSkillState;
  origin?: AgentSkillOrigin;
  originLabel?: string | null;
  locationLabel?: string | null;
  readOnly?: boolean;
  sourcePath?: string | null;
  targetPath?: string | null;
  detail?: string | null;
}

export interface AgentSkillSnapshot {
  adapterType: string;
  supported: boolean;
  mode: AgentSkillSyncMode;
  desiredSkills: string[];
  desiredSkillEntries?: AgentDesiredSkillEntry[];
  entries: AgentSkillEntry[];
  warnings: string[];
}

export interface AgentSkillSyncRequest {
  mode: AgentSkillAssignmentMode;
  desiredSkills: Array<string | AgentDesiredSkillEntry>;
}
