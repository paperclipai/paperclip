export type Rt2RolloutSsoProvider = "google" | "microsoft" | "okta" | "custom";

export type Rt2RolloutBindingMode = "local_trusted" | "authenticated" | "lan" | "tailnet" | "cloud";

export type Rt2RolloutPolicyDefault = "operator_safe" | "strict_enterprise" | "pilot_friendly";

export type Rt2TemplatePlanAction = "create" | "skip" | "error";

export interface Rt2TemplatePlanItem {
  kind: "budget_policy" | "routine" | "skill" | "department" | "agent_config";
  name: string;
  action: Rt2TemplatePlanAction;
  reason: string;
  existingId: string | null;
  createdId?: string | null;
}

export interface Rt2TemplateApplicationPreview {
  templateId: string;
  templateName: string;
  targetCompanyId: string;
  summary: {
    create: number;
    skip: number;
    error: number;
  };
  items: Rt2TemplatePlanItem[];
  errors: string[];
}

export interface Rt2TemplateApplicationResult extends Rt2TemplateApplicationPreview {
  success: boolean;
  appliedAt: string;
}

export type Rt2RolloutEvidenceStatus = "ready" | "partial" | "missing";

export type Rt2RolloutValidationStatus = "pass" | "warning" | "fail";

export interface Rt2RolloutValidationCheck {
  key: string;
  label: string;
  status: Rt2RolloutValidationStatus;
  detail: string;
}

export interface Rt2RolloutSsoValidationInput {
  provider: Rt2RolloutSsoProvider;
  issuerUrl?: string | null;
  metadataUrl?: string | null;
  certificate?: string | null;
  callbackUrl?: string | null;
}

export interface Rt2RolloutSsoValidationResult {
  provider: Rt2RolloutSsoProvider;
  status: Rt2RolloutValidationStatus;
  checkedAt: string;
  certificateExpiresAt: string | null;
  checks: Rt2RolloutValidationCheck[];
  warnings: string[];
}

export type Rt2ScimPreviewAction = "create" | "update" | "deactivate";

export interface Rt2ScimSourceUser {
  externalId: string;
  email: string;
  displayName?: string | null;
  role?: string | null;
  active?: boolean;
}

export interface Rt2ScimSourceGroup {
  externalId: string;
  displayName: string;
  memberExternalIds?: string[];
}

export interface Rt2ScimSyncPreviewInput {
  users?: Rt2ScimSourceUser[];
  groups?: Rt2ScimSourceGroup[];
}

export interface Rt2ScimSyncPreviewCandidate {
  kind: "user" | "group";
  action: Rt2ScimPreviewAction;
  externalId: string;
  label: string;
  reason: string;
  warnings: string[];
}

export interface Rt2ScimSyncPreviewResult {
  status: Rt2RolloutValidationStatus;
  checkedAt: string;
  summary: {
    create: number;
    update: number;
    deactivate: number;
    warnings: number;
  };
  candidates: Rt2ScimSyncPreviewCandidate[];
  warnings: string[];
}

export interface Rt2RolloutEvidenceItem {
  area: "sso" | "scim" | "template" | "binding" | "policy";
  status: Rt2RolloutEvidenceStatus;
  label: string;
  detail: string;
  recordIds: string[];
  warnings: string[];
}

export interface Rt2RolloutReadinessItem {
  area: "sso" | "scim" | "binding" | "policy";
  label: string;
  status: Rt2RolloutValidationStatus;
  detail: string;
  checks: Rt2RolloutValidationCheck[];
  warnings: string[];
}

export interface Rt2RolloutAuditEntry {
  id: string;
  action: string;
  actorType: string;
  actorId: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  details: Record<string, unknown> | null;
}

export interface Rt2EnterpriseRolloutOverview {
  companyId: string;
  ssoConnections: Array<{
    id: string;
    provider: string;
    isActive: boolean;
    autoProvision: boolean;
    defaultRole: string | null;
    syncStatus: string;
    issuerUrl: string | null;
    metadataUrl: string | null;
  }>;
  templates: Array<{
    id: string;
    name: string;
    category: string;
    version: string;
    isPublic: boolean;
    usageCount: number;
  }>;
  tenantPolicy: {
    id: string;
    policyType: string;
    isolationLevel: string;
    isActive: boolean;
    auditLogging: boolean;
    dataResidency: string;
    retentionDays: number;
  } | null;
  bindingModes: Array<{
    id: string;
    mode: string;
    environment: string;
    isActive: boolean;
    requireAuth: boolean;
    bindHost: string;
    port: number;
    allowedHosts: string[];
    corsOrigins: string[];
  }>;
  evidence: {
      overallStatus: Rt2RolloutEvidenceStatus;
    readyCount: number;
    partialCount: number;
    missingCount: number;
    items: Rt2RolloutEvidenceItem[];
  };
  ssoValidation: Rt2RolloutSsoValidationResult | null;
  scimPreview: Rt2ScimSyncPreviewResult | null;
  readiness: {
    overallStatus: Rt2RolloutValidationStatus;
    items: Rt2RolloutReadinessItem[];
  };
  auditLog: Rt2RolloutAuditEntry[];
  recommendedDefaults: {
    ssoProvider: Rt2RolloutSsoProvider;
    bindingMode: Rt2RolloutBindingMode;
    policyDefault: Rt2RolloutPolicyDefault;
    templateCategory: string;
  };
}

export interface Rt2EnterpriseRolloutSettingsInput {
  sso?: {
    provider: Rt2RolloutSsoProvider;
    issuerUrl?: string | null;
    metadataUrl?: string | null;
    certificate?: string | null;
    callbackUrl?: string | null;
    autoProvision: boolean;
    defaultRole?: string | null;
  };
  binding?: {
    mode: Rt2RolloutBindingMode;
    environment: string;
    bindHost: string;
    port: number;
    requireAuth: boolean;
    allowedHosts?: string[];
    corsOrigins?: string[];
  };
  policy?: {
    policyDefault: Rt2RolloutPolicyDefault;
    dataResidency?: string | null;
    retentionDays?: number | null;
    auditLogging: boolean;
  };
  template?: {
    name: string;
    category: string;
    description?: string | null;
    isPublic?: boolean;
  };
}

export interface Rt2EnterpriseRolloutSettingsResult {
  overview: Rt2EnterpriseRolloutOverview;
  changed: Array<"sso" | "binding" | "policy" | "template">;
}
