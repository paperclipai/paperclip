import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Rt2RolloutBindingMode,
  Rt2RolloutPolicyDefault,
  Rt2RolloutSsoValidationResult,
  Rt2RolloutSsoProvider,
  Rt2RolloutValidationStatus,
  Rt2ScimApplyResult,
  Rt2ScimSyncPreviewResult,
  Rt2TemplatePlanItem,
} from "@paperclipai/shared";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Cloud,
  Database,
  GitCompareArrows,
  KeyRound,
  PackageCheck,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../../components/EmptyState";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { useToastActions } from "../../context/ToastContext";
import { rt2EnterpriseApi } from "../../api/rt2-enterprise";
import { queryKeys } from "../../lib/queryKeys";

const FIELD_CLASS = "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none";

const ACTION_STYLES: Record<Rt2TemplatePlanItem["action"], string> = {
  create: "border-emerald-500/30 text-emerald-600",
  skip: "border-border text-muted-foreground",
  error: "border-destructive/40 text-destructive",
};

const VALIDATION_STYLES: Record<Rt2RolloutValidationStatus, string> = {
  pass: "border-emerald-500/30 text-emerald-600",
  warning: "border-amber-500/30 text-amber-600",
  fail: "border-destructive/40 text-destructive",
};

function parseList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function ActionBadge({ action }: { action: Rt2TemplatePlanItem["action"] }) {
  return (
    <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${ACTION_STYLES[action]}`}>
      {action}
    </span>
  );
}

export function EnterpriseRolloutPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const [ssoProvider, setSsoProvider] = useState<Rt2RolloutSsoProvider>("microsoft");
  const [issuerUrl, setIssuerUrl] = useState("");
  const [metadataUrl, setMetadataUrl] = useState("");
  const [certificate, setCertificate] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("https://rt2.internal/auth/callback");
  const [autoProvision, setAutoProvision] = useState(true);
  const [defaultRole, setDefaultRole] = useState("member");

  const [bindingMode, setBindingMode] = useState<Rt2RolloutBindingMode>("authenticated");
  const [environment, setEnvironment] = useState("production");
  const [bindHost, setBindHost] = useState("0.0.0.0");
  const [port, setPort] = useState(3100);
  const [requireAuth, setRequireAuth] = useState(true);
  const [allowedHosts, setAllowedHosts] = useState("localhost,127.0.0.1");
  const [corsOrigins, setCorsOrigins] = useState("");

  const [policyDefault, setPolicyDefault] = useState<Rt2RolloutPolicyDefault>("operator_safe");
  const [dataResidency, setDataResidency] = useState("kr");
  const [retentionDays, setRetentionDays] = useState(730);
  const [auditLogging, setAuditLogging] = useState(true);

  const [templateName, setTemplateName] = useState("iSens RT2 운영 템플릿");
  const [templateCategory, setTemplateCategory] = useState("enterprise");
  const [templateDescription, setTemplateDescription] = useState("일일보고, 품질검토, Jarvis 운영을 시작하기 위한 회사 템플릿");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [ssoValidation, setSsoValidation] = useState<Rt2RolloutSsoValidationResult | null>(null);
  const [scimPreview, setScimPreview] = useState<Rt2ScimSyncPreviewResult | null>(null);
  const [selectedScimCandidateIds, setSelectedScimCandidateIds] = useState<string[]>([]);
  const [acknowledgeDeactivations, setAcknowledgeDeactivations] = useState(false);
  const [scimApplyResult, setScimApplyResult] = useState<Rt2ScimApplyResult | null>(null);
  const [scimUsersJson, setScimUsersJson] = useState(`[
  { "externalId": "u-001", "email": "ops@isens.local", "displayName": "운영 담당자", "role": "operator", "active": true },
  { "externalId": "u-002", "email": "former@isens.local", "displayName": "퇴사 예정자", "role": "member", "active": false }
]`);
  const [scimGroupsJson, setScimGroupsJson] = useState(`[
  { "externalId": "g-ops", "displayName": "운영팀", "memberExternalIds": ["u-001"] }
]`);

  useEffect(() => {
    setBreadcrumbs([{ label: "기업 연동" }]);
  }, [setBreadcrumbs]);

  const rolloutQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.rt2Enterprise.rollout(selectedCompanyId) : ["rt2-enterprise", "none"],
    queryFn: () => rt2EnterpriseApi.getRollout(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setSsoValidation(rolloutQuery.data?.ssoValidation ?? null);
    setScimPreview(rolloutQuery.data?.scimPreview ?? null);
  }, [rolloutQuery.data?.ssoValidation, rolloutQuery.data?.scimPreview]);

  useEffect(() => {
    if (!scimPreview) {
      setSelectedScimCandidateIds([]);
      return;
    }
    setSelectedScimCandidateIds(
      scimPreview.candidates
        .filter((candidate) => candidate.action !== "deactivate")
        .map(scimCandidateId),
    );
    setAcknowledgeDeactivations(false);
  }, [scimPreview]);

  useEffect(() => {
    const defaults = rolloutQuery.data?.recommendedDefaults;
    if (!defaults) return;
    setSsoProvider(defaults.ssoProvider);
    setBindingMode(defaults.bindingMode);
    setPolicyDefault(defaults.policyDefault);
    setTemplateCategory(defaults.templateCategory);
  }, [rolloutQuery.data?.recommendedDefaults]);

  useEffect(() => {
    const currentSso = rolloutQuery.data?.ssoConnections.find((connection) => connection.isActive);
    if (!currentSso) return;
    setSsoProvider(currentSso.provider as Rt2RolloutSsoProvider);
    setIssuerUrl(currentSso.issuerUrl ?? "");
    setMetadataUrl(currentSso.metadataUrl ?? "");
    setAutoProvision(currentSso.autoProvision);
    setDefaultRole(currentSso.defaultRole ?? "member");
  }, [rolloutQuery.data?.ssoConnections]);

  useEffect(() => {
    const currentBinding = rolloutQuery.data?.bindingModes.find((binding) => binding.isActive);
    if (!currentBinding) return;
    setBindingMode(currentBinding.mode as Rt2RolloutBindingMode);
    setEnvironment(currentBinding.environment);
    setBindHost(currentBinding.bindHost);
    setPort(currentBinding.port);
    setRequireAuth(currentBinding.requireAuth);
    setAllowedHosts(currentBinding.allowedHosts.join(","));
    setCorsOrigins(currentBinding.corsOrigins.join(","));
  }, [rolloutQuery.data?.bindingModes]);

  useEffect(() => {
    const currentPolicy = rolloutQuery.data?.tenantPolicy;
    if (!currentPolicy) return;
    setPolicyDefault(currentPolicy.policyType as Rt2RolloutPolicyDefault);
    setDataResidency(currentPolicy.dataResidency);
    setRetentionDays(currentPolicy.retentionDays);
    setAuditLogging(currentPolicy.auditLogging);
  }, [rolloutQuery.data?.tenantPolicy]);

  const latestTemplateId = rolloutQuery.data?.templates[0]?.id ?? "";
  useEffect(() => {
    if (!selectedTemplateId && latestTemplateId) {
      setSelectedTemplateId(latestTemplateId);
    }
  }, [latestTemplateId, selectedTemplateId]);

  const previewQuery = useQuery({
    queryKey: selectedCompanyId && selectedTemplateId
      ? queryKeys.rt2Enterprise.templatePreview(selectedCompanyId, selectedTemplateId)
      : ["rt2-enterprise", "template-preview", "none"],
    queryFn: () => rt2EnterpriseApi.previewTemplate(selectedCompanyId!, selectedTemplateId),
    enabled: !!selectedCompanyId && !!selectedTemplateId,
  });

  const saveMutation = useMutation({
    mutationFn: () => rt2EnterpriseApi.saveRollout(selectedCompanyId!, {
      sso: {
        provider: ssoProvider,
        issuerUrl: issuerUrl.trim() || null,
        metadataUrl: metadataUrl.trim() || null,
        certificate: certificate.trim() || null,
        callbackUrl: callbackUrl.trim() || null,
        autoProvision,
        defaultRole: defaultRole.trim() || null,
      },
      binding: {
        mode: bindingMode,
        environment,
        bindHost,
        port,
        requireAuth,
        allowedHosts: parseList(allowedHosts),
        corsOrigins: parseList(corsOrigins),
      },
      policy: {
        policyDefault,
        dataResidency,
        retentionDays,
        auditLogging,
      },
      template: templateName.trim()
        ? {
            name: templateName,
            category: templateCategory,
            description: templateDescription,
            isPublic: false,
          }
        : undefined,
    }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.rt2Enterprise.rollout(selectedCompanyId!) });
      setSelectedTemplateId(result.overview.templates[0]?.id ?? "");
      pushToast({
        tone: "success",
        title: "기업 연동 설정 저장",
        body: `${result.changed.length}개 설정 영역을 업데이트했습니다.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "기업 연동 설정 저장 실패",
        body: error instanceof Error ? error.message : "기업 연동 설정을 저장하지 못했습니다.",
      });
    },
  });

  const ssoValidationMutation = useMutation({
    mutationFn: () => rt2EnterpriseApi.validateSso(selectedCompanyId!, {
      provider: ssoProvider,
      issuerUrl: issuerUrl.trim() || null,
      metadataUrl: metadataUrl.trim() || null,
      certificate: certificate.trim() || null,
      callbackUrl: callbackUrl.trim() || null,
    }),
    onSuccess: async (result) => {
      setSsoValidation(result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.rt2Enterprise.rollout(selectedCompanyId!) });
      pushToast({ tone: result.status === "fail" ? "error" : "success", title: `SSO validation ${result.status}` });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "SSO validation failed",
        body: error instanceof Error ? error.message : "Failed to validate SSO metadata.",
      });
    },
  });

  const scimPreviewMutation = useMutation({
    mutationFn: () => rt2EnterpriseApi.previewScim(selectedCompanyId!, {
      users: JSON.parse(scimUsersJson),
      groups: JSON.parse(scimGroupsJson),
    }),
    onSuccess: async (result) => {
      setScimPreview(result);
      setScimApplyResult(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.rt2Enterprise.rollout(selectedCompanyId!) });
      pushToast({ tone: result.status === "fail" ? "error" : "success", title: `SCIM preview ${result.status}` });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "SCIM preview failed",
        body: error instanceof Error ? error.message : "Check the source JSON payload.",
      });
    },
  });

  const scimApplyMutation = useMutation({
    mutationFn: () => rt2EnterpriseApi.applyScim(selectedCompanyId!, {
      previewId: scimPreview?.previewId ?? "",
      previewFingerprint: scimPreview?.previewFingerprint ?? "",
      selectedCandidateIds: selectedScimCandidateIds,
      acknowledgeDeactivations,
    }),
    onSuccess: async (result) => {
      setScimApplyResult(result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.rt2Enterprise.rollout(selectedCompanyId!) });
      pushToast({ tone: result.status === "failed" ? "error" : "success", title: `SCIM apply ${result.status}` });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "SCIM apply failed",
        body: error instanceof Error ? error.message : "SCIM apply failed.",
      });
    },
  });

  const applyMutation = useMutation({
    mutationFn: () => rt2EnterpriseApi.applyTemplate(selectedCompanyId!, selectedTemplateId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.rt2Enterprise.rollout(selectedCompanyId!) });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.rt2Enterprise.templatePreview(selectedCompanyId!, selectedTemplateId),
      });
      pushToast({ tone: "success", title: "Template applied" });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Template apply failed",
        body: error instanceof Error ? error.message : "Template apply failed.",
      });
    },
  });

  const templateOptions = rolloutQuery.data?.templates ?? [];
  const readiness = useMemo(() => ({
    sso: rolloutQuery.data?.ssoConnections.some((connection) => connection.isActive) ?? false,
    binding: rolloutQuery.data?.bindingModes.some((binding) => binding.isActive) ?? false,
    policy: !!rolloutQuery.data?.tenantPolicy?.isActive,
    template: templateOptions.length > 0,
  }), [rolloutQuery.data, templateOptions.length]);

  const selectedScimCandidates = useMemo(() => {
    if (!scimPreview) return [];
    const selected = new Set(selectedScimCandidateIds);
    return scimPreview.candidates.filter((candidate) => selected.has(scimCandidateId(candidate)));
  }, [scimPreview, selectedScimCandidateIds]);
  const selectedDeactivateCount = selectedScimCandidates.filter((candidate) => candidate.action === "deactivate").length;
  const canApplyScim = !!scimPreview?.previewId
    && !!scimPreview.previewFingerprint
    && selectedScimCandidateIds.length > 0
    && (selectedDeactivateCount === 0 || acknowledgeDeactivations)
    && !scimApplyMutation.isPending;

  function toggleScimCandidate(candidateId: string, checked: boolean) {
    setSelectedScimCandidateIds((current) => {
      if (checked) return current.includes(candidateId) ? current : [...current, candidateId];
      return current.filter((id) => id !== candidateId);
    });
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Building2} message="기업 연동을 설정할 회사를 먼저 선택하세요." />;
  }

  if (rolloutQuery.isLoading) {
    return <div className="py-10 text-sm text-muted-foreground">기업 연동 설정을 불러오는 중...</div>;
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-card px-6 py-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
              <Building2 className="h-4 w-4" />
              RealTycoon2 Enterprise
            </div>
            <h1 className="text-2xl font-semibold">사내 운영 시작 설정</h1>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              SSO, 회사 템플릿, 접근 모드, 정책 기본값을 RealTycoon2 용어로 묶어 관리합니다.
              외부 연동 엔진은 내부에 숨기고 운영자 화면에서는 RealTycoon2 기준으로 표시합니다.
            </p>
          </div>
          <div className="grid min-w-[18rem] grid-cols-2 gap-2 text-sm">
            {[
              ["SSO", readiness.sso],
              ["Access", readiness.binding],
              ["Policy", readiness.policy],
              ["Template", readiness.template],
            ].map(([label, ready]) => (
              <div key={String(label)} className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                {ready ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-border bg-card px-5 py-4">
          <div className="mb-4 flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">SSO와 사용자 매핑</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              Provider
              <select className={FIELD_CLASS} value={ssoProvider} onChange={(event) => setSsoProvider(event.target.value as Rt2RolloutSsoProvider)}>
                <option value="microsoft">Microsoft</option>
                <option value="google">Google</option>
                <option value="okta">Okta</option>
                <option value="custom">Custom OIDC/SAML</option>
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Default role
              <input className={FIELD_CLASS} value={defaultRole} onChange={(event) => setDefaultRole(event.target.value)} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Issuer URL
              <input className={FIELD_CLASS} value={issuerUrl} onChange={(event) => setIssuerUrl(event.target.value)} placeholder="https://login.example.com" />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Metadata URL
              <input className={FIELD_CLASS} value={metadataUrl} onChange={(event) => setMetadataUrl(event.target.value)} placeholder="https://.../.well-known/openid-configuration" />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Callback URL
              <input className={FIELD_CLASS} value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="https://rt2.internal/auth/callback" />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground md:col-span-2">
              Certificate PEM
              <textarea className={`${FIELD_CLASS} min-h-24 font-mono text-xs`} value={certificate} onChange={(event) => setCertificate(event.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={autoProvision} onChange={(event) => setAutoProvision(event.target.checked)} />
              Auto-provision invited employees
            </label>
            <div className="flex items-center gap-2 md:col-span-2">
              <Button size="sm" variant="outline" onClick={() => ssoValidationMutation.mutate()} disabled={ssoValidationMutation.isPending}>
                {ssoValidationMutation.isPending ? "검증 중..." : "SSO metadata 검증"}
              </Button>
              {ssoValidation ? <ValidationStatus status={ssoValidation.status} /> : null}
            </div>
          </div>
          {ssoValidation ? (
            <div className="mt-4 space-y-2">
              <div className="grid gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground md:grid-cols-3">
                <div>evidence: {ssoValidation.evidenceId ?? "not recorded"}</div>
                <div>checked: {new Date(ssoValidation.checkedAt).toLocaleString()}</div>
                <div>cert: {ssoValidation.certificateExpiresAt ? new Date(ssoValidation.certificateExpiresAt).toLocaleDateString() : "not provided"}</div>
              </div>
              {ssoValidation.checks.map((check) => (
                <ValidationRow key={check.key} label={check.label} status={check.status} detail={check.detail} />
              ))}
              {(ssoValidation.callbackStateChecks ?? []).map((check) => (
                <ValidationRow key={`callback-${check.key}`} label={check.label} status={check.status} detail={check.detail} />
              ))}
              {(ssoValidation.failureReasons ?? []).map((failure) => (
                <p key={`${failure.code}-${failure.field ?? "global"}`} className="rounded-md border border-destructive/30 bg-background px-3 py-2 text-xs text-destructive">
                  {failure.code}: {failure.message}
                </p>
              ))}
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-border bg-card px-5 py-4">
          <div className="mb-4 flex items-center gap-2">
            <Cloud className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">접근 모드와 바인딩</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              Access mode
              <select className={FIELD_CLASS} value={bindingMode} onChange={(event) => setBindingMode(event.target.value as Rt2RolloutBindingMode)}>
                <option value="local_trusted">Local trusted</option>
                <option value="authenticated">Authenticated</option>
                <option value="lan">LAN</option>
                <option value="tailnet">Tailnet</option>
                <option value="cloud">Cloud</option>
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Environment
              <select className={FIELD_CLASS} value={environment} onChange={(event) => setEnvironment(event.target.value)}>
                <option value="production">Production</option>
                <option value="staging">Staging</option>
                <option value="development">Development</option>
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Bind host
              <input className={FIELD_CLASS} value={bindHost} onChange={(event) => setBindHost(event.target.value)} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Port
              <input className={FIELD_CLASS} type="number" value={port} onChange={(event) => setPort(Number(event.target.value) || 3100)} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground md:col-span-2">
              Allowed hosts
              <input className={FIELD_CLASS} value={allowedHosts} onChange={(event) => setAllowedHosts(event.target.value)} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground md:col-span-2">
              CORS origins
              <input className={FIELD_CLASS} value={corsOrigins} onChange={(event) => setCorsOrigins(event.target.value)} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={requireAuth} onChange={(event) => setRequireAuth(event.target.checked)} />
              Require authenticated access
            </label>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-border bg-card px-5 py-4">
          <div className="mb-4 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">정책 기본값</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              Policy preset
              <select className={FIELD_CLASS} value={policyDefault} onChange={(event) => setPolicyDefault(event.target.value as Rt2RolloutPolicyDefault)}>
                <option value="operator_safe">Operator safe</option>
                <option value="strict_enterprise">Strict enterprise</option>
                <option value="pilot_friendly">Pilot friendly</option>
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Data residency
              <input className={FIELD_CLASS} value={dataResidency} onChange={(event) => setDataResidency(event.target.value)} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Retention days
              <input className={FIELD_CLASS} type="number" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value) || 365)} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={auditLogging} onChange={(event) => setAuditLogging(event.target.checked)} />
              Audit logging
            </label>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card px-5 py-4">
          <div className="mb-4 flex items-center gap-2">
            <PackageCheck className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">회사 템플릿</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              Template name
              <input className={FIELD_CLASS} value={templateName} onChange={(event) => setTemplateName(event.target.value)} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Category
              <input className={FIELD_CLASS} value={templateCategory} onChange={(event) => setTemplateCategory(event.target.value)} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground md:col-span-2">
              Description
              <input className={FIELD_CLASS} value={templateDescription} onChange={(event) => setTemplateDescription(event.target.value)} />
            </label>
            <div className="md:col-span-2">
              <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving..." : "Save rollout settings"}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card px-5 py-4">
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
              <UsersRound className="h-4 w-4" />
              SCIM 동기화 미리보기
            </div>
            <h2 className="mt-2 text-sm font-semibold">사용자/그룹 동기화 검수</h2>
          </div>
          <Button size="sm" variant="outline" onClick={() => scimPreviewMutation.mutate()} disabled={scimPreviewMutation.isPending}>
            {scimPreviewMutation.isPending ? "미리보기 중..." : "SCIM 미리보기 실행"}
          </Button>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            Source users JSON
            <textarea className={`${FIELD_CLASS} min-h-40 font-mono text-xs`} value={scimUsersJson} onChange={(event) => setScimUsersJson(event.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Source groups JSON
            <textarea className={`${FIELD_CLASS} min-h-40 font-mono text-xs`} value={scimGroupsJson} onChange={(event) => setScimGroupsJson(event.target.value)} />
          </label>
        </div>
        {scimPreview ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <ValidationStatus status={scimPreview.status} />
              <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">preview {scimPreview.previewId ?? "not recorded"}</span>
              <span className="max-w-full truncate rounded-md border border-border px-2 py-1 text-muted-foreground">fingerprint {scimPreview.previewFingerprint ?? "missing"}</span>
              <span className="rounded-md border border-emerald-500/30 px-2 py-1 text-emerald-600">Create {scimPreview.summary.create}</span>
              <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">Update {scimPreview.summary.update}</span>
              <span className="rounded-md border border-amber-500/30 px-2 py-1 text-amber-600">Deactivate {scimPreview.summary.deactivate}</span>
            </div>
            <div className="overflow-hidden rounded-md border border-border">
              {scimPreview.candidates.map((candidate) => (
                <div
                  key={scimCandidateId(candidate)}
                  className={`grid gap-2 border-b border-border px-4 py-3 text-sm last:border-b-0 md:grid-cols-[2rem_7rem_8rem_minmax(0,1fr)] ${candidate.action === "deactivate" ? "bg-amber-500/5" : ""}`}
                >
                  <input
                    aria-label={`select ${candidate.label}`}
                    type="checkbox"
                    checked={selectedScimCandidateIds.includes(scimCandidateId(candidate))}
                    onChange={(event) => toggleScimCandidate(scimCandidateId(candidate), event.target.checked)}
                  />
                  <div className="text-xs font-medium uppercase text-muted-foreground">{candidate.kind}</div>
                  <span className={`w-fit rounded-md border px-2 py-0.5 text-xs ${candidate.action === "deactivate" ? "border-amber-500/30 text-amber-600" : "border-border"}`}>
                    {candidate.action}
                  </span>
                  <div>
                    <div className="font-medium">{candidate.label}</div>
                    <div className="mt-1 text-xs text-muted-foreground">id: {scimCandidateId(candidate)}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{candidate.reason}</p>
                    {candidate.warnings.map((warning) => (
                      <p key={warning} className="mt-1 text-xs text-amber-600">{warning}</p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-3 rounded-md border border-border bg-background px-3 py-3 text-sm md:flex-row md:items-center md:justify-between">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">Selected {selectedScimCandidateIds.length}</span>
                <span className="rounded-md border border-amber-500/30 px-2 py-1 text-amber-600">Selected deactivate {selectedDeactivateCount}</span>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={acknowledgeDeactivations}
                  disabled={selectedDeactivateCount === 0}
                  onChange={(event) => setAcknowledgeDeactivations(event.target.checked)}
                />
                Deactivate 후보 적용 승인
              </label>
              <Button size="sm" disabled={!canApplyScim} onClick={() => scimApplyMutation.mutate()}>
                {scimApplyMutation.isPending ? "적용 중..." : "선택 SCIM 적용"}
              </Button>
            </div>
            {scimApplyResult ? <ScimApplyEvidence result={scimApplyResult} /> : null}
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-border bg-card px-5 py-4">
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
              <Database className="h-4 w-4" />
              연동 검수 근거
            </div>
            <h2 className="mt-2 text-sm font-semibold">운영 검수 상태</h2>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <EvidenceStatus status={rolloutQuery.data?.evidence.overallStatus ?? "missing"} />
            <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">
              Ready {rolloutQuery.data?.evidence.readyCount ?? 0}
            </span>
            <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">
              Partial {rolloutQuery.data?.evidence.partialCount ?? 0}
            </span>
            <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">
              Missing {rolloutQuery.data?.evidence.missingCount ?? 0}
            </span>
          </div>
        </div>
        <div className="grid gap-3 xl:grid-cols-4">
          {(rolloutQuery.data?.evidence.items ?? []).map((item) => (
            <div key={item.area} className="rounded-md border border-border bg-background px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium uppercase text-muted-foreground">{item.area}</div>
                <EvidenceStatus status={item.status} compact />
              </div>
              <div className="mt-2 text-sm font-medium">{item.label}</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.detail}</p>
              {item.recordIds.length > 0 ? (
                <p className="mt-2 truncate text-xs text-muted-foreground">records: {item.recordIds.join(", ")}</p>
              ) : null}
              {item.warnings.map((warning) => (
                <p key={warning} className="mt-2 text-xs leading-5 text-amber-600">{warning}</p>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.6fr)]">
        <div className="rounded-lg border border-border bg-card px-5 py-4">
          <div className="mb-4 flex items-center gap-2">
            <GitCompareArrows className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">연동 준비 상태</h2>
            {rolloutQuery.data?.readiness ? <ValidationStatus status={rolloutQuery.data.readiness.overallStatus} /> : null}
          </div>
          <div className="space-y-3">
            {(rolloutQuery.data?.readiness.items ?? []).map((item) => (
              <div key={item.area} className="rounded-md border border-border bg-background px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">{item.label}</div>
                  <ValidationStatus status={item.status} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
                <div className="mt-3 space-y-2">
                  {item.checks.map((check) => (
                    <ValidationRow key={check.key} label={check.label} status={check.status} detail={check.detail} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card px-5 py-4">
          <h2 className="text-sm font-semibold">연동 감사 기록</h2>
          <div className="mt-3 space-y-3">
            {(rolloutQuery.data?.auditLog ?? []).map((entry) => (
              <div key={entry.id} className="rounded-md border border-border bg-background px-3 py-3">
                <div className="text-xs font-medium text-muted-foreground">{entry.action}</div>
                <div className="mt-1 text-sm">{entry.actorType}:{entry.actorId}</div>
                <div className="mt-1 text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</div>
                {entry.details ? <AuditDetails details={entry.details} /> : null}
              </div>
            ))}
            {(rolloutQuery.data?.auditLog.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">아직 연동 검증 감사 기록이 없습니다.</p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card px-5 py-4">
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-sm font-semibold">Template preview before apply</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              irreversible apply 전에 생성, 스킵, 오류 객체를 확인합니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select className={FIELD_CLASS} value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}>
              <option value="">Select template</option>
              {templateOptions.map((template) => (
                <option key={template.id} value={template.id}>{template.name}</option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={!selectedTemplateId || applyMutation.isPending || (previewQuery.data?.summary.error ?? 0) > 0}
              onClick={() => applyMutation.mutate()}
            >
              {applyMutation.isPending ? "Applying..." : "Apply previewed template"}
            </Button>
          </div>
        </div>

        {previewQuery.data ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-md border border-emerald-500/30 px-2 py-1 text-emerald-600">Create {previewQuery.data.summary.create}</span>
              <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">Skip {previewQuery.data.summary.skip}</span>
              <span className="rounded-md border border-destructive/40 px-2 py-1 text-destructive">Error {previewQuery.data.summary.error}</span>
            </div>
            <div className="overflow-hidden rounded-md border border-border">
              {previewQuery.data.items.map((item, index) => (
                <div key={`${item.kind}-${item.name}-${index}`} className="grid gap-2 border-b border-border px-4 py-3 text-sm last:border-b-0 md:grid-cols-[9rem_minmax(0,1fr)_7rem]">
                  <div className="text-xs font-medium uppercase text-muted-foreground">{item.kind}</div>
                  <div>
                    <div className="font-medium">{item.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{item.reason}</div>
                  </div>
                  <div className="flex md:justify-end">
                    <ActionBadge action={item.action} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState icon={PackageCheck} message="Save or select a template to preview apply objects." />
        )}
      </section>
    </div>
  );
}

function scimCandidateId(candidate: { id?: string; kind: string; action: string; externalId: string }) {
  return candidate.id ?? `${candidate.kind}:${candidate.action}:${candidate.externalId}`;
}

function ScimApplyEvidence({ result }: { result: Rt2ScimApplyResult }) {
  return (
    <div className="space-y-3 rounded-md border border-border bg-background px-3 py-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">evidence {result.evidenceId}</span>
        <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">applied {new Date(result.appliedAt).toLocaleString()}</span>
        <span className="rounded-md border border-emerald-500/30 px-2 py-1 text-emerald-600">Applied {result.summary.applied}</span>
        <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">Skipped {result.summary.skipped}</span>
        <span className="rounded-md border border-destructive/40 px-2 py-1 text-destructive">Failed {result.summary.failed}</span>
        <span className="rounded-md border border-amber-500/30 px-2 py-1 text-amber-600">Rollback {result.summary.rollbackCandidates}</span>
      </div>
      <div className="overflow-hidden rounded-md border border-border">
        {result.candidates.map((candidate) => (
          <div key={candidate.candidateId} className="grid gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0 md:grid-cols-[8rem_7rem_minmax(0,1fr)]">
            <div className="text-xs font-medium uppercase text-muted-foreground">{candidate.kind}</div>
            <span className="w-fit rounded-md border border-border px-2 py-0.5 text-xs">{candidate.status}</span>
            <div>
              <div className="font-medium">{candidate.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">{candidate.candidateId}</div>
              <p className="mt-1 text-xs text-muted-foreground">{candidate.reason}</p>
              {candidate.failureReason ? (
                <p className="mt-1 text-xs text-destructive">{candidate.failureReason.code}: {candidate.failureReason.message}</p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {result.rollbackCandidates.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-amber-500/30">
          {result.rollbackCandidates.map((candidate) => (
            <div key={candidate.candidateId} className="grid gap-2 border-b border-border px-3 py-2 text-xs last:border-b-0 md:grid-cols-[8rem_1fr]">
              <div className="font-medium text-amber-600">rollback</div>
              <div>
                <div>{candidate.candidateId}</div>
                <div className="mt-1 text-muted-foreground">{candidate.reason}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {result.failureReasons.map((failure) => (
        <p key={`${failure.code}-${failure.field ?? "global"}`} className="text-xs text-destructive">{failure.code}: {failure.message}</p>
      ))}
    </div>
  );
}

function AuditDetails({ details }: { details: Record<string, unknown> }) {
  const evidenceId = typeof details.evidenceId === "string" ? details.evidenceId : null;
  const previewId = typeof details.previewId === "string" ? details.previewId : null;
  const status = typeof details.status === "string" ? details.status : null;
  const rollbackCandidateCount = typeof details.rollbackCandidateCount === "number" ? details.rollbackCandidateCount : null;
  return (
    <div className="mt-2 flex flex-wrap gap-2 text-xs">
      {status ? <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">status {status}</span> : null}
      {evidenceId ? <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">evidence {evidenceId}</span> : null}
      {previewId ? <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">preview {previewId}</span> : null}
      {rollbackCandidateCount !== null ? (
        <span className="rounded-md border border-amber-500/30 px-2 py-1 text-amber-600">rollback {rollbackCandidateCount}</span>
      ) : null}
    </div>
  );
}

function EvidenceStatus({ status, compact = false }: { status: "ready" | "partial" | "missing"; compact?: boolean }) {
  const className =
    status === "ready"
      ? "border-emerald-500/30 text-emerald-600"
      : status === "partial"
        ? "border-amber-500/30 text-amber-600"
        : "border-border text-muted-foreground";
  return (
    <span className={`rounded-md border px-2 py-1 text-xs font-medium ${className}`}>
      {compact ? status : `Evidence ${status}`}
    </span>
  );
}

function ValidationStatus({ status }: { status: Rt2RolloutValidationStatus }) {
  return (
    <span className={`rounded-md border px-2 py-1 text-xs font-medium ${VALIDATION_STYLES[status]}`}>
      {status}
    </span>
  );
}

function ValidationRow({ label, status, detail }: { label: string; status: Rt2RolloutValidationStatus; detail: string }) {
  return (
    <div className="grid gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm md:grid-cols-[9rem_5rem_minmax(0,1fr)]">
      <div className="font-medium">{label}</div>
      <ValidationStatus status={status} />
      <div className="text-xs leading-5 text-muted-foreground">{detail}</div>
    </div>
  );
}
