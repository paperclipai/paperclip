export interface CompanyPortabilityInclude {
  company: boolean;
  agents: boolean;
  projects: boolean;
  issues: boolean;
  skills: boolean;
}

export interface CompanyPortabilityEnvInput {
  key: string;
  description: string | null;
  agentSlug: string | null;
  kind: "secret" | "plain";
  requirement: "required" | "optional";
  defaultValue: string | null;
  portability: "portable" | "system_dependent";
}

export type CompanyPortabilityFileEntry =
  | string
  | {
      encoding: "base64";
      data: string;
      contentType?: string | null;
    };

export interface CompanyPortabilityCompanyManifestEntry {
  path: string;
  name: string;
  description: string | null;
  brandColor: string | null;
  logoPath: string | null;
  requireBoardApprovalForNewAgents: boolean;
}

export interface CompanyPortabilityProjectManifestEntry {
  slug: string;
  name: string;
  path: string;
  description: string | null;
  ownerAgentSlug: string | null;
  leadAgentSlug: string | null;
  targetDate: string | null;
  color: string | null;
  status: string | null;
  executionWorkspacePolicy: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export interface CompanyPortabilityIssueManifestEntry {
  slug: string;
  identifier: string | null;
  title: string;
  path: string;
  projectSlug: string | null;
  assigneeAgentSlug: string | null;
  description: string | null;
  recurrence: Record<string, unknown> | null;
  status: string | null;
  priority: string | null;
  labelIds: string[];
  billingCode: string | null;
  executionWorkspaceSettings: Record<string, unknown> | null;
  assigneeAdapterOverrides: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export interface CompanyPortabilityAgentManifestEntry {
  slug: string;
  name: string;
  path: string;
  skills: string[];
  role: string;
  title: string | null;
  icon: string | null;
  capabilities: string | null;
  reportsToSlug: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  permissions: Record<string, unknown>;
  budgetMonthlyCents: number;
  metadata: Record<string, unknown> | null;
}

export interface CompanyPortabilitySkillManifestEntry {
  key: string;
  slug: string;
  name: string;
  path: string;
  description: string | null;
  sourceType: string;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: string | null;
  compatibility: string | null;
  metadata: Record<string, unknown> | null;
  fileInventory: Array<{
    path: string;
    kind: string;
  }>;
}

export interface CompanyPortabilityManifest {
  schemaVersion: number;
  generatedAt: string;
  source: {
    companyId: string;
    companyName: string;
  } | null;
  includes: CompanyPortabilityInclude;
  company: CompanyPortabilityCompanyManifestEntry | null;
  agents: CompanyPortabilityAgentManifestEntry[];
  skills: CompanyPortabilitySkillManifestEntry[];
  projects: CompanyPortabilityProjectManifestEntry[];
  issues: CompanyPortabilityIssueManifestEntry[];
  envInputs: CompanyPortabilityEnvInput[];
}

export interface CompanyPortabilityExportResult {
  rootPath: string;
  manifest: CompanyPortabilityManifest;
  files: Record<string, CompanyPortabilityFileEntry>;
  warnings: string[];
  paperclipExtensionPath: string;
}

export interface CompanyPortabilityExportPreviewFile {
  path: string;
  kind: "company" | "agent" | "skill" | "project" | "issue" | "extension" | "readme" | "other";
}

export interface CompanyPortabilityExportPreviewResult {
  rootPath: string;
  manifest: CompanyPortabilityManifest;
  files: Record<string, CompanyPortabilityFileEntry>;
  fileInventory: CompanyPortabilityExportPreviewFile[];
  counts: {
    files: number;
    agents: number;
    skills: number;
    projects: number;
    issues: number;
  };
  warnings: string[];
  paperclipExtensionPath: string;
}

export type CompanyPortabilitySource =
  | {
      type: "inline";
      rootPath?: string | null;
      files: Record<string, CompanyPortabilityFileEntry>;
    }
  | {
      type: "github";
      url: string;
    };

export type CompanyPortabilityImportTarget =
  | {
      mode: "new_company";
      newCompanyName?: string | null;
    }
  | {
      mode: "existing_company";
      companyId: string;
    };

export type CompanyPortabilityAgentSelection = "all" | string[];

export type CompanyPortabilityCollisionStrategy = "rename" | "skip" | "replace";

export interface CompanyPortabilityPreviewRequest {
  source: CompanyPortabilitySource;
  include?: Partial<CompanyPortabilityInclude>;
  target: CompanyPortabilityImportTarget;
  agents?: CompanyPortabilityAgentSelection;
  collisionStrategy?: CompanyPortabilityCollisionStrategy;
  nameOverrides?: Record<string, string>;
  selectedFiles?: string[];
}

export interface CompanyPortabilityPreviewAgentPlan {
  slug: string;
  action: "create" | "update" | "skip";
  plannedName: string;
  existingAgentId: string | null;
  reason: string | null;
}

export interface CompanyPortabilityPreviewProjectPlan {
  slug: string;
  action: "create" | "update" | "skip";
  plannedName: string;
  existingProjectId: string | null;
  reason: string | null;
}

export interface CompanyPortabilityPreviewIssuePlan {
  slug: string;
  action: "create" | "skip";
  plannedTitle: string;
  reason: string | null;
}

export interface CompanyPortabilityPreviewResult {
  include: CompanyPortabilityInclude;
  targetCompanyId: string | null;
  targetCompanyName: string | null;
  collisionStrategy: CompanyPortabilityCollisionStrategy;
  selectedAgentSlugs: string[];
  plan: {
    companyAction: "none" | "create" | "update";
    agentPlans: CompanyPortabilityPreviewAgentPlan[];
    projectPlans: CompanyPortabilityPreviewProjectPlan[];
    issuePlans: CompanyPortabilityPreviewIssuePlan[];
  };
  manifest: CompanyPortabilityManifest;
  files: Record<string, CompanyPortabilityFileEntry>;
  envInputs: CompanyPortabilityEnvInput[];
  warnings: string[];
  errors: string[];
}

export interface CompanyPortabilityAdapterOverride {
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
}

export interface CompanyPortabilityImportRequest extends CompanyPortabilityPreviewRequest {
  adapterOverrides?: Record<string, CompanyPortabilityAdapterOverride>;
}

export interface CompanyPortabilityImportResult {
  company: {
    id: string;
    name: string;
    action: "created" | "updated" | "unchanged";
  };
  agents: {
    slug: string;
    id: string | null;
    action: "created" | "updated" | "skipped";
    name: string;
    reason: string | null;
  }[];
  envInputs: CompanyPortabilityEnvInput[];
  warnings: string[];
}

export interface CompanyPortabilityExportRequest {
  include?: Partial<CompanyPortabilityInclude>;
  agents?: string[];
  skills?: string[];
  projects?: string[];
  issues?: string[];
  projectIssues?: string[];
  selectedFiles?: string[];
  expandReferencedSkills?: boolean;
}
