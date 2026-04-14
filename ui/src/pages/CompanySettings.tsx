import { ChangeEvent, useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { companiesApi } from "../api/companies";
import { accessApi } from "../api/access";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/runtime";
import { Settings, Check, Download, Upload } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import {
  Field,
  ToggleField,
  HintIcon
} from "../components/agent-config-primitives";

type AgentSnippetInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId
  } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setLogoUrl(selectedCompany.logoUrl ?? "");
  }, [selectedCompany]);

  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSnippet, setInviteSnippet] = useState<string | null>(null);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [snippetCopyDelightId, setSnippetCopyDelightId] = useState(0);

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? ""));

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
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

  const feedbackSharingMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        feedbackDataSharingEnabled: enabled,
      }),
    onSuccess: (_company, enabled) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      pushToast({
        title: enabled
          ? t("companySettings.feedbackSharing.toast.enabled", "Feedback sharing enabled")
          : t("companySettings.feedbackSharing.toast.disabled", "Feedback sharing disabled"),
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: t("companySettings.feedbackSharing.toast.updateFailed", "Failed to update feedback sharing"),
        body: err instanceof Error ? err.message : t("companySettings.feedbackSharing.toast.unknownError", "Unknown error"),
        tone: "error",
      });
    },
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createOpenClawInvitePrompt(selectedCompanyId!),
    onSuccess: async (invite) => {
      setInviteError(null);
      const base = window.location.origin.replace(/\/+$/, "");
      const onboardingTextLink =
        invite.onboardingTextUrl ??
        invite.onboardingTextPath ??
        `/api/invites/${invite.token}/onboarding.txt`;
      const absoluteUrl = onboardingTextLink.startsWith("http")
        ? onboardingTextLink
        : `${base}${onboardingTextLink}`;
      setSnippetCopied(false);
      setSnippetCopyDelightId(0);
      let snippet: string;
      try {
        const manifest = await accessApi.getInviteOnboarding(invite.token);
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates:
            manifest.onboarding.connectivity?.connectionCandidates ?? null,
          testResolutionUrl:
            manifest.onboarding.connectivity?.testResolutionEndpoint?.url ??
            null
        });
      } catch {
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates: null,
          testResolutionUrl: null
        });
      }
      setInviteSnippet(snippet);
      try {
        await navigator.clipboard.writeText(snippet);
        setSnippetCopied(true);
        setSnippetCopyDelightId((prev) => prev + 1);
        setTimeout(() => setSnippetCopied(false), 2000);
      } catch {
        /* clipboard may not be available */
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(selectedCompanyId!)
      });
    },
    onError: (err) => {
      setInviteError(
        err instanceof Error ? err.message : t("companySettings.invites.createFailed", "Failed to create invite")
      );
    }
  });

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

  useEffect(() => {
    setInviteError(null);
    setInviteSnippet(null);
    setSnippetCopied(false);
    setSnippetCopyDelightId(0);
  }, [selectedCompanyId]);

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
      { label: selectedCompany?.name ?? t("companySettings.breadcrumb.companyFallback", "Company"), href: "/dashboard" },
      { label: t("companySettings.breadcrumb.settings", "Settings") }
    ]);
  }, [setBreadcrumbs, selectedCompany?.name, t]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("companySettings.empty.selectCompany", "No company selected. Select a company from the switcher above.")}
      </div>
    );
  }

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t("companySettings.title", "Company Settings")}</h1>
      </div>

      {/* General */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.sections.general", "General")}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field
            label={t("companySettings.fields.companyName.label", "Company name")}
            hint={t("companySettings.fields.companyName.hint", "The display name for your company.")}
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field
            label={t("companySettings.fields.description.label", "Description")}
            hint={t("companySettings.fields.description.hint", "Optional description shown in the company profile.")}
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={description}
              placeholder={t("companySettings.fields.description.placeholder", "Optional company description")}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.sections.appearance", "Appearance")}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <CompanyPatternIcon
                companyName={companyName || selectedCompany.name}
                logoUrl={logoUrl || null}
                brandColor={brandColor || null}
                className="rounded-[14px]"
              />
            </div>
            <div className="flex-1 space-y-3">
              <Field
                label={t("companySettings.fields.logo.label", "Logo")}
                hint={t("companySettings.fields.logo.hint", "Upload a PNG, JPEG, WEBP, GIF, or SVG logo image.")}
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
                        {clearLogoMutation.isPending
                          ? t("companySettings.fields.logo.removing", "Removing...")
                          : t("companySettings.fields.logo.remove", "Remove logo")}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <span className="text-xs text-destructive">
                      {logoUploadError ??
                        (logoUploadMutation.error instanceof Error
                          ? logoUploadMutation.error.message
                          : t("companySettings.fields.logo.uploadFailed", "Logo upload failed"))}
                    </span>
                  )}
                  {clearLogoMutation.isError && (
                    <span className="text-xs text-destructive">
                      {clearLogoMutation.error.message}
                    </span>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-muted-foreground">
                      {t("companySettings.fields.logo.uploading", "Uploading logo...")}
                    </span>
                  )}
                </div>
              </Field>
              <Field
                label={t("companySettings.fields.brandColor.label", "Brand color")}
                hint={t("companySettings.fields.brandColor.hint", "Sets the hue for the company icon. Leave empty for auto-generated color.")}
              >
                <div className="flex items-center gap-2">
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
                    placeholder={t("companySettings.fields.brandColor.placeholder", "Auto")}
                    className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-muted-foreground"
                    >
                      {t("companySettings.fields.brandColor.clear", "Clear")}
                    </Button>
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
            disabled={generalMutation.isPending || !companyName.trim()}
          >
            {generalMutation.isPending
              ? t("companySettings.actions.saving", "Saving...")
              : t("companySettings.actions.saveChanges", "Save changes")}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">{t("companySettings.actions.saved", "Saved")}</span>
          )}
          {generalMutation.isError && (
            <span className="text-xs text-destructive">
              {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : t("companySettings.actions.saveFailed", "Failed to save")}
            </span>
          )}
        </div>
      )}

      {/* Hiring */}
      <div className="space-y-4" data-testid="company-settings-team-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.sections.hiring", "Hiring")}
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label={t("companySettings.hiring.requireBoardApproval.label", "Require board approval for new hires")}
            hint={t("companySettings.hiring.requireBoardApproval.hint", "New agent hires stay pending until approved by board.")}
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
            toggleTestId="company-settings-team-approval-toggle"
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.sections.feedbackSharing", "Feedback Sharing")}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <ToggleField
            label={t("companySettings.feedbackSharing.toggle.label", "Allow sharing voted AI outputs with Paperclip Labs")}
            hint={t("companySettings.feedbackSharing.toggle.hint", "Only AI-generated outputs you explicitly vote on are eligible for feedback sharing.")}
            checked={!!selectedCompany.feedbackDataSharingEnabled}
            onChange={(enabled) => feedbackSharingMutation.mutate(enabled)}
          />
          <p className="text-sm text-muted-foreground">
            {t("companySettings.feedbackSharing.description", "Votes are always saved locally. This setting controls whether voted AI outputs may also be marked for sharing with Paperclip Labs.")}
          </p>
          <div className="space-y-1 text-xs text-muted-foreground">
            <div>
              {t("companySettings.feedbackSharing.termsVersion", "Terms version")}: {selectedCompany.feedbackDataSharingTermsVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION}
            </div>
            {selectedCompany.feedbackDataSharingConsentAt ? (
              <div>
                {t("companySettings.feedbackSharing.enabledAt", "Enabled")} {new Date(selectedCompany.feedbackDataSharingConsentAt).toLocaleString()}
                {selectedCompany.feedbackDataSharingConsentByUserId
                  ? ` ${t("companySettings.feedbackSharing.byUser", "by")} ${selectedCompany.feedbackDataSharingConsentByUserId}`
                  : ""}
              </div>
            ) : (
              <div>{t("companySettings.feedbackSharing.disabled", "Sharing is currently disabled.")}</div>
            )}
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-foreground underline underline-offset-4"
              >
                {t("companySettings.feedbackSharing.readTerms", "Read our terms of service")}
              </a>
            ) : null}
          </div>
        </div>
      </div>

      {/* Invites */}
      <div className="space-y-4" data-testid="company-settings-invites-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.sections.invites", "Invites")}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {t("companySettings.invites.description", "Generate an OpenClaw agent invite snippet.")}
            </span>
            <HintIcon text={t("companySettings.invites.hint", "Creates a short-lived OpenClaw agent invite and renders a copy-ready prompt.")} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="company-settings-invites-generate-button"
              size="sm"
              onClick={() => inviteMutation.mutate()}
              disabled={inviteMutation.isPending}
            >
              {inviteMutation.isPending
                ? t("companySettings.invites.generating", "Generating...")
                : t("companySettings.invites.generatePrompt", "Generate OpenClaw Invite Prompt")}
            </Button>
          </div>
          {inviteError && (
            <p className="text-sm text-destructive">{inviteError}</p>
          )}
          {inviteSnippet && (
            <div
              className="rounded-md border border-border bg-muted/30 p-2"
              data-testid="company-settings-invites-snippet"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  {t("companySettings.invites.promptLabel", "OpenClaw Invite Prompt")}
                </div>
                {snippetCopied && (
                  <span
                    key={snippetCopyDelightId}
                    className="flex items-center gap-1 text-xs text-green-600 animate-pulse"
                  >
                    <Check className="h-3 w-3" />
                    {t("companySettings.invites.copied", "Copied")}
                  </span>
                )}
              </div>
              <div className="mt-1 space-y-1.5">
                <textarea
                  data-testid="company-settings-invites-snippet-textarea"
                  className="h-[28rem] w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none"
                  value={inviteSnippet}
                  readOnly
                />
                <div className="flex justify-end">
                  <Button
                    data-testid="company-settings-invites-copy-button"
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(inviteSnippet);
                        setSnippetCopied(true);
                        setSnippetCopyDelightId((prev) => prev + 1);
                        setTimeout(() => setSnippetCopied(false), 2000);
                      } catch {
                        /* clipboard may not be available */
                      }
                    }}
                  >
                    {snippetCopied
                      ? t("companySettings.invites.copySnippetDone", "Copied snippet")
                      : t("companySettings.invites.copySnippet", "Copy snippet")}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Import / Export */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.sections.companyPackages", "Company Packages")}
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            {t("companySettings.companyPackages.descriptionPrefix", "Import and export have moved to dedicated pages accessible from the ")}
            <a href="/org" className="underline hover:text-foreground">{t("companySettings.companyPackages.orgChart", "Org Chart")}</a>
            {t("companySettings.companyPackages.descriptionSuffix", " header.")}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link to="/company/export">
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t("companySettings.companyPackages.export", "Export")}
              </Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/company/import">
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {t("companySettings.companyPackages.import", "Import")}
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-destructive uppercase tracking-wide">
          {t("companySettings.sections.dangerZone", "Danger Zone")}
        </div>
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            {t("companySettings.dangerZone.description", "Archive this company to hide it from the sidebar. This persists in the database.")}
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
                  t(
                    "companySettings.dangerZone.archiveConfirm",
                    "Archive company \"{{name}}\"? It will be hidden from the sidebar.",
                    { name: selectedCompany.name },
                  )
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
                ? t("companySettings.dangerZone.archiving", "Archiving...")
                : selectedCompany.status === "archived"
                ? t("companySettings.dangerZone.alreadyArchived", "Already archived")
                : t("companySettings.dangerZone.archiveCompany", "Archive company")}
            </Button>
            {archiveMutation.isError && (
              <span className="text-xs text-destructive">
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : t("companySettings.dangerZone.archiveFailed", "Failed to archive company")}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function buildAgentSnippet(input: AgentSnippetInput) {
  const candidateUrls = buildCandidateOnboardingUrls(input);
  const resolutionTestUrl = buildResolutionTestUrl(input);

  const candidateList =
    candidateUrls.length > 0
      ? candidateUrls.map((u) => `- ${u}`).join("\n")
      : "- (No candidate URLs available yet.)";

  const connectivityBlock =
    candidateUrls.length === 0
      ? `当前没有可用的候选 URL。请让你的用户先在 Paperclip 中配置一个可达的主机名，然后再重试。
建议步骤：
- 选择一个在你的运行环境中能够解析到 Paperclip 主机的主机名
- 运行：pnpm paperclipai allowed-hostname <host>
- 重启 Paperclip
- 验证：curl -fsS http://<host>:3100/api/health
- 重新生成这段邀请片段`
      : `如果这些地址都不可达，请让你的用户在 Paperclip 中添加一个可达主机名，重启后再试。
建议命令：
- pnpm paperclipai allowed-hostname <host>
然后验证：curl -fsS <base-url>/api/health`;

  const resolutionLine = resolutionTestUrl
    ? `\n你必须测试 Paperclip 到 gateway 的连通性，请调用：${resolutionTestUrl}?url=<urlencoded-gateway-url>（使用上面已经验证可用的主机名）。不要假设你的 172.x 地址一定能被 Paperclip 访问到，务必实际测试。`
    : "";

  return `你已被邀请加入一个 Paperclip 组织。

你应该尝试的 URL：
${candidateList}

连通性说明：
如果你运行在与 Paperclip 不同的机器上，Paperclip 必须能通过上述某个主机名访问到你。
请先在你的运行环境里验证该主机名可用：GET <base-url>/api/health

${connectivityBlock}

对于 “agentName”，直接使用你自己的智能体名称（OpenClaw 或你的实际名称）并原样发送即可。
你还需要提供一个 Paperclip 可以访问的 gateway URL。请检查你的配置并附上该 URL。${resolutionLine}

---

此引导流程适用于 OpenClaw Gateway。
提交加入请求时，请使用：
- \`adapterType: "openclaw_gateway"\`
- 将 \`agentDefaultsPayload.url\` 设为你的 \`ws://\` 或 \`wss://\` gateway URL
- 将 \`agentDefaultsPayload.headers["x-openclaw-token"]\` 设为你的 gateway token
- （兼容旧版本）也可使用 \`agentDefaultsPayload.headers["x-openclaw-auth"]\`
- 建议保持 device auth 启用。如果省略 \`devicePrivateKeyPem\`，Paperclip 会在加入时自动生成并持久化，以保持配对审批稳定。
- 仅在无法完成配对的特殊环境中使用 \`disableDeviceAuth=true\`。

在此加入流程中，不要使用 \`/v1/responses\` 或 \`/hooks/*\`。

在做任何事之前，请先回复你的用户：你已经理解这些说明，并将开始执行。然后在另一个名为 "paperclip-onboarding" 的会话里完成上述步骤，并在完成后告知你的用户。过程中也要持续给用户同步中间进展，让他们知道当前情况。

当你连接到 Paperclip（完成密钥交换等）之后，你必须继续查看并遵循他们提供给你的 onboarding.txt 中的引导说明。

`;
}

function buildCandidateOnboardingUrls(input: AgentSnippetInput): string[] {
  const candidates = (input.connectionCandidates ?? [])
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const urls = new Set<string>();
  let onboardingUrl: URL | null = null;

  try {
    onboardingUrl = new URL(input.onboardingTextUrl);
    urls.add(onboardingUrl.toString());
  } catch {
    const trimmed = input.onboardingTextUrl.trim();
    if (trimmed) {
      urls.add(trimmed);
    }
  }

  if (!onboardingUrl) {
    for (const candidate of candidates) {
      urls.add(candidate);
    }
    return Array.from(urls);
  }

  const onboardingPath = `${onboardingUrl.pathname}${onboardingUrl.search}`;
  for (const candidate of candidates) {
    try {
      const base = new URL(candidate);
      urls.add(`${base.origin}${onboardingPath}`);
    } catch {
      urls.add(candidate);
    }
  }

  return Array.from(urls);
}

function buildResolutionTestUrl(input: AgentSnippetInput): string | null {
  const explicit = input.testResolutionUrl?.trim();
  if (explicit) return explicit;

  try {
    const onboardingUrl = new URL(input.onboardingTextUrl);
    const testPath = onboardingUrl.pathname.replace(
      /\/onboarding\.txt$/,
      "/test-resolution"
    );
    return `${onboardingUrl.origin}${testPath}`;
  } catch {
    return null;
  }
}
