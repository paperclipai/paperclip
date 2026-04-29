import { createHash, X509Certificate } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  rt2EnterpriseConnectorEvidence,
  rt2SsoConnections,
  rt2CompanyTemplates,
  rt2TenantPolicies,
  rt2BindingModes,
} from "@paperclipai/db";
import type {
  Rt2EnterpriseRolloutOverview,
  Rt2EnterpriseRolloutSettingsInput,
  Rt2EnterpriseRolloutSettingsResult,
  Rt2RolloutEvidenceItem,
  Rt2RolloutPolicyDefault,
  Rt2RolloutReadinessItem,
  Rt2RolloutSsoValidationInput,
  Rt2RolloutSsoValidationResult,
  Rt2RolloutValidationCheck,
  Rt2RolloutValidationStatus,
  Rt2EnterpriseConnectorError,
  Rt2EnterpriseConnectorFailureReason,
  Rt2ScimApplyCandidateResult,
  Rt2ScimApplyRequest,
  Rt2ScimApplyResult,
  Rt2ScimRollbackCandidate,
  Rt2ScimSyncPreviewInput,
  Rt2ScimSyncPreviewCandidate,
  Rt2ScimSyncPreviewResult,
} from "@paperclipai/shared";

export type SsoConnection = {
  id: string;
  companyId: string;
  provider: string;
  providerConfig: Record<string, unknown> | null;
  isActive: boolean;
  clientId: string | null;
  clientSecret: string | null;
  issuerUrl: string | null;
  metadataUrl: string | null;
  certificate: string | null;
  userMapping: {
    emailField: string;
    nameField: string;
    roleField?: string;
  } | null;
  autoProvision: boolean;
  defaultRole: string | null;
  lastSyncAt: Date | null;
  syncStatus: string;
  syncError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CompanyTemplate = {
  id: string;
  name: string;
  description: string | null;
  category: string;
  version: string;
  isPublic: boolean;
  authorCompanyId: string | null;
  templateData: {
    departments: Array<{
      name: string;
      roles: string[];
      headRole: string;
    }>;
    workflows: Array<{
      name: string;
      steps: string[];
      approvals: string[];
    }>;
    skills: string[];
    budgetPolicy: {
      monthlyBudgetCents: number;
      alertsAtPercent: number[];
    };
    governance: {
      requireApprovalForHires: boolean;
      requireApprovalForBudget: boolean;
      maxAgentBudgetCents: number;
    };
    agentConfigs: Array<{
      role: string;
      adapterType: string;
      capabilities: string[];
      monthlyBudgetCents: number;
    }>;
  };
  usageCount: number;
  ratingAverage: number;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type TenantPolicy = {
  id: string;
  companyId: string;
  policyType: string;
  isolationLevel: string;
  dataIsolation: {
    separateDatabases: boolean;
    separateSchemas: boolean;
    rowLevelSecurity: boolean;
  };
  resourceSharing: {
    sharedAgents: boolean;
    sharedSkills: boolean;
    sharedTemplates: boolean;
    crossTenantCommunication: boolean;
  };
  networkPolicy: {
    allowedIpRanges: string[];
    requireVpn: boolean;
    enforceSsl: boolean;
  };
  complianceConfig: {
    dataResidency: string;
    retentionDays: number;
    auditLogging: boolean;
    encryptionAtRest: boolean;
  };
  quotas: {
    maxUsers: number;
    maxAgents: number;
    maxStorageBytes: number;
    maxApiCallsPerMonth: number;
  };
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type BindingMode = {
  id: string;
  companyId: string;
  mode: string;
  networkConfig: {
    allowedHosts: string[];
    bindHost: string;
    port: number;
    corsOrigins: string[];
  };
  securityConfig: {
    requireAuth: boolean;
    sessionExpiryHours: number;
    maxSessionAge: number;
    allowAnonymousRead: boolean;
  };
  environment: string;
  isActive: boolean;
  lastConfigAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function rt2EnterpriseService(db: Db) {
  const rolloutAuditActions = [
    "rt2.rollout.settings_saved",
    "rt2.rollout.sso_validated",
    "rt2.rollout.sso_handshake_validated",
    "rt2.rollout.scim_previewed",
    "rt2.rollout.scim_applied",
  ];

  function parseUrl(value: string | null | undefined): URL | null {
    if (!value?.trim()) return null;
    try {
      const parsed = new URL(value.trim());
      return parsed.protocol === "https:" ? parsed : null;
    } catch {
      return null;
    }
  }

  function worstStatus(checks: Rt2RolloutValidationCheck[]): Rt2RolloutValidationStatus {
    if (checks.some((check) => check.status === "fail")) return "fail";
    if (checks.some((check) => check.status === "warning")) return "warning";
    return "pass";
  }

  function toEvidenceStatus(status: Rt2RolloutValidationStatus) {
    if (status === "pass") return "ready" as const;
    if (status === "warning") return "partial" as const;
    return "missing" as const;
  }

  function stableJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }

  function fingerprint(value: unknown): string {
    return createHash("sha256").update(stableJson(value)).digest("hex");
  }

  function stableCandidateId(candidate: Pick<Rt2ScimSyncPreviewCandidate, "kind" | "action" | "externalId">) {
    return `${candidate.kind}:${candidate.action}:${candidate.externalId.trim().toLowerCase()}`;
  }

  function failureReasonsFromChecks(checks: Rt2RolloutValidationCheck[]): Rt2EnterpriseConnectorFailureReason[] {
    return checks
      .filter((check) => check.status === "fail")
      .map((check) => ({
        code: check.key,
        message: check.detail,
        field: check.key,
      }));
  }

  function connectorError(
    statusCode: Rt2EnterpriseConnectorError["statusCode"],
    code: Rt2EnterpriseConnectorError["code"],
    message: string,
    field?: string,
  ): Rt2EnterpriseConnectorError {
    return {
      ok: false,
      statusCode,
      code,
      message,
      failureReasons: [{ code, message, field }],
    };
  }

  function validateSsoProviderMetadata(input: Rt2RolloutSsoValidationInput): Rt2RolloutSsoValidationResult {
    const checks: Rt2RolloutValidationCheck[] = [];
    const provider = input.provider ?? "custom";
    const issuer = parseUrl(input.issuerUrl);
    const metadata = parseUrl(input.metadataUrl);
    const callback = parseUrl(input.callbackUrl);
    let certificateExpiresAt: string | null = null;

    checks.push({
      key: "issuer",
      label: "Issuer URL",
      status: issuer ? "pass" : "fail",
      detail: issuer ? `HTTPS issuer accepted: ${issuer.origin}` : "Issuer URL must be a valid HTTPS URL.",
    });

    checks.push({
      key: "metadata",
      label: "Metadata URL",
      status: metadata ? "pass" : "warning",
      detail: metadata
        ? `Metadata URL accepted: ${metadata.href}`
        : "Metadata URL is optional, but missing metadata limits provider auto-discovery.",
    });

    if (input.certificate?.trim()) {
      try {
        const cert = new X509Certificate(input.certificate.trim());
        const validTo = new Date(cert.validTo);
        certificateExpiresAt = validTo.toISOString();
        const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
        checks.push({
          key: "certificate",
          label: "Certificate expiry",
          status: daysRemaining >= 30 ? "pass" : daysRemaining >= 0 ? "warning" : "fail",
          detail: daysRemaining >= 0
            ? `Certificate expires in ${daysRemaining} days.`
            : "Certificate is expired.",
        });
      } catch {
        checks.push({
          key: "certificate",
          label: "Certificate expiry",
          status: "fail",
          detail: "Certificate could not be parsed as X.509 PEM text.",
        });
      }
    } else {
      checks.push({
        key: "certificate",
        label: "Certificate expiry",
        status: "warning",
        detail: "Certificate was not provided, so expiry cannot be verified.",
      });
    }

    checks.push({
      key: "callback",
      label: "Callback URL",
      status: callback && /\/(auth|sso)\/callback\b/.test(callback.pathname) ? "pass" : "fail",
      detail: callback
        ? "Callback URL must be HTTPS and include /auth/callback or /sso/callback."
        : "Callback URL must be a valid HTTPS URL.",
    });

    const status = worstStatus(checks);
    return {
      provider,
      status,
      checkedAt: new Date().toISOString(),
      certificateExpiresAt,
      checks,
      warnings: checks.filter((check) => check.status !== "pass").map((check) => check.detail),
    };
  }

  async function validateSsoHandshake(
    companyId: string,
    input: Rt2RolloutSsoValidationInput,
  ): Promise<Rt2RolloutSsoValidationResult> {
    const base = validateSsoProviderMetadata(input);
    const expectedState = input.expectedCallbackState?.trim() ?? "";
    const callbackState = input.callbackState?.trim() ?? "";
    const callbackStateChecks: Rt2RolloutValidationCheck[] = [];

    if (expectedState && callbackState) {
      callbackStateChecks.push({
        key: "callback-state",
        label: "Callback state",
        status: expectedState === callbackState ? "pass" : "fail",
        detail: expectedState === callbackState
          ? "Callback state matches the expected rollout challenge."
          : "Callback state does not match the expected rollout challenge.",
      });
    } else if (expectedState && !callbackState) {
      callbackStateChecks.push({
        key: "callback-state",
        label: "Callback state",
        status: "fail",
        detail: "Callback state is required when an expected rollout challenge is supplied.",
      });
    } else {
      callbackStateChecks.push({
        key: "callback-state",
        label: "Callback state",
        status: "warning",
        detail: "Callback state was not supplied; metadata validation evidence is persisted without a callback replay check.",
      });
    }

    const checks = [...base.checks, ...callbackStateChecks];
    const status = worstStatus(checks);
    const failureReasons = failureReasonsFromChecks(checks);
    const result = {
      ...base,
      status,
      checks,
      callbackStateChecks,
      failureReasons,
      warnings: checks.filter((check) => check.status !== "pass").map((check) => check.detail),
    };

    const [row] = await db.insert(rt2EnterpriseConnectorEvidence).values({
      companyId,
      connectorKind: "sso",
      evidenceType: "sso_handshake",
      status,
      provider: result.provider,
      summary: {
        provider: result.provider,
        status,
        checkedAt: result.checkedAt,
        certificateExpiresAt: result.certificateExpiresAt,
        warnings: result.warnings,
      },
      checks,
      failureReasons,
    }).returning();

    return {
      ...result,
      evidenceId: row.id,
    };
  }

  function previewScimSync(input: Rt2ScimSyncPreviewInput = {}): Rt2ScimSyncPreviewResult {
    const users = input.users ?? [];
    const groups = input.groups ?? [];
    const candidates: Rt2ScimSyncPreviewResult["candidates"] = [];

    for (const user of users) {
      const warnings: string[] = [];
      if (!user.email.includes("@")) warnings.push("User email is not a valid address.");
      if (user.active === false) warnings.push("Inactive source user will be proposed for deactivation.");
      const action = user.active === false
        ? "deactivate"
        : user.role || user.displayName
          ? "update"
          : "create";
      candidates.push({
        kind: "user",
        action,
        externalId: user.externalId,
        label: user.displayName || user.email,
        reason: action === "deactivate"
          ? "Source marks this user inactive."
          : action === "update"
            ? "Source user contains role or profile fields to sync."
            : "Source user has no matching RT2 evidence in preview mode.",
        warnings,
      });
    }

    for (const group of groups) {
      const memberCount = group.memberExternalIds?.length ?? 0;
      const warnings = memberCount === 0 ? ["Group has no members in source payload."] : [];
      candidates.push({
        kind: "group",
        action: memberCount > 0 ? "update" : "create",
        externalId: group.externalId,
        label: group.displayName,
        reason: memberCount > 0
          ? `${memberCount} source member mapping(s) would be reconciled.`
          : "Empty group would be created only after operator review.",
        warnings,
      });
    }

    const summary = {
      create: candidates.filter((candidate) => candidate.action === "create").length,
      update: candidates.filter((candidate) => candidate.action === "update").length,
      deactivate: candidates.filter((candidate) => candidate.action === "deactivate").length,
      warnings: candidates.reduce((count, candidate) => count + candidate.warnings.length, 0),
    };
    const warnings = [
      ...candidates.flatMap((candidate) => candidate.warnings),
      ...(summary.deactivate > 0 ? [`${summary.deactivate} deactivate candidate(s) require operator approval before apply.`] : []),
    ];
    return {
      status: warnings.length > 0 ? "warning" : candidates.length > 0 ? "pass" : "fail",
      checkedAt: new Date().toISOString(),
      summary,
      candidates,
      warnings: candidates.length > 0 ? warnings : ["No SCIM users or groups were provided for preview."],
    };
  }

  async function createScimPreview(
    companyId: string,
    input: Rt2ScimSyncPreviewInput = {},
  ): Promise<Rt2ScimSyncPreviewResult> {
    const preview = previewScimSync(input);
    const candidates = preview.candidates
      .map((candidate) => ({ ...candidate, id: stableCandidateId(candidate) }))
      .sort((left, right) => (left.id ?? "").localeCompare(right.id ?? ""));
    const normalizedSource = {
      users: [...(input.users ?? [])].sort((left, right) => left.externalId.localeCompare(right.externalId)),
      groups: [...(input.groups ?? [])].sort((left, right) => left.externalId.localeCompare(right.externalId)),
      candidates,
      summary: preview.summary,
      warnings: preview.warnings,
    };
    const previewFingerprint = fingerprint(normalizedSource);
    const [row] = await db.insert(rt2EnterpriseConnectorEvidence).values({
      companyId,
      connectorKind: "scim",
      evidenceType: "scim_preview",
      status: preview.status,
      sourceLabel: "operator_payload",
      fingerprint: previewFingerprint,
      summary: preview.summary,
      candidates,
      failureReasons: failureReasonsFromChecks(
        candidates.flatMap((candidate) => candidate.warnings.map((warning, index) => ({
          key: `${candidate.id}:warning:${index}`,
          label: candidate.label,
          status: "warning" as const,
          detail: warning,
        }))),
      ),
    }).returning();

    return {
      ...preview,
      previewId: row.id,
      previewFingerprint,
      candidates,
    };
  }

  async function applyScimPreview(
    companyId: string,
    input: Rt2ScimApplyRequest,
  ): Promise<Rt2ScimApplyResult | Rt2EnterpriseConnectorError> {
    if (!input.previewId || !input.previewFingerprint || input.selectedCandidateIds.length === 0) {
      return connectorError(400, "invalid_apply_request", "previewId, previewFingerprint, and selectedCandidateIds are required.");
    }

    const [previewRow] = await db
      .select()
      .from(rt2EnterpriseConnectorEvidence)
      .where(and(
        eq(rt2EnterpriseConnectorEvidence.companyId, companyId),
        eq(rt2EnterpriseConnectorEvidence.id, input.previewId),
        eq(rt2EnterpriseConnectorEvidence.evidenceType, "scim_preview"),
      ))
      .limit(1);

    if (!previewRow) {
      return connectorError(404, "missing_preview", "SCIM preview evidence was not found for this company.", "previewId");
    }
    if (previewRow.fingerprint !== input.previewFingerprint) {
      return connectorError(409, "stale_preview", "SCIM preview fingerprint is stale. Re-run preview before apply.", "previewFingerprint");
    }

    const candidates = (previewRow.candidates as Rt2ScimSyncPreviewCandidate[]).map((candidate) => ({
      ...candidate,
      id: candidate.id ?? stableCandidateId(candidate),
    }));
    const selectedIds = new Set(input.selectedCandidateIds);
    const selected = candidates.filter((candidate) => candidate.id && selectedIds.has(candidate.id));

    if (selected.some((candidate) => candidate.action === "deactivate") && !input.acknowledgeDeactivations) {
      return connectorError(
        400,
        "deactivate_acknowledgement_required",
        "Deactivate candidates require explicit acknowledgement before apply.",
        "acknowledgeDeactivations",
      );
    }

    const rollbackCandidates: Rt2ScimRollbackCandidate[] = [];
    const results: Rt2ScimApplyCandidateResult[] = candidates.map((candidate) => {
      const candidateId = candidate.id ?? stableCandidateId(candidate);
      if (!selectedIds.has(candidateId)) {
        return {
          candidateId,
          kind: candidate.kind,
          action: candidate.action,
          externalId: candidate.externalId,
          label: candidate.label,
          status: "skipped",
          reason: "Candidate was not selected for this apply run.",
          rollbackCandidate: null,
          failureReason: null,
        };
      }

      const invalidEmailWarning = candidate.warnings.find((warning) => warning.includes("not a valid address"));
      if (invalidEmailWarning) {
        return {
          candidateId,
          kind: candidate.kind,
          action: candidate.action,
          externalId: candidate.externalId,
          label: candidate.label,
          status: "failed",
          reason: invalidEmailWarning,
          rollbackCandidate: null,
          failureReason: {
            code: "candidate_validation_failed",
            message: invalidEmailWarning,
            field: candidateId,
          },
        };
      }

      const rollbackCandidate: Rt2ScimRollbackCandidate = {
        candidateId,
        kind: candidate.kind,
        externalId: candidate.externalId,
        action: candidate.action,
        priorState: candidate.action === "create" ? null : { externalId: candidate.externalId, label: candidate.label },
        targetState: { action: candidate.action, externalId: candidate.externalId, label: candidate.label },
        reason: "Phase 39 records rollback evidence for operator review; no automatic rollback is executed.",
      };
      rollbackCandidates.push(rollbackCandidate);
      return {
        candidateId,
        kind: candidate.kind,
        action: candidate.action,
        externalId: candidate.externalId,
        label: candidate.label,
        status: "applied",
        reason: "Candidate apply evidence recorded.",
        rollbackCandidate,
        failureReason: null,
      };
    });

    const applied = results.filter((candidate) => candidate.status === "applied").length;
    const failed = results.filter((candidate) => candidate.status === "failed").length;
    const skipped = results.filter((candidate) => candidate.status === "skipped").length;
    const status = failed > 0 && applied > 0 ? "partial" : failed > 0 ? "failed" : "applied";
    const failureReasons = results.flatMap((candidate) => candidate.failureReason ? [candidate.failureReason] : []);
    const appliedAt = new Date();
    const [row] = await db.insert(rt2EnterpriseConnectorEvidence).values({
      companyId,
      connectorKind: "scim",
      evidenceType: "scim_apply",
      status,
      sourceLabel: "operator_payload",
      previewEvidenceId: previewRow.id,
      fingerprint: previewRow.fingerprint,
      summary: {
        applied,
        skipped,
        failed,
        rollbackCandidates: rollbackCandidates.length,
      },
      candidates: results,
      rollbackCandidates,
      failureReasons,
      appliedAt,
    }).returning();

    return {
      evidenceId: row.id,
      previewId: previewRow.id,
      previewFingerprint: previewRow.fingerprint ?? "",
      status,
      appliedAt: appliedAt.toISOString(),
      summary: {
        applied,
        skipped,
        failed,
        rollbackCandidates: rollbackCandidates.length,
      },
      candidates: results,
      rollbackCandidates,
      failureReasons,
    };
  }

  async function getRolloutAuditLog(companyId: string) {
    const rows = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), inArray(activityLog.action, rolloutAuditActions)))
      .orderBy(desc(activityLog.createdAt))
      .limit(8);

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorType: row.actorType,
      actorId: row.actorId,
      entityType: row.entityType,
      entityId: row.entityId,
      createdAt: row.createdAt.toISOString(),
      details: row.details ?? null,
    }));
  }

  function tenantDefaults(policyDefault: Rt2RolloutPolicyDefault) {
    if (policyDefault === "strict_enterprise") {
      return {
        isolationLevel: "strict",
        dataIsolation: {
          separateDatabases: false,
          separateSchemas: true,
          rowLevelSecurity: true,
        },
        resourceSharing: {
          sharedAgents: false,
          sharedSkills: false,
          sharedTemplates: true,
          crossTenantCommunication: false,
        },
        complianceConfig: {
          dataResidency: "kr",
          retentionDays: 1095,
          auditLogging: true,
          encryptionAtRest: true,
        },
      };
    }
    if (policyDefault === "pilot_friendly") {
      return {
        isolationLevel: "shared",
        dataIsolation: {
          separateDatabases: false,
          separateSchemas: false,
          rowLevelSecurity: true,
        },
        resourceSharing: {
          sharedAgents: true,
          sharedSkills: true,
          sharedTemplates: true,
          crossTenantCommunication: false,
        },
        complianceConfig: {
          dataResidency: "kr",
          retentionDays: 365,
          auditLogging: true,
          encryptionAtRest: true,
        },
      };
    }
    return {
      isolationLevel: "strict",
      dataIsolation: {
        separateDatabases: false,
        separateSchemas: true,
        rowLevelSecurity: true,
      },
      resourceSharing: {
        sharedAgents: false,
        sharedSkills: true,
        sharedTemplates: true,
        crossTenantCommunication: false,
      },
      complianceConfig: {
        dataResidency: "kr",
        retentionDays: 730,
        auditLogging: true,
        encryptionAtRest: true,
      },
    };
  }

  // ===== SSO Connections =====

  /**
   * M3.5: Create SSO connection
   */
  async function createSsoConnection(
    companyId: string,
    provider: string,
    options?: {
      providerConfig?: Record<string, unknown>;
      clientId?: string;
      clientSecret?: string;
      issuerUrl?: string;
      metadataUrl?: string;
      certificate?: string;
      userMapping?: {
        emailField: string;
        nameField: string;
        roleField?: string;
      };
      autoProvision?: boolean;
      defaultRole?: string;
    },
  ): Promise<SsoConnection> {
    const [connection] = await db
      .insert(rt2SsoConnections)
      .values({
        companyId,
        provider,
        providerConfig: options?.providerConfig ?? null,
        clientId: options?.clientId ?? null,
        clientSecret: options?.clientSecret ?? null,
        issuerUrl: options?.issuerUrl ?? null,
        metadataUrl: options?.metadataUrl ?? null,
        certificate: options?.certificate ?? null,
        userMapping: options?.userMapping ?? null,
        autoProvision: options?.autoProvision ?? false,
        defaultRole: options?.defaultRole ?? null,
      })
      .returning();

    return connection as unknown as SsoConnection;
  }

  /**
   * M3.5: Get SSO connections for company
   */
  async function getSsoConnections(companyId: string): Promise<SsoConnection[]> {
    const connections = await db
      .select()
      .from(rt2SsoConnections)
      .where(eq(rt2SsoConnections.companyId, companyId))
      .orderBy(desc(rt2SsoConnections.createdAt));

    return connections as unknown as SsoConnection[];
  }

  /**
   * M3.5: Update SSO connection
   */
  async function updateSsoConnection(
    companyId: string,
    connectionId: string,
    updates: Partial<{
      isActive: boolean;
      providerConfig: Record<string, unknown>;
      clientId: string;
      clientSecret: string;
      issuerUrl: string;
      metadataUrl: string;
      certificate: string;
      userMapping: { emailField: string; nameField: string; roleField?: string };
      autoProvision: boolean;
      defaultRole: string;
    }>,
  ): Promise<SsoConnection> {
    const [updated] = await db
      .update(rt2SsoConnections)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(and(eq(rt2SsoConnections.id, connectionId), eq(rt2SsoConnections.companyId, companyId)))
      .returning();

    return updated as unknown as SsoConnection;
  }

  // ===== Company Templates =====

  /**
   * M3.5: Create company template
   */
  async function createCompanyTemplate(
    name: string,
    category: string,
    templateData: CompanyTemplate["templateData"],
    options?: {
      description?: string;
      isPublic?: boolean;
      authorCompanyId?: string;
    },
  ): Promise<CompanyTemplate> {
    const [template] = await db
      .insert(rt2CompanyTemplates)
      .values({
        name,
        description: options?.description ?? null,
        category,
        templateData: templateData as any,
        isPublic: options?.isPublic ?? false,
        authorCompanyId: options?.authorCompanyId ?? null,
      })
      .returning();

    return template as unknown as CompanyTemplate;
  }

  /**
   * M3.5: Get public templates
   */
  async function getPublicTemplates(category?: string): Promise<CompanyTemplate[]> {
    const conditions = [eq(rt2CompanyTemplates.isPublic, true)];
    if (category) {
      conditions.push(eq(rt2CompanyTemplates.category, category));
    }

    const templates = await db
      .select()
      .from(rt2CompanyTemplates)
      .where(and(...conditions))
      .orderBy(desc(rt2CompanyTemplates.ratingAverage));

    return templates as unknown as CompanyTemplate[];
  }

  /**
   * M3.5: Get templates by author company
   */
  async function getTemplatesByAuthor(authorCompanyId: string): Promise<CompanyTemplate[]> {
    const templates = await db
      .select()
      .from(rt2CompanyTemplates)
      .where(eq(rt2CompanyTemplates.authorCompanyId, authorCompanyId))
      .orderBy(desc(rt2CompanyTemplates.createdAt));

    return templates as unknown as CompanyTemplate[];
  }

  /**
   * M3.5: Increment template usage
   */
  async function incrementTemplateUsage(templateId: string): Promise<void> {
    await db
      .update(rt2CompanyTemplates)
      .set({
        usageCount: sql`${rt2CompanyTemplates.usageCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(rt2CompanyTemplates.id, templateId));
  }

  // ===== Tenant Policies =====

  /**
   * M3.5: Create tenant policy
   */
  async function createTenantPolicy(
    companyId: string,
    policyType: string,
    options?: {
      isolationLevel?: string;
      dataIsolation?: TenantPolicy["dataIsolation"];
      resourceSharing?: TenantPolicy["resourceSharing"];
      networkPolicy?: TenantPolicy["networkPolicy"];
      complianceConfig?: TenantPolicy["complianceConfig"];
      quotas?: TenantPolicy["quotas"];
    },
  ): Promise<TenantPolicy> {
    const [policy] = await db
      .insert(rt2TenantPolicies)
      .values({
        companyId,
        policyType,
        isolationLevel: options?.isolationLevel ?? "strict",
        dataIsolation: options?.dataIsolation ?? {
          separateDatabases: false,
          separateSchemas: true,
          rowLevelSecurity: true,
        },
        resourceSharing: options?.resourceSharing ?? {
          sharedAgents: false,
          sharedSkills: true,
          sharedTemplates: true,
          crossTenantCommunication: false,
        },
        networkPolicy: options?.networkPolicy ?? {
          allowedIpRanges: [],
          requireVpn: false,
          enforceSsl: true,
        },
        complianceConfig: options?.complianceConfig ?? {
          dataResidency: "us-east-1",
          retentionDays: 365,
          auditLogging: true,
          encryptionAtRest: true,
        },
        quotas: options?.quotas ?? {
          maxUsers: 100,
          maxAgents: 50,
          maxStorageBytes: 10 * 1024 * 1024 * 1024,
          maxApiCallsPerMonth: 1000000,
        },
      })
      .returning();

    return policy as unknown as TenantPolicy;
  }

  /**
   * M3.5: Get tenant policy for company
   */
  async function getTenantPolicy(companyId: string): Promise<TenantPolicy | null> {
    const [policy] = await db
      .select()
      .from(rt2TenantPolicies)
      .where(eq(rt2TenantPolicies.companyId, companyId))
      .limit(1);

    return (policy as unknown as TenantPolicy) ?? null;
  }

  /**
   * M3.5: Update tenant policy
   */
  async function updateTenantPolicy(
    companyId: string,
    policyId: string,
    updates: Partial<{
      isolationLevel: string;
      dataIsolation: TenantPolicy["dataIsolation"];
      resourceSharing: TenantPolicy["resourceSharing"];
      networkPolicy: TenantPolicy["networkPolicy"];
      complianceConfig: TenantPolicy["complianceConfig"];
      quotas: TenantPolicy["quotas"];
      isActive: boolean;
    }>,
  ): Promise<TenantPolicy> {
    const [updated] = await db
      .update(rt2TenantPolicies)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(and(eq(rt2TenantPolicies.id, policyId), eq(rt2TenantPolicies.companyId, companyId)))
      .returning();

    return updated as unknown as TenantPolicy;
  }

  // ===== Binding Modes =====

  /**
   * M3.5: Create binding mode
   */
  async function createBindingMode(
    companyId: string,
    mode: string,
    networkConfig: BindingMode["networkConfig"],
    options?: {
      securityConfig?: BindingMode["securityConfig"];
      environment?: string;
    },
  ): Promise<BindingMode> {
    const [binding] = await db
      .insert(rt2BindingModes)
      .values({
        companyId,
        mode,
        networkConfig,
        securityConfig: options?.securityConfig ?? {
          requireAuth: true,
          sessionExpiryHours: 24,
          maxSessionAge: 7,
          allowAnonymousRead: false,
        },
        environment: options?.environment ?? "production",
      })
      .returning();

    return binding as unknown as BindingMode;
  }

  /**
   * M3.5: Get binding modes for company
   */
  async function getBindingModes(companyId: string): Promise<BindingMode[]> {
    const bindings = await db
      .select()
      .from(rt2BindingModes)
      .where(eq(rt2BindingModes.companyId, companyId))
      .orderBy(desc(rt2BindingModes.createdAt));

    return bindings as unknown as BindingMode[];
  }

  /**
   * M3.5: Update binding mode
   */
  async function updateBindingMode(
    companyId: string,
    bindingId: string,
    updates: Partial<{
      networkConfig: BindingMode["networkConfig"];
      securityConfig: BindingMode["securityConfig"];
      isActive: boolean;
    }>,
  ): Promise<BindingMode> {
    const [updated] = await db
      .update(rt2BindingModes)
      .set({
        ...updates,
        lastConfigAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(rt2BindingModes.id, bindingId), eq(rt2BindingModes.companyId, companyId)))
      .returning();

    return updated as unknown as BindingMode;
  }

  async function getRolloutOverview(companyId: string): Promise<Rt2EnterpriseRolloutOverview> {
    const [connections, templates, policy, bindings] = await Promise.all([
      getSsoConnections(companyId),
      getTemplatesByAuthor(companyId),
      getTenantPolicy(companyId),
      getBindingModes(companyId),
    ]);
    const activeSso = connections.filter((connection) => connection.isActive);
    const activeBindings = bindings.filter((binding) => binding.isActive);
    const [latestSsoEvidence] = await db.select().from(rt2EnterpriseConnectorEvidence)
      .where(and(
        eq(rt2EnterpriseConnectorEvidence.companyId, companyId),
        eq(rt2EnterpriseConnectorEvidence.connectorKind, "sso"),
        eq(rt2EnterpriseConnectorEvidence.evidenceType, "sso_handshake"),
      ))
      .orderBy(desc(rt2EnterpriseConnectorEvidence.createdAt))
      .limit(1);
    const [latestScimApplyEvidence] = await db.select().from(rt2EnterpriseConnectorEvidence)
      .where(and(
        eq(rt2EnterpriseConnectorEvidence.companyId, companyId),
        eq(rt2EnterpriseConnectorEvidence.connectorKind, "scim"),
        eq(rt2EnterpriseConnectorEvidence.evidenceType, "scim_apply"),
      ))
      .orderBy(desc(rt2EnterpriseConnectorEvidence.createdAt))
      .limit(1);
    const [latestScimPreviewEvidence] = await db.select().from(rt2EnterpriseConnectorEvidence)
      .where(and(
        eq(rt2EnterpriseConnectorEvidence.companyId, companyId),
        eq(rt2EnterpriseConnectorEvidence.connectorKind, "scim"),
        eq(rt2EnterpriseConnectorEvidence.evidenceType, "scim_preview"),
      ))
      .orderBy(desc(rt2EnterpriseConnectorEvidence.createdAt))
      .limit(1);
    const ssoSummary = latestSsoEvidence?.summary as Partial<Rt2RolloutSsoValidationResult> | undefined;
    const ssoValidation = latestSsoEvidence
      ? {
          evidenceId: latestSsoEvidence.id,
          provider: (latestSsoEvidence.provider ?? ssoSummary?.provider ?? "custom") as Rt2RolloutSsoValidationInput["provider"],
          status: latestSsoEvidence.status as Rt2RolloutValidationStatus,
          checkedAt: typeof ssoSummary?.checkedAt === "string" ? ssoSummary.checkedAt : latestSsoEvidence.createdAt.toISOString(),
          certificateExpiresAt: typeof ssoSummary?.certificateExpiresAt === "string" ? ssoSummary.certificateExpiresAt : null,
          checks: latestSsoEvidence.checks as Rt2RolloutValidationCheck[],
          callbackStateChecks: (latestSsoEvidence.checks as Rt2RolloutValidationCheck[]).filter((check) => check.key === "callback-state"),
          failureReasons: latestSsoEvidence.failureReasons as Rt2EnterpriseConnectorFailureReason[],
          warnings: Array.isArray(ssoSummary?.warnings)
            ? ssoSummary.warnings as string[]
            : (latestSsoEvidence.checks as Rt2RolloutValidationCheck[]).filter((check) => check.status !== "pass").map((check) => check.detail),
        }
      : null;
    const emptyScimPreview = previewScimSync();
    const scimPreview = latestScimPreviewEvidence
      ? {
          previewId: latestScimPreviewEvidence.id,
          previewFingerprint: latestScimPreviewEvidence.fingerprint ?? "",
          status: latestScimPreviewEvidence.status as Rt2RolloutValidationStatus,
          checkedAt: latestScimPreviewEvidence.createdAt.toISOString(),
          summary: latestScimPreviewEvidence.summary as Rt2ScimSyncPreviewResult["summary"],
          candidates: latestScimPreviewEvidence.candidates as Rt2ScimSyncPreviewResult["candidates"],
          warnings: (latestScimPreviewEvidence.candidates as Rt2ScimSyncPreviewCandidate[])
            .flatMap((candidate) => candidate.warnings ?? []),
        }
      : null;
    const scimEvidenceStatus = latestScimApplyEvidence
      ? latestScimApplyEvidence.status === "applied" ? "ready" : "partial"
      : latestScimPreviewEvidence ? "partial" : "partial";
    const scimReadinessStatus: Rt2RolloutValidationStatus = latestScimApplyEvidence
      ? latestScimApplyEvidence.status === "applied" ? "pass" : "warning"
      : latestScimPreviewEvidence ? "warning" : "warning";
    const rolloutEvidence: Rt2RolloutEvidenceItem[] = [
      {
        area: "sso",
        status: ssoValidation ? toEvidenceStatus(ssoValidation.status) : "missing",
        label: "SSO connection",
        detail: activeSso.length > 0
          ? `${activeSso[0].provider} active, validation ${ssoValidation?.status ?? "missing"}`
          : "No active SSO provider saved.",
        recordIds: latestSsoEvidence ? [latestSsoEvidence.id] : activeSso.map((connection) => connection.id),
        warnings: ssoValidation?.warnings ?? [],
      },
      {
        area: "scim",
        status: scimEvidenceStatus,
        label: "SCIM sync preview",
        detail: latestScimApplyEvidence
          ? `SCIM apply evidence ${latestScimApplyEvidence.status}; preview ${latestScimApplyEvidence.previewEvidenceId ?? "unknown"}.`
          : latestScimPreviewEvidence
            ? "SCIM preview evidence exists; apply is still required before rollout readiness is ready."
            : "SCIM preview endpoint is available; run preview with source users/groups before rollout apply.",
        recordIds: [latestScimApplyEvidence?.id, latestScimPreviewEvidence?.id].filter((id): id is string => Boolean(id)),
        warnings: latestScimApplyEvidence
          ? (latestScimApplyEvidence.failureReasons as Rt2EnterpriseConnectorFailureReason[]).map((reason) => reason.message)
          : latestScimPreviewEvidence ? ["Preview-only SCIM evidence is partial until applied."] : emptyScimPreview.warnings,
      },
      {
        area: "template",
        status: templates.length > 0 ? "ready" : "missing",
        label: "Company template",
        detail: templates.length > 0
          ? `${templates[0].name} v${templates[0].version} ready for preview/apply.`
          : "No company template has been saved.",
        recordIds: templates.map((template) => template.id),
        warnings: [],
      },
      {
        area: "binding",
        status: activeBindings.length > 0
          ? activeBindings.some((binding) => binding.securityConfig.requireAuth)
            ? "ready"
            : "partial"
          : "missing",
        label: "Binding mode",
        detail: activeBindings.length > 0
          ? `${activeBindings[0].mode} on ${activeBindings[0].networkConfig.bindHost}:${activeBindings[0].networkConfig.port}`
          : "No active access binding mode saved.",
        recordIds: activeBindings.map((binding) => binding.id),
        warnings: activeBindings.some((binding) => !binding.securityConfig.requireAuth)
          ? ["At least one active binding mode does not require authenticated access."]
          : [],
      },
      {
        area: "policy",
        status: policy?.isActive
          ? policy.complianceConfig.auditLogging && policy.complianceConfig.retentionDays > 0
            ? "ready"
            : "partial"
          : "missing",
        label: "Policy default",
        detail: policy
          ? `${policy.policyType} / ${policy.isolationLevel} / ${policy.complianceConfig.dataResidency} / ${policy.complianceConfig.retentionDays} days`
          : "No active tenant policy saved.",
        recordIds: policy ? [policy.id] : [],
        warnings: policy && !policy.complianceConfig.auditLogging
          ? ["Audit logging is disabled for the current policy."]
          : [],
      },
    ];
    const readyCount = rolloutEvidence.filter((item) => item.status === "ready").length;
    const partialCount = rolloutEvidence.filter((item) => item.status === "partial").length;
    const missingCount = rolloutEvidence.filter((item) => item.status === "missing").length;

    const bindingChecks: Rt2RolloutValidationCheck[] = activeBindings.length > 0
      ? [
          {
            key: "binding-auth",
            label: "Authenticated access",
            status: activeBindings.some((binding) => binding.securityConfig.requireAuth) ? "pass" : "fail",
            detail: activeBindings.some((binding) => binding.securityConfig.requireAuth)
              ? "At least one active binding requires authentication."
              : "No active binding requires authentication.",
          },
        ]
      : [
          {
            key: "binding-active",
            label: "Active binding",
            status: "fail",
            detail: "No active access binding mode saved.",
          },
        ];
    const policyChecks: Rt2RolloutValidationCheck[] = policy
      ? [
          {
            key: "policy-audit",
            label: "Audit logging",
            status: policy.complianceConfig.auditLogging ? "pass" : "fail",
            detail: policy.complianceConfig.auditLogging
              ? "Audit logging is enabled."
              : "Audit logging is disabled.",
          },
          {
            key: "policy-retention",
            label: "Retention",
            status: policy.complianceConfig.retentionDays > 0 ? "pass" : "fail",
            detail: `${policy.complianceConfig.retentionDays} retention day(s) configured.`,
          },
        ]
      : [
          {
            key: "policy-active",
            label: "Active policy",
            status: "fail",
            detail: "No active tenant policy saved.",
          },
        ];
    const readinessItems: Rt2RolloutReadinessItem[] = [
      {
        area: "sso",
        label: "SSO provider metadata",
        status: ssoValidation?.status ?? "fail",
        detail: ssoValidation ? `${ssoValidation.provider} checked at ${ssoValidation.checkedAt}` : "No active SSO provider to validate.",
        checks: ssoValidation?.checks ?? [],
        warnings: ssoValidation?.warnings ?? ["No active SSO provider to validate."],
      },
      {
        area: "scim",
        label: "SCIM sync preview",
        status: scimReadinessStatus,
        detail: latestScimApplyEvidence
          ? `Latest SCIM apply status: ${latestScimApplyEvidence.status}.`
          : latestScimPreviewEvidence
            ? "Latest SCIM evidence is preview-only and must be applied."
            : "Run SCIM preview with source payload before applying rollout.",
        checks: [
          {
            key: "scim-preview",
            label: latestScimApplyEvidence ? "Apply evidence" : "Preview route",
            status: scimReadinessStatus,
            detail: latestScimApplyEvidence
              ? `Apply evidence ${latestScimApplyEvidence.id} is stored for this company.`
              : latestScimPreviewEvidence
                ? `Preview evidence ${latestScimPreviewEvidence.id} is stored for this company.`
                : "Preview route is available; no persisted preview has been applied in this overview.",
          },
        ],
        warnings: latestScimApplyEvidence
          ? (latestScimApplyEvidence.failureReasons as Rt2EnterpriseConnectorFailureReason[]).map((reason) => reason.message)
          : latestScimPreviewEvidence ? ["SCIM preview is read-only and must be reviewed before apply."] : ["SCIM preview is read-only and must be reviewed before apply."],
      },
      {
        area: "binding",
        label: "Binding mode",
        status: worstStatus(bindingChecks),
        detail: activeBindings[0]
          ? `${activeBindings[0].mode} on ${activeBindings[0].networkConfig.bindHost}:${activeBindings[0].networkConfig.port}`
          : "No active binding mode saved.",
        checks: bindingChecks,
        warnings: bindingChecks.filter((check) => check.status !== "pass").map((check) => check.detail),
      },
      {
        area: "policy",
        label: "Policy default",
        status: worstStatus(policyChecks),
        detail: policy
          ? `${policy.policyType} / ${policy.isolationLevel} / ${policy.complianceConfig.dataResidency}`
          : "No active tenant policy saved.",
        checks: policyChecks,
        warnings: policyChecks.filter((check) => check.status !== "pass").map((check) => check.detail),
      },
    ];
    const readinessStatus = worstStatus(readinessItems.map((item) => ({
      key: item.area,
      label: item.label,
      status: item.status,
      detail: item.detail,
    })));

    return {
      companyId,
      ssoConnections: connections.map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        isActive: connection.isActive,
        autoProvision: connection.autoProvision,
        defaultRole: connection.defaultRole,
        syncStatus: connection.syncStatus,
        issuerUrl: connection.issuerUrl,
        metadataUrl: connection.metadataUrl,
      })),
      templates: templates.map((template) => ({
        id: template.id,
        name: template.name,
        category: template.category,
        version: template.version,
        isPublic: template.isPublic,
        usageCount: template.usageCount,
      })),
      tenantPolicy: policy
        ? {
            id: policy.id,
            policyType: policy.policyType,
            isolationLevel: policy.isolationLevel,
            isActive: policy.isActive,
            auditLogging: policy.complianceConfig.auditLogging,
            dataResidency: policy.complianceConfig.dataResidency,
            retentionDays: policy.complianceConfig.retentionDays,
          }
        : null,
      bindingModes: bindings.map((binding) => ({
        id: binding.id,
        mode: binding.mode,
        environment: binding.environment,
        isActive: binding.isActive,
        requireAuth: binding.securityConfig.requireAuth,
        bindHost: binding.networkConfig.bindHost,
        port: binding.networkConfig.port,
        allowedHosts: binding.networkConfig.allowedHosts,
        corsOrigins: binding.networkConfig.corsOrigins,
      })),
      evidence: {
        overallStatus: missingCount === 0 && partialCount === 0 ? "ready" : readyCount > 0 ? "partial" : "missing",
        readyCount,
        partialCount,
        missingCount,
        items: rolloutEvidence,
      },
      ssoValidation,
      scimPreview,
      readiness: {
        overallStatus: readinessStatus,
        items: readinessItems,
      },
      auditLog: await getRolloutAuditLog(companyId),
      recommendedDefaults: {
        ssoProvider: "microsoft",
        bindingMode: "authenticated",
        policyDefault: "operator_safe",
        templateCategory: "enterprise",
      },
    };
  }

  async function saveRolloutSettings(
    companyId: string,
    input: Rt2EnterpriseRolloutSettingsInput,
  ): Promise<Rt2EnterpriseRolloutSettingsResult> {
    const changed: Rt2EnterpriseRolloutSettingsResult["changed"] = [];

    if (input.sso) {
      const existing = (await getSsoConnections(companyId)).find(
        (connection) => connection.provider === input.sso?.provider,
      );
      const values = {
        issuerUrl: input.sso.issuerUrl ?? undefined,
        metadataUrl: input.sso.metadataUrl ?? undefined,
        certificate: input.sso.certificate ?? undefined,
        providerConfig: input.sso.callbackUrl ? { callbackUrl: input.sso.callbackUrl } : undefined,
        autoProvision: input.sso.autoProvision,
        defaultRole: input.sso.defaultRole ?? undefined,
        isActive: true,
      };
      if (existing) {
        await updateSsoConnection(companyId, existing.id, values);
      } else {
        await createSsoConnection(companyId, input.sso.provider, {
          issuerUrl: input.sso.issuerUrl ?? undefined,
          metadataUrl: input.sso.metadataUrl ?? undefined,
          autoProvision: input.sso.autoProvision,
          defaultRole: input.sso.defaultRole ?? undefined,
        });
      }
      changed.push("sso");
    }

    if (input.binding) {
      const existing = (await getBindingModes(companyId)).find(
        (binding) => binding.mode === input.binding?.mode,
      );
      const networkConfig = {
        allowedHosts: input.binding.allowedHosts ?? [],
        bindHost: input.binding.bindHost,
        port: input.binding.port,
        corsOrigins: input.binding.corsOrigins ?? [],
      };
      const securityConfig = {
        requireAuth: input.binding.requireAuth,
        sessionExpiryHours: 24,
        maxSessionAge: 7,
        allowAnonymousRead: false,
      };
      if (existing) {
        await updateBindingMode(companyId, existing.id, {
          networkConfig,
          securityConfig,
          isActive: true,
        });
      } else {
        await createBindingMode(companyId, input.binding.mode, networkConfig, {
          securityConfig,
          environment: input.binding.environment,
        });
      }
      changed.push("binding");
    }

    if (input.policy) {
      const defaults = tenantDefaults(input.policy.policyDefault);
      const existing = await getTenantPolicy(companyId);
      const complianceConfig = {
        ...defaults.complianceConfig,
        dataResidency: input.policy.dataResidency?.trim() || defaults.complianceConfig.dataResidency,
        retentionDays: input.policy.retentionDays ?? defaults.complianceConfig.retentionDays,
        auditLogging: input.policy.auditLogging,
      };
      if (existing) {
        await updateTenantPolicy(companyId, existing.id, {
          isolationLevel: defaults.isolationLevel,
          dataIsolation: defaults.dataIsolation,
          resourceSharing: defaults.resourceSharing,
          complianceConfig,
          isActive: true,
        });
      } else {
        await createTenantPolicy(companyId, input.policy.policyDefault, {
          isolationLevel: defaults.isolationLevel,
          dataIsolation: defaults.dataIsolation,
          resourceSharing: defaults.resourceSharing,
          complianceConfig,
        });
      }
      changed.push("policy");
    }

    if (input.template?.name.trim()) {
      await createCompanyTemplate(
        input.template.name.trim(),
        input.template.category.trim() || "enterprise",
        {
          departments: [
            { name: "경영", roles: ["admin", "manager"], headRole: "manager" },
            { name: "운영", roles: ["operator", "member"], headRole: "operator" },
          ],
          workflows: [
            {
              name: "일일보고 검토",
              steps: ["one-liner capture", "daily report", "manager review"],
              approvals: ["quality", "policy"],
            },
          ],
          skills: ["rt2.one-liner", "rt2.daily-report", "rt2.jarvis-review"],
          budgetPolicy: {
            monthlyBudgetCents: 500000,
            alertsAtPercent: [80, 95],
          },
          governance: {
            requireApprovalForHires: true,
            requireApprovalForBudget: true,
            maxAgentBudgetCents: 100000,
          },
          agentConfigs: [
            {
              role: "Jarvis 운영 지원",
              adapterType: "process",
              capabilities: ["daily-summary", "quality-review"],
              monthlyBudgetCents: 100000,
            },
          ],
        },
        {
          description: input.template.description ?? "RT2 rollout starter template",
          isPublic: input.template.isPublic ?? false,
          authorCompanyId: companyId,
        },
      );
      changed.push("template");
    }

    return {
      overview: await getRolloutOverview(companyId),
      changed,
    };
  }

  return {
    // SSO
    createSsoConnection,
    getSsoConnections,
    updateSsoConnection,
    // Templates
    createCompanyTemplate,
    getPublicTemplates,
    getTemplatesByAuthor,
    incrementTemplateUsage,
    // Tenant Policies
    createTenantPolicy,
    getTenantPolicy,
    updateTenantPolicy,
    // Binding Modes
    createBindingMode,
    getBindingModes,
    updateBindingMode,
    getRolloutOverview,
    saveRolloutSettings,
    validateSsoProviderMetadata,
    validateSsoHandshake,
    previewScimSync,
    createScimPreview,
    applyScimPreview,
    getRolloutAuditLog,
  };
}
