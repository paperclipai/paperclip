export type CompanySkillSourceType = "local_path" | "github" | "url" | "catalog";

export type CompanySkillTrustLevel = "markdown_only" | "assets" | "scripts_executables";

export type CompanySkillCompatibility = "compatible" | "unknown" | "invalid";

export type CompanySkillSourceBadge = "paperclip" | "github" | "local" | "url" | "catalog";

export interface CompanySkillFileInventoryEntry {
  path: string;
  kind: "skill" | "markdown" | "reference" | "script" | "asset" | "other";
}

export interface CompanySkill {
  id: string;
  companyId: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  sourceType: CompanySkillSourceType;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: CompanySkillTrustLevel;
  compatibility: CompanySkillCompatibility;
  fileInventory: CompanySkillFileInventoryEntry[];
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanySkillListItem extends CompanySkill {
  attachedAgentCount: number;
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: CompanySkillSourceBadge;
}

export interface CompanySkillUsageAgent {
  id: string;
  name: string;
  urlKey: string;
  adapterType: string;
  desired: boolean;
  actualState: string | null;
}

export interface CompanySkillDetail extends CompanySkill {
  attachedAgentCount: number;
  usedByAgents: CompanySkillUsageAgent[];
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: CompanySkillSourceBadge;
}

export interface CompanySkillUpdateStatus {
  supported: boolean;
  reason: string | null;
  trackingRef: string | null;
  currentRef: string | null;
  latestRef: string | null;
  hasUpdate: boolean;
}

export interface CompanySkillImportRequest {
  source: string;
}

export interface CompanySkillImportResult {
  imported: CompanySkill[];
  warnings: string[];
}

export interface CompanySkillCreateRequest {
  name: string;
  slug?: string | null;
  description?: string | null;
  markdown?: string | null;
}

export interface CompanySkillFileDetail {
  skillId: string;
  path: string;
  kind: CompanySkillFileInventoryEntry["kind"];
  content: string;
  language: string | null;
  markdown: boolean;
  editable: boolean;
}

export interface CompanySkillFileUpdateRequest {
  path: string;
  content: string;
}
