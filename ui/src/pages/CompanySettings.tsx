import { ChangeEvent, Fragment, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
  ISSUE_THREAD_INTERACTION_KINDS,
  type InteractionResolverGovernance,
  type IssueThreadInteractionKind,
  type IssueThreadInteractionResolverPolicy,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Settings, Download, Upload } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import {
  Field,
  ToggleField,
} from "../components/agent-config-primitives";
import { Trans, t, useTranslation } from "@/i18n";

const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_COMPANY_ATTACHMENT_MAX_MIB = DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB;
const MAX_COMPANY_ATTACHMENT_MAX_MIB = MAX_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB;

const INTERACTION_KIND_LABELS: Record<IssueThreadInteractionKind, string> = {
  suggest_tasks: t("companySettings.kindSuggestTasks"),
  ask_user_questions: t("companySettings.kindAskUserQuestions"),
  request_confirmation: t("companySettings.kindRequestConfirmation"),
  request_checkbox_confirmation: t("companySettings.kindRequestCheckboxConfirmation"),
  request_item_verdicts: t("companySettings.kindRequestItemVerdicts"),
};

// Sentinel for "no override" — Radix Select disallows empty-string item values.
const GOVERNANCE_UNSET = "default";
type GovernanceSelectValue = typeof GOVERNANCE_UNSET | IssueThreadInteractionResolverPolicy;

const GOVERNANCE_POLICY_OPTIONS: { value: GovernanceSelectValue; label: string }[] = [
  { value: GOVERNANCE_UNSET, label: t("companySettings.policyCompanyDefault") },
  { value: "board_only", label: t("companySettings.policyBoardOnly") },
  { value: "board_or_agents", label: t("companySettings.policyBoardOrAgents") },
];

function toSelectValue(policy: IssueThreadInteractionResolverPolicy | undefined): GovernanceSelectValue {
  return policy ?? GOVERNANCE_UNSET;
}

/**
 * Apply a single (kind, field) change to a governance map immutably, pruning
 * empty entries so the persisted object stays sparse (only real overrides).
 */
