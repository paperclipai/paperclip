import type {
  GoalLevel,
  GoalStatus,
  IssuePriority,
  IssueStatus,
  ProjectStatus,
} from "../constants.js";

export interface CompanyPortabilityInclude {
  company: boolean;
  agents: boolean;
  goals: boolean;
  projects: boolean;
  issues: boolean;
}

export interface CompanyPortabilitySecretRequirement {
  key: string;
  description: string | null;
  agentSlug: string | null;
  providerHint: string | null;
}

export interface CompanyPortabilityCompanyManifestEntry {
  path: string;
  name: string;
  description: string | null;
  brandColor: string | null;
  requireBoardApprovalForNewAgents: boolean;
}

export interface CompanyPortabilityAgentManifestEntry {
  slug: string;
  name: string;
  path: string;
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

export interface CompanyPortabilityGoalManifestEntry {
  key: string;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentKey: string | null;
  ownerAgentSlug: string | null;
}

export interface CompanyPortabilityProjectWorkspaceManifestEntry {
  name: string;
  cwd: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  metadata: Record<string, unknown> | null;
  isPrimary: boolean;
}

export interface CompanyPortabilityProjectManifestEntry {
  key: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  goalKeys: string[];
  leadAgentSlug: string | null;
  targetDate: string | null;
  color: string | null;
  workspaces: CompanyPortabilityProjectWorkspaceManifestEntry[];
}

export interface CompanyPortabilityIssueManifestEntry {
  key: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  projectKey: string | null;
  goalKey: string | null;
  parentKey: string | null;
  assigneeAgentSlug: string | null;
  requestDepth: number;
  billingCode: string | null;
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
  goals: CompanyPortabilityGoalManifestEntry[];
  projects: CompanyPortabilityProjectManifestEntry[];
  issues: CompanyPortabilityIssueManifestEntry[];
  requiredSecrets: CompanyPortabilitySecretRequirement[];
}

export interface CompanyPortabilityExportResult {
  manifest: CompanyPortabilityManifest;
  files: Record<string, string>;
  warnings: string[];
}

export type CompanyPortabilitySource =
  | {
      type: "inline";
      manifest: CompanyPortabilityManifest;
      files: Record<string, string>;
    }
  | {
      type: "builtin";
      templateId: string;
    }
  | {
      type: "url";
      url: string;
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
}

export interface CompanyPortabilityPreviewAgentPlan {
  slug: string;
  action: "create" | "update" | "skip";
  plannedName: string;
  existingAgentId: string | null;
  reason: string | null;
}

export interface CompanyPortabilityPreviewGoalPlan {
  key: string;
  action: "create" | "update" | "skip";
  plannedTitle: string;
  existingGoalId: string | null;
  reason: string | null;
}

export interface CompanyPortabilityPreviewProjectPlan {
  key: string;
  action: "create" | "update" | "skip";
  plannedName: string;
  existingProjectId: string | null;
  reason: string | null;
}

export interface CompanyPortabilityPreviewIssuePlan {
  key: string;
  action: "create" | "update" | "skip";
  plannedTitle: string;
  existingIssueId: string | null;
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
    goalPlans: CompanyPortabilityPreviewGoalPlan[];
    projectPlans: CompanyPortabilityPreviewProjectPlan[];
    issuePlans: CompanyPortabilityPreviewIssuePlan[];
  };
  requiredSecrets: CompanyPortabilitySecretRequirement[];
  warnings: string[];
  errors: string[];
}

export interface CompanyPortabilityImportRequest extends CompanyPortabilityPreviewRequest {}

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
  goals: {
    key: string;
    id: string | null;
    action: "created" | "updated" | "skipped";
    title: string;
    reason: string | null;
  }[];
  projects: {
    key: string;
    id: string | null;
    action: "created" | "updated" | "skipped";
    name: string;
    reason: string | null;
  }[];
  issues: {
    key: string;
    id: string | null;
    action: "created" | "updated" | "skipped";
    title: string;
    reason: string | null;
  }[];
  requiredSecrets: CompanyPortabilitySecretRequirement[];
  warnings: string[];
}

export interface CompanyPortabilityExportRequest {
  include?: Partial<CompanyPortabilityInclude>;
}

export interface CompanyTemplateCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string | null;
  maturity: string | null;
  riskProfile: string | null;
  tags: string[];
  useCases: string[];
  recommendedFor: string[];
  recommended: boolean;
  icon: string | null;
  agentCount: number;
  includes: CompanyPortabilityInclude;
  companyName: string | null;
}

export interface CompanyTemplateDetail extends CompanyTemplateCatalogEntry {
  manifest: CompanyPortabilityManifest;
  setupMarkdown: string | null;
}
