export type AgentSkillSyncMode = "unsupported" | "persistent" | "ephemeral";

export type AgentSkillState =
  | "available"
  | "configured"
  | "installed"
  | "missing"
  | "stale"
  | "external";

export interface AgentSkillEntry {
  name: string;
  desired: boolean;
  managed: boolean;
  state: AgentSkillState;
  sourcePath?: string | null;
  targetPath?: string | null;
  detail?: string | null;
}

export interface AgentSkillSnapshot {
  adapterType: string;
  supported: boolean;
  mode: AgentSkillSyncMode;
  desiredSkills: string[];
  entries: AgentSkillEntry[];
  warnings: string[];
}

export interface AgentSkillSyncRequest {
  desiredSkills: string[];
}