function applyGovernanceChange(
  current: InteractionResolverGovernance,
  kind: IssueThreadInteractionKind,
  field: "defaultPolicy" | "cap",
  value: GovernanceSelectValue,
): InteractionResolverGovernance {
  const next: InteractionResolverGovernance = { ...current };
  const entry = { ...(next[kind] ?? {}) };
  if (value === GOVERNANCE_UNSET) {
    delete entry[field];
  } else {
    entry[field] = value;
  }
  if (entry.defaultPolicy === undefined && entry.cap === undefined) {
    delete next[kind];
  } else {
    next[kind] = entry;
  }
  return next;
}
function GovernanceSelect({
  value,
  onChange,
  disabled,
  testId,
  ariaLabel,
  mobileLabel,
}: {
  value: GovernanceSelectValue;
  onChange: (value: GovernanceSelectValue) => void;
  disabled?: boolean;
  testId?: string;
  ariaLabel: string;
  mobileLabel: string;
}) {
  return (
    <div className="min-w-0">
      {/*
       * Below `sm` the governance grid collapses to a single column (see the
       * grid classes on the panel), detaching each select from its column
       * header. Surface a mobile-only inline label so the control stays
       * self-describing for sighted users, and always carry `aria-label` for
       * screen-reader pairing. WCAG 2.1 SC 1.4.10 (Reflow) — design review R2.
       */}
      <span className="mb-1 block text-xs font-medium text-muted-foreground uppercase tracking-wide sm:hidden">
        {mobileLabel}
      </span>
      <Select value={value} onValueChange={(v) => onChange(v as GovernanceSelectValue)} disabled={disabled}>
        <SelectTrigger
          size="sm"
          aria-label={ariaLabel}
          className="w-full min-w-0 text-xs sm:w-(--sz-170px)"
          data-testid={testId}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GOVERNANCE_POLICY_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value} className="text-xs">
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId
  } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [attachmentMaxMiB, setAttachmentMaxMiB] = useState(String(DEFAULT_COMPANY_ATTACHMENT_MAX_MIB));
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);
  const [governance, setGovernance] = useState<InteractionResolverGovernance>({});

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setAttachmentMaxMiB(String(Math.round((selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES) / BYTES_PER_MIB)));
    setLogoUrl(selectedCompany.logoUrl ?? "");
    setGovernance(selectedCompany.interactionResolverGovernance ?? {});
  }, [selectedCompany]);

  const attachmentMaxBytes = Number.parseInt(attachmentMaxMiB, 10) * BYTES_PER_MIB;
  const attachmentMaxValid =
    Number.isInteger(attachmentMaxBytes)
    && attachmentMaxBytes >= BYTES_PER_MIB
    && attachmentMaxBytes <= MAX_COMPANY_ATTACHMENT_MAX_BYTES;

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? "") ||
      attachmentMaxBytes !== (selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES));

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
      attachmentMaxBytes: number;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const governanceMutation = useMutation({
    mutationFn: (next: InteractionResolverGovernance) =>
      companiesApi.update(selectedCompanyId!, { interactionResolverGovernance: next }),
    onSuccess: (company) => {
      setGovernance(company.interactionResolverGovernance ?? {});
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  function handleGovernanceChange(
    kind: IssueThreadInteractionKind,
    field: "defaultPolicy" | "cap",
    value: GovernanceSelectValue,
  ) {
    const next = applyGovernanceChange(governance, kind, field, value);
    setGovernance(next);
    governanceMutation.mutate(next);
  }

  const syncLogoState = (nextLogoUrl: string | null) => {
    setLogoUrl(nextLogoUrl ?? "");
    void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  };

  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadCompanyLogo(selectedCompanyId!, file)
        .then((asset) => companiesApi.update(selectedCompanyId!, { logoAssetId: asset.assetId })),
    onSuccess: (company) => {
      syncLogoState(company.logoUrl);
      setLogoUploadError(null);
    }
  });

  const clearLogoMutation = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { logoAssetId: null }),
    onSuccess: (company) => {
      setLogoUploadError(null);
      syncLogoState(company.logoUrl);
    }
  });

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setLogoUploadError(null);
    logoUploadMutation.mutate(file);
  }

  function handleClearLogo() {
    clearLogoMutation.mutate();
  }

  const archiveMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.archive(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("companySettings.companyFallback"), href: "/dashboard" },
      { label: t("companySettings.settingsBreadcrumb") }
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("companySettings.noCompanySelected")}
      </div>
    );
  }

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null,
      attachmentMaxBytes
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t("companySettings.title")}</h1>
      </div>

      {/* General */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.general")}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label={t("companySettings.companyNameLabel")} hint={t("companySettings.companyNameHint")}>
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field
            label={t("companySettings.descriptionLabel")}
            hint={t("companySettings.descriptionHint")}
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={description}
              placeholder={t("companySettings.descriptionPlaceholder")}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.appearance")}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <CompanyPatternIcon
                companyName={companyName || selectedCompany.name}
                logoUrl={logoUrl || null}
                brandColor={brandColor || null}
                className="rounded-(--rad-14)"
              />
            </div>
            <div className="flex-1 space-y-3">
              <Field
                label={t("companySettings.logoLabel")}
                hint={t("companySettings.logoHint")}
              >
                <div className="space-y-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    onChange={handleLogoFileChange}
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
                  />
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleClearLogo}
                        disabled={clearLogoMutation.isPending}
                      >
                        {clearLogoMutation.isPending ? t("companySettings.removingLogo") : t("companySettings.removeLogo")}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <span className="text-xs text-destructive">
                      {logoUploadError ??
                        (logoUploadMutation.error instanceof Error
                          ? logoUploadMutation.error.message
                          : t("companySettings.logoUploadFailed"))}
                    </span>
                  )}
                  {clearLogoMutation.isError && (
                    <span className="text-xs text-destructive">
                      {clearLogoMutation.error.message}
                    </span>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-muted-foreground">{t("companySettings.uploadingLogo")}</span>
                  )}
                </div>
              </Field>
              <Field
                label={t("companySettings.brandColorLabel")}
                hint={t("companySettings.brandColorHint")}
              >
                <div className="flex items-center gap-2">
                  {/* token-extraction: allowlisted — <input type="color"> value must be a real hex string, not a var() reference. */}
                  <input
                    type="color"
                    value={brandColor || "#6366f1"}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <input
                    type="text"
                    value={brandColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                        setBrandColor(v);
                      }
                    }}
                    placeholder={t("companySettings.auto")}
                    className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-muted-foreground"
                    >
                      {t("companySettings.clear")}
                    </Button>
                  )}
                </div>
              </Field>
              <Field
                label={t("companySettings.attachmentLimitLabel")}
                hint={t("companySettings.attachmentLimitHint", { max: MAX_COMPANY_ATTACHMENT_MAX_MIB })}
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={MAX_COMPANY_ATTACHMENT_MAX_MIB}
                      step={1}
                      value={attachmentMaxMiB}
                      onChange={(e) => setAttachmentMaxMiB(e.target.value)}
                      className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    />
                    <span className="text-xs text-muted-foreground">MiB</span>
                  </div>
                  {!attachmentMaxValid && (
                    <span className="text-xs text-destructive">
                      {t("companySettings.attachmentRangeError", { max: MAX_COMPANY_ATTACHMENT_MAX_MIB })}
                    </span>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </div>

      {/* Save button for General + Appearance */}
      {generalDirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveGeneral}
            disabled={generalMutation.isPending || !companyName.trim() || !attachmentMaxValid}
          >
            {generalMutation.isPending ? t("companySettings.saving") : t("companySettings.saveChanges")}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">{t("companySettings.saved")}</span>
          )}
          {generalMutation.isError && (
            <span className="text-xs text-destructive">
              {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : t("companySettings.saveFailed")}
            </span>
          )}
        </div>
      )}

      {/* Hiring */}
      <div className="space-y-4" data-testid="company-settings-team-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.hiring")}
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label={t("companySettings.requireApprovalLabel")}
            hint={t("companySettings.requireApprovalHint")}
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
            toggleTestId="company-settings-team-approval-toggle"
          />
        </div>
      </div>

      {/* Interaction governance */}
      <div className="space-y-4" data-testid="company-settings-interaction-governance-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.governanceTitle")}
        </div>
        <div className="space-y-4 rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            <Trans
              i18nKey="companySettings.governanceDescription"
              components={{
                strong: <span className="font-medium text-foreground" />,
              }}
              values={{
                defaultPolicy: t("companySettings.defaultPolicyColumn"),
                cap: t("companySettings.capColumn"),
                boardOnly: t("companySettings.policyBoardOnly"),
              }}
            />
          </p>
          {/*
           * Responsive: below `sm` the row collapses to a single column so the
           * two 170px selects never force horizontal overflow on a ~390px
           * viewport (WCAG 2.1 SC 1.4.10 Reflow — design review R2). Each kind
           * then stacks as: label → Default policy → Cap, each full-width with
           * its own inline label. At `sm`+ it restores the aligned 3-col grid.
           */}
          <div className="grid grid-cols-1 gap-y-4 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-x-4 sm:gap-y-2.5">
            <div className="hidden text-xs font-medium text-muted-foreground uppercase tracking-wide sm:block">
              {t("companySettings.kindColumn")}
            </div>
            <div className="hidden text-xs font-medium text-muted-foreground uppercase tracking-wide sm:block">
              {t("companySettings.defaultPolicyColumn")}
            </div>
            <div className="hidden text-xs font-medium text-muted-foreground uppercase tracking-wide sm:block">
              {t("companySettings.capColumn")}
            </div>
            {ISSUE_THREAD_INTERACTION_KINDS.map((kind) => {
              const entry = governance[kind] ?? {};
              const kindLabel = INTERACTION_KIND_LABELS[kind];
              return (
                <Fragment key={kind}>
                  <div className="text-sm font-medium sm:font-normal">{kindLabel}</div>
                  <GovernanceSelect
                    testId={`governance-${kind}-default`}
                    ariaLabel={t("companySettings.defaultPolicyAria", { kind: kindLabel })}
                    mobileLabel={t("companySettings.defaultPolicyColumn")}
                    value={toSelectValue(entry.defaultPolicy)}
                    disabled={governanceMutation.isPending}
                    onChange={(v) => handleGovernanceChange(kind, "defaultPolicy", v)}
                  />
                  <GovernanceSelect
                    testId={`governance-${kind}-cap`}
                    ariaLabel={t("companySettings.resolverCapAria", { kind: kindLabel })}
                    mobileLabel={t("companySettings.capColumn")}
                    value={toSelectValue(entry.cap)}
                    disabled={governanceMutation.isPending}
                    onChange={(v) => handleGovernanceChange(kind, "cap", v)}
                  />
                </Fragment>
              );
            })}
          </div>
          {governanceMutation.isError && (
            <span className="text-xs text-destructive">
              {governanceMutation.error instanceof Error
                ? governanceMutation.error.message
                : t("companySettings.governanceSaveFailed")}
            </span>
          )}
        </div>
      </div>

      {/* Import / Export */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.packagesTitle")}
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link to="/company/export">
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t("companySettings.export")}
              </Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/company/import">
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {t("companySettings.import")}
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-destructive uppercase tracking-wide">
          {t("companySettings.dangerZone")}
        </div>
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            {t("companySettings.archiveDescription")}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={
                archiveMutation.isPending ||
                selectedCompany.status === "archived"
              }
              onClick={() => {
                if (!selectedCompanyId) return;
                const confirmed = window.confirm(
                  t("companySettings.archiveConfirm", { name: selectedCompany.name })
                );
                if (!confirmed) return;
                const nextCompanyId =
                  companies.find(
                    (company) =>
                      company.id !== selectedCompanyId &&
                      company.status !== "archived"
                  )?.id ?? null;
                archiveMutation.mutate({
                  companyId: selectedCompanyId,
                  nextCompanyId
                });
              }}
            >
              {archiveMutation.isPending
                ? t("companySettings.archiving")
                : selectedCompany.status === "archived"
                ? t("companySettings.alreadyArchived")
                : t("companySettings.archiveCompany")}
            </Button>
            {archiveMutation.isError && (
              <span className="text-xs text-destructive">
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : t("companySettings.archiveFailed")}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
