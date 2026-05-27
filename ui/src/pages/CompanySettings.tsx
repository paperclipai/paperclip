import { ChangeEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { assetsApi } from "../api/assets";
import { companySkillsApi } from "../api/companySkills";
import { brabrixApi, type BrabrixConnectionTestResponse } from "../api/brabrix";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Settings, CloudUpload, Download, Upload } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { SecretBindingPicker, type SecretBindingValue } from "../components/SecretBindingPicker";
import {
  Field,
  ToggleField,
} from "../components/agent-config-primitives";

const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_COMPANY_ATTACHMENT_MAX_MIB = DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB;
const MAX_COMPANY_ATTACHMENT_MAX_MIB = MAX_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB;
export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId
  } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const brabrixSkillHubSettingsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.companySkills.brabrixSettings(selectedCompanyId)
      : ["company-skills", "__disabled__", "brabrix-skillhub", "settings"],
    queryFn: () => companySkillsApi.getBrabrixSkillHubSettings(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const brabrixSyncSettingsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.brabrix.settings(selectedCompanyId)
      : ["brabrix", "__disabled__", "settings"],
    queryFn: () => brabrixApi.getSettings(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const brabrixProjectsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.brabrix.projects(selectedCompanyId)
      : ["brabrix", "__disabled__", "projects"],
    queryFn: () => brabrixApi.listProjects(selectedCompanyId!),
    enabled: false,
    retry: false,
  });
  const brabrixImportedProjectsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.brabrix.importedProjects(selectedCompanyId)
      : ["brabrix", "__disabled__", "imported-projects"],
    queryFn: () => brabrixApi.listImportedProjects(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [attachmentMaxMiB, setAttachmentMaxMiB] = useState(String(DEFAULT_COMPANY_ATTACHMENT_MAX_MIB));
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);
  const [brabrixApiKeyBinding, setBrabrixApiKeyBinding] = useState<SecretBindingValue | null>(null);
  const [brabrixAgentTokenBinding, setBrabrixAgentTokenBinding] = useState<SecretBindingValue | null>(null);
  const [brabrixProjectIdBinding, setBrabrixProjectIdBinding] = useState<SecretBindingValue | null>(null);
  const [brabrixTenantIdBinding, setBrabrixTenantIdBinding] = useState<SecretBindingValue | null>(null);
  const [selectedBrabrixProjectId, setSelectedBrabrixProjectId] = useState("");
  const [brabrixConnectionResult, setBrabrixConnectionResult] = useState<BrabrixConnectionTestResponse | null>(null);
  const remoteBrabrixProjects = brabrixProjectsQuery.data?.projects ?? [];
  const importedBrabrixProjects = brabrixImportedProjectsQuery.data?.projects ?? [];
  const hasSelectedBrabrixProject = selectedBrabrixProjectId.trim().length > 0;

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setAttachmentMaxMiB(String(Math.round((selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES) / BYTES_PER_MIB)));
    setLogoUrl(selectedCompany.logoUrl ?? "");
  }, [selectedCompany]);

  useEffect(() => {
    if (!brabrixSkillHubSettingsQuery.data) return;
    setBrabrixApiKeyBinding(
      brabrixSkillHubSettingsQuery.data.apiKeySecretId
        ? { secretId: brabrixSkillHubSettingsQuery.data.apiKeySecretId, version: "latest" }
        : null,
    );
  }, [brabrixSkillHubSettingsQuery.data]);

  useEffect(() => {
    if (!brabrixSyncSettingsQuery.data) return;
    setBrabrixAgentTokenBinding(
      brabrixSyncSettingsQuery.data.agentTokenSecretId
        ? { secretId: brabrixSyncSettingsQuery.data.agentTokenSecretId, version: "latest" }
        : null,
    );
    setBrabrixProjectIdBinding(
      brabrixSyncSettingsQuery.data.projectIdSecretId
        ? { secretId: brabrixSyncSettingsQuery.data.projectIdSecretId, version: "latest" }
        : null,
    );
    setBrabrixTenantIdBinding(
      brabrixSyncSettingsQuery.data.tenantIdSecretId
        ? { secretId: brabrixSyncSettingsQuery.data.tenantIdSecretId, version: "latest" }
        : null,
    );
  }, [brabrixSyncSettingsQuery.data]);

  useEffect(() => {
    setSelectedBrabrixProjectId("");
    setBrabrixConnectionResult(null);
  }, [selectedCompanyId]);

  useEffect(() => {
    if (remoteBrabrixProjects.length === 0) {
      if (selectedBrabrixProjectId) {
        setSelectedBrabrixProjectId("");
      }
      return;
    }

    const hasCurrentSelection = remoteBrabrixProjects.some((project) => project.projectId === selectedBrabrixProjectId);
    if (hasCurrentSelection) return;

    const importedIds = new Set(importedBrabrixProjects.map((project) => project.brabrixProjectId));
    const preferredProject = remoteBrabrixProjects.find((project) => importedIds.has(project.projectId))
      ?? remoteBrabrixProjects[0];
    setSelectedBrabrixProjectId(preferredProject.projectId);
  }, [remoteBrabrixProjects, importedBrabrixProjects, selectedBrabrixProjectId]);

  const attachmentMaxBytes = Number.parseInt(attachmentMaxMiB, 10) * BYTES_PER_MIB;
  const attachmentMaxValid =
    Number.isInteger(attachmentMaxBytes)
    && attachmentMaxBytes >= BYTES_PER_MIB
    && attachmentMaxBytes <= MAX_COMPANY_ATTACHMENT_MAX_BYTES;
  const cloudSyncEnabled = experimentalSettings?.enableCloudSync === true;

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? "") ||
      attachmentMaxBytes !== (selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES));
  const currentBrabrixApiKeySecretId = brabrixSkillHubSettingsQuery.data?.apiKeySecretId ?? null;
  const brabrixSkillHubDirty = (brabrixApiKeyBinding?.secretId ?? null) !== currentBrabrixApiKeySecretId;
  const currentBrabrixAgentTokenSecretId = brabrixSyncSettingsQuery.data?.agentTokenSecretId ?? null;
  const currentBrabrixProjectIdSecretId = brabrixSyncSettingsQuery.data?.projectIdSecretId ?? null;
  const currentBrabrixTenantIdSecretId = brabrixSyncSettingsQuery.data?.tenantIdSecretId ?? null;
  const brabrixSyncDirty = (brabrixAgentTokenBinding?.secretId ?? null) !== currentBrabrixAgentTokenSecretId
    || (brabrixProjectIdBinding?.secretId ?? null) !== currentBrabrixProjectIdSecretId
    || (brabrixTenantIdBinding?.secretId ?? null) !== currentBrabrixTenantIdSecretId;
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

  const brabrixSkillHubSettingsMutation = useMutation({
    mutationFn: (apiKeySecretId: string | null) =>
      companySkillsApi.updateBrabrixSkillHubSettings(selectedCompanyId!, { apiKeySecretId }),
    onSuccess: async (updated) => {
      setBrabrixApiKeyBinding(updated.apiKeySecretId ? { secretId: updated.apiKeySecretId, version: "latest" } : null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.brabrixSettings(selectedCompanyId!) });
    },
  });

  const brabrixSyncSettingsMutation = useMutation({
    mutationFn: (payload: { agentTokenSecretId: string | null; projectIdSecretId: string | null; tenantIdSecretId: string | null }) =>
      brabrixApi.updateSettings(selectedCompanyId!, payload),
    onSuccess: async (updated) => {
      setBrabrixAgentTokenBinding(
        updated.agentTokenSecretId
          ? { secretId: updated.agentTokenSecretId, version: "latest" }
          : null,
      );
      setBrabrixProjectIdBinding(
        updated.projectIdSecretId
          ? { secretId: updated.projectIdSecretId, version: "latest" }
          : null,
      );
      setBrabrixTenantIdBinding(
        updated.tenantIdSecretId
          ? { secretId: updated.tenantIdSecretId, version: "latest" }
          : null,
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.brabrix.settings(selectedCompanyId!) });
    },
  });

  const brabrixTestConnectionMutation = useMutation({
    mutationFn: () => brabrixApi.testConnection(selectedCompanyId!),
    onSuccess: (result) => {
      setBrabrixConnectionResult(result);
      if (result.ok) {
        void brabrixProjectsQuery.refetch();
      }
    },
  });

  const brabrixImportProjectMutation = useMutation({
    mutationFn: (projectId: string) => brabrixApi.importProject(selectedCompanyId!, projectId),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.brabrix.importedProjects(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) }),
      ]);
      setSelectedBrabrixProjectId(result.brabrixProjectId);
    },
  });

  const brabrixSyncProjectMutation = useMutation({
    mutationFn: (projectId: string) => brabrixApi.syncProject(selectedCompanyId!, projectId),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.brabrix.importedProjects(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) }),
      ]);
      setSelectedBrabrixProjectId(result.brabrixProjectId);
    },
  });

  const brabrixDisconnectProjectMutation = useMutation({
    mutationFn: (projectId: string) => brabrixApi.disconnectProject(selectedCompanyId!, projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.brabrix.importedProjects(selectedCompanyId!) });
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings" }
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
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
        <h1 className="text-lg font-semibold">Company Settings</h1>
      </div>

      {/* General */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          General
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label="Company name" hint="The display name for your company.">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field
            label="Description"
            hint="Optional description shown in the company profile."
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={description}
              placeholder="Optional company description"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Appearance
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
                label="Logo"
                hint="Upload a PNG, JPEG, WEBP, GIF, or SVG logo image."
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
                        {clearLogoMutation.isPending ? "Removing..." : "Remove logo"}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <span className="text-xs text-destructive">
                      {logoUploadError ??
                        (logoUploadMutation.error instanceof Error
                          ? logoUploadMutation.error.message
                          : "Logo upload failed")}
                    </span>
                  )}
                  {clearLogoMutation.isError && (
                    <span className="text-xs text-destructive">
                      {clearLogoMutation.error.message}
                    </span>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-muted-foreground">Uploading logo...</span>
                  )}
                </div>
              </Field>
              <Field
                label="Brand color"
                hint="Sets the hue for the company icon. Leave empty for auto-generated color."
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
                    placeholder="Auto"
                    className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-muted-foreground"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </Field>
              <Field
                label="Attachment size limit"
                hint={`Accepted range: 1-${MAX_COMPANY_ATTACHMENT_MAX_MIB} MiB.`}
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
                      Enter a whole number from 1 to {MAX_COMPANY_ATTACHMENT_MAX_MIB}.
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
            {generalMutation.isPending ? "Saving..." : "Save changes"}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">Saved</span>
          )}
          {generalMutation.isError && (
            <span className="text-xs text-destructive">
              {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : "Failed to save"}
            </span>
          )}
        </div>
      )}

      {/* Hiring */}
      <div className="space-y-4" data-testid="company-settings-team-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Hiring
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label="Require board approval for new hires"
            hint="New agent hires stay pending until approved by board."
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
            toggleTestId="company-settings-team-approval-toggle"
          />
        </div>
      </div>

      <div className="space-y-4" data-testid="company-settings-brabrix-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Brabrix
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field
            label="Brabrix Task Sync Token/API key"
            hint="Secret used by Brabrix project import/sync flows (supports bbx_ API key or Bearer token)."
          >
            <div className="space-y-2">
              <SecretBindingPicker
                value={brabrixAgentTokenBinding}
                onChange={setBrabrixAgentTokenBinding}
                allowVersionSelector={false}
                placeholder="Select secret for Brabrix Agent token"
                emptyHint="No active secrets found. Create one and bind it here."
              />
              <p className="text-xs text-muted-foreground">
                Token source: {brabrixSyncSettingsQuery.data?.credentialSource.agentToken ?? "none"}
              </p>
            </div>
          </Field>

          <Field
            label="Brabrix Task Sync Project ID"
            hint="Secret containing the Brabrix project/workspace identifier."
          >
            <div className="space-y-2">
              <SecretBindingPicker
                value={brabrixProjectIdBinding}
                onChange={setBrabrixProjectIdBinding}
                allowVersionSelector={false}
                placeholder="Select secret for Brabrix project ID"
                emptyHint="No active secrets found. Create one and bind it here."
              />
              <p className="text-xs text-muted-foreground">
                Project source: {brabrixSyncSettingsQuery.data?.credentialSource.projectId ?? "none"}
              </p>
            </div>
          </Field>

          <Field
            label="Brabrix Tenant ID"
            hint="Optional. Use only if your Brabrix account requires explicit tenant scoping."
          >
            <div className="space-y-2">
              <SecretBindingPicker
                value={brabrixTenantIdBinding}
                onChange={setBrabrixTenantIdBinding}
                allowVersionSelector={false}
                placeholder="Select secret for Brabrix tenant ID"
                emptyHint="No active secrets found. Create one and bind it here."
              />
              <p className="text-xs text-muted-foreground">
                Tenant source: {brabrixSyncSettingsQuery.data?.credentialSource.tenantId ?? "none"}
              </p>
              <p className="text-xs text-muted-foreground">
                Sync status: {brabrixSyncSettingsQuery.data?.enabled ? "enabled" : "disabled"}
              </p>
            </div>
          </Field>

          {brabrixSyncDirty && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => brabrixSyncSettingsMutation.mutate({
                  agentTokenSecretId: brabrixAgentTokenBinding?.secretId ?? null,
                  projectIdSecretId: brabrixProjectIdBinding?.secretId ?? null,
                  tenantIdSecretId: brabrixTenantIdBinding?.secretId ?? null,
                })}
                disabled={brabrixSyncSettingsMutation.isPending}
              >
                {brabrixSyncSettingsMutation.isPending ? "Saving..." : "Save Brabrix sync settings"}
              </Button>
              {brabrixSyncSettingsMutation.isSuccess && (
                <span className="text-xs text-muted-foreground">Saved</span>
              )}
              {brabrixSyncSettingsMutation.isError && (
                <span className="text-xs text-destructive">
                  {brabrixSyncSettingsMutation.error instanceof Error
                    ? brabrixSyncSettingsMutation.error.message
                    : "Failed to save Brabrix sync settings"}
                </span>
              )}
            </div>
          )}

          <div className="space-y-3 rounded-md border border-border bg-muted/20 px-3 py-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">Brabrix Project Import</p>
              <p className="text-xs text-muted-foreground">
                Recommended flow: Test Connection, Select Project, Import Project, then Sync Project.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => brabrixTestConnectionMutation.mutate()}
                disabled={!selectedCompanyId || brabrixTestConnectionMutation.isPending}
              >
                {brabrixTestConnectionMutation.isPending ? "Testing..." : "Test Connection"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void brabrixProjectsQuery.refetch()}
                disabled={!selectedCompanyId || brabrixProjectsQuery.isFetching}
              >
                {brabrixProjectsQuery.isFetching ? "Loading..." : "Load Projects"}
              </Button>
            </div>

            {brabrixConnectionResult && (
              <p className={`text-xs ${brabrixConnectionResult.ok ? "text-emerald-600" : "text-destructive"}`}>
                {brabrixConnectionResult.message}
                {typeof brabrixConnectionResult.projectCount === "number"
                  ? ` (${brabrixConnectionResult.projectCount} project(s))`
                  : ""}
              </p>
            )}
            {brabrixTestConnectionMutation.isError && (
              <p className="text-xs text-destructive">
                {brabrixTestConnectionMutation.error instanceof Error
                  ? brabrixTestConnectionMutation.error.message
                  : "Failed to test Brabrix connection"}
              </p>
            )}
            {brabrixProjectsQuery.isError && (
              <p className="text-xs text-destructive">
                {brabrixProjectsQuery.error instanceof Error
                  ? brabrixProjectsQuery.error.message
                  : "Failed to load Brabrix projects"}
              </p>
            )}

            <Field
              label="Select Brabrix project"
              hint="Select which Brabrix Project to import/sync as local workspace, goals, issues and skills."
            >
              <select
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                value={selectedBrabrixProjectId}
                onChange={(event) => setSelectedBrabrixProjectId(event.target.value)}
              >
                <option value="">Select a Brabrix project</option>
                {remoteBrabrixProjects.map((project) => (
                  <option key={project.projectId} value={project.projectId}>
                    {project.name} ({project.projectId})
                  </option>
                ))}
              </select>
            </Field>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  if (!hasSelectedBrabrixProject) return;
                  brabrixImportProjectMutation.mutate(selectedBrabrixProjectId);
                }}
                disabled={!selectedCompanyId || !hasSelectedBrabrixProject || brabrixImportProjectMutation.isPending}
              >
                {brabrixImportProjectMutation.isPending ? "Importing..." : "Import Project"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!hasSelectedBrabrixProject) return;
                  brabrixSyncProjectMutation.mutate(selectedBrabrixProjectId);
                }}
                disabled={!selectedCompanyId || !hasSelectedBrabrixProject || brabrixSyncProjectMutation.isPending}
              >
                {brabrixSyncProjectMutation.isPending ? "Syncing..." : "Sync Project"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (!hasSelectedBrabrixProject) return;
                  brabrixDisconnectProjectMutation.mutate(selectedBrabrixProjectId);
                }}
                disabled={!selectedCompanyId || !hasSelectedBrabrixProject || brabrixDisconnectProjectMutation.isPending}
              >
                {brabrixDisconnectProjectMutation.isPending ? "Disconnecting..." : "Disconnect Brabrix Project"}
              </Button>
            </div>

            {brabrixImportProjectMutation.isSuccess && (
              <p className="text-xs text-muted-foreground">
                Imported "{brabrixImportProjectMutation.data.projectName}".
                Goals: {brabrixImportProjectMutation.data.counts.goalsUpserted}, Issues: {brabrixImportProjectMutation.data.counts.issuesUpserted}, Skills: {brabrixImportProjectMutation.data.counts.skillsImported}.
              </p>
            )}
            {brabrixImportProjectMutation.isError && (
              <p className="text-xs text-destructive">
                {brabrixImportProjectMutation.error instanceof Error
                  ? brabrixImportProjectMutation.error.message
                  : "Failed to import Brabrix project"}
              </p>
            )}
            {brabrixSyncProjectMutation.isSuccess && (
              <p className="text-xs text-muted-foreground">
                Synced "{brabrixSyncProjectMutation.data.projectName}".
                Goals: {brabrixSyncProjectMutation.data.counts.goalsUpserted}, Issues: {brabrixSyncProjectMutation.data.counts.issuesUpserted}, Skills: {brabrixSyncProjectMutation.data.counts.skillsImported}.
              </p>
            )}
            {brabrixSyncProjectMutation.isError && (
              <p className="text-xs text-destructive">
                {brabrixSyncProjectMutation.error instanceof Error
                  ? brabrixSyncProjectMutation.error.message
                  : "Failed to sync Brabrix project"}
              </p>
            )}
            {brabrixDisconnectProjectMutation.isSuccess && (
              <p className="text-xs text-muted-foreground">Brabrix project disconnected from local workspace metadata.</p>
            )}
            {brabrixDisconnectProjectMutation.isError && (
              <p className="text-xs text-destructive">
                {brabrixDisconnectProjectMutation.error instanceof Error
                  ? brabrixDisconnectProjectMutation.error.message
                  : "Failed to disconnect Brabrix project"}
              </p>
            )}

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Imported Projects</p>
              {brabrixImportedProjectsQuery.isError && (
                <p className="text-xs text-destructive">
                  {brabrixImportedProjectsQuery.error instanceof Error
                    ? brabrixImportedProjectsQuery.error.message
                    : "Failed to load imported Brabrix projects"}
                </p>
              )}
              {brabrixImportedProjectsQuery.isLoading && (
                <p className="text-xs text-muted-foreground">Loading imported projects...</p>
              )}
              {!brabrixImportedProjectsQuery.isLoading && importedBrabrixProjects.length === 0 ? (
                <p className="text-xs text-muted-foreground">No Brabrix projects imported in this company yet.</p>
              ) : (
                importedBrabrixProjects.map((project) => (
                  <div
                    key={`${project.localProjectId}-${project.workspaceId}-${project.brabrixProjectId}`}
                    className="space-y-1 rounded-md border border-border px-2.5 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">{project.localProjectName}</span>
                      {project.badges.imported && <Badge variant="outline">Imported from Brabrix</Badge>}
                      {project.badges.synced && <Badge variant="outline">Synced with Brabrix</Badge>}
                      {project.badges.outOfSync && <Badge variant="outline">Out of sync</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Brabrix Project: {project.brabrixProjectId}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Last sync: {project.brabrixLastSyncedAt ?? "never"}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="h-px w-full bg-border" />

          <Field
            label="Brabrix SkillHub API key"
            hint="Use a secret binding instead of env vars to keep cloud deploy credentials centralized in settings."
          >
            <div className="space-y-2">
              <SecretBindingPicker
                value={brabrixApiKeyBinding}
                onChange={setBrabrixApiKeyBinding}
                allowVersionSelector={false}
                placeholder="Select secret for Brabrix x-api-key"
                emptyHint="No active secrets found. Create one and bind it here."
              />
              <p className="text-xs text-muted-foreground">
                Credential source: {brabrixSkillHubSettingsQuery.data?.credentialSource ?? "none"}
              </p>
            </div>
          </Field>

          {brabrixSkillHubDirty && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => brabrixSkillHubSettingsMutation.mutate(brabrixApiKeyBinding?.secretId ?? null)}
                disabled={brabrixSkillHubSettingsMutation.isPending}
              >
                {brabrixSkillHubSettingsMutation.isPending ? "Saving..." : "Save Brabrix SkillHub settings"}
              </Button>
              {brabrixSkillHubSettingsMutation.isSuccess && (
                <span className="text-xs text-muted-foreground">Saved</span>
              )}
              {brabrixSkillHubSettingsMutation.isError && (
                <span className="text-xs text-destructive">
                  {brabrixSkillHubSettingsMutation.error instanceof Error
                    ? brabrixSkillHubSettingsMutation.error.message
                    : "Failed to save Brabrix SkillHub settings"}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Import / Export */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Company Packages
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Import and export have moved to dedicated pages accessible from the{" "}
            <a href="/org" className="underline hover:text-foreground">Org Chart</a> header.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {cloudSyncEnabled ? (
              <Button size="sm" asChild>
                <a href="/company/settings/cloud-upstream">
                  <CloudUpload className="mr-1.5 h-3.5 w-3.5" />
                  Send to Paperclip Cloud
                </a>
              </Button>
            ) : null}
            <Button size="sm" variant="outline" asChild>
              <a href="/company/export">
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Export
              </a>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href="/company/import">
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Import
              </a>
            </Button>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-destructive uppercase tracking-wide">
          Danger Zone
        </div>
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Archive this company to hide it from the sidebar. This persists in
            the database.
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
                  `Archive company "${selectedCompany.name}"? It will be hidden from the sidebar.`
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
                ? "Archiving..."
                : selectedCompany.status === "archived"
                ? "Already archived"
                : "Archive company"}
            </Button>
            {archiveMutation.isError && (
              <span className="text-xs text-destructive">
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : "Failed to archive company"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
