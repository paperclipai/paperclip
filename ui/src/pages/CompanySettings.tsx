import { ChangeEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { companiesApi } from "../api/companies";
import { agentsApi } from "../api/agents";
import { privacyApi } from "../api/privacy";
import { accessApi } from "../api/access";
import { assetsApi } from "../api/assets";
import { secretsApi } from "../api/secrets";
import { memberApi } from "../api/userInvites";
import { queryKeys } from "../lib/queryKeys";
import { useMeAccess } from "../hooks/useMeAccess";
import { Button } from "@/components/ui/button";
import { Settings, Check, Download, Upload, UserPlus, Key, Shield, Trash2, AlertTriangle, Database, Users, Plus, Pencil, X, SlidersHorizontal, Building2 } from "lucide-react";
import { MessagingSetup } from "../components/MessagingSetup";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { InviteUserDialog } from "../components/InviteUserDialog";
import { ApiKeyOnboardingBanner } from "../components/ApiKeyOnboardingBanner";
import {
  Field,
  ToggleField,
  HintIcon
} from "../components/agent-config-primitives";
import type { MembershipRole, CompanySecret } from "@ironworksai/shared";
import {
  MEMBERSHIP_ROLES,
  AGENT_ROLES,
  AGENT_ROLE_LABELS,
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  AUTONOMY_LEVELS,
  type AutonomyLevel,
} from "@ironworksai/shared";
import { roleTemplatesApi, type RoleTemplate } from "../api/roleTemplates";
import { executiveApi, type CompanyRiskSettings } from "../api/executive";

type AgentSnippetInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

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

  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

  // Default autonomy level — persisted per-company in localStorage
  const autonomyStorageKey = selectedCompanyId ? `ironworks:autonomy:${selectedCompanyId}` : null;
  const [defaultAutonomy, setDefaultAutonomy] = useState<AutonomyLevel>(() => {
    if (!autonomyStorageKey) return "h3";
    return (localStorage.getItem(autonomyStorageKey) as AutonomyLevel) ?? "h3";
  });
  function handleAutonomyChange(level: AutonomyLevel) {
    setDefaultAutonomy(level);
    if (autonomyStorageKey) localStorage.setItem(autonomyStorageKey, level);
    pushToast({ title: "Default autonomy level updated", tone: "success" });
  }
  const { isInstanceAdmin, getRoleForCompany } = useMeAccess();
  const myRole = selectedCompanyId ? getRoleForCompany(selectedCompanyId) : "member";
  const canManageMembers = myRole === "owner" || myRole === "admin" || isInstanceAdmin;

  const membersQuery = useQuery({
    queryKey: ["access", "members", selectedCompanyId],
    queryFn: () => accessApi.listJoinRequests(selectedCompanyId!, "approved"),
    enabled: !!selectedCompanyId && canManageMembers,
  });

  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(selectedCompanyId ?? ""),
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const configuredKeys = new Set(
    (secretsQuery.data ?? [])
      .filter((s: CompanySecret) => s.name === "ANTHROPIC_API_KEY" || s.name === "OPENAI_API_KEY")
      .map((s: CompanySecret) => s.name),
  );

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
        err instanceof Error ? err.message : "Failed to create invite"
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

  // Data export state
  const [exportLoading, setExportLoading] = useState(false);

  async function handleDataExport() {
    if (!selectedCompanyId) return;
    setExportLoading(true);
    try {
      const url = privacyApi.exportData(selectedCompanyId);
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      setExportLoading(false);
    }
  }

  // Data erasure state
  const [erasureConfirm, setErasureConfirm] = useState(false);

  const erasureMutation = useMutation({
    mutationFn: () => privacyApi.requestErasure(selectedCompanyId!),
    onSuccess: (data) => {
      pushToast({ title: "Erasure scheduled", body: data.message, tone: "success" });
      setErasureConfirm(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
    onError: () => {
      pushToast({ title: "Failed to request erasure", tone: "error" });
    },
  });

  const privacySummaryQuery = useQuery({
    queryKey: ["privacy", "summary", selectedCompanyId],
    queryFn: () => privacyApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

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
      brandColor: brandColor || null
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
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          General
        </h2>
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
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Appearance
        </h2>
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
      <div className="space-y-4">
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Hiring
        </h2>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label="Require board approval for new hires"
            hint="New agent hires stay pending until approved by board."
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
          />
        </div>
      </div>

      {/* Invites */}
      <div className="space-y-4">
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Invites
        </h2>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              Generate an OpenClaw agent invite snippet.
            </span>
            <HintIcon text="Creates a short-lived OpenClaw agent invite and renders a copy-ready prompt." />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => inviteMutation.mutate()}
              disabled={inviteMutation.isPending}
            >
              {inviteMutation.isPending
                ? "Generating..."
                : "Generate OpenClaw Invite Prompt"}
            </Button>
          </div>
          {inviteError && (
            <p role="alert" className="text-sm text-destructive">{inviteError}</p>
          )}
          {inviteSnippet && (
            <div className="rounded-md border border-border bg-muted/30 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  OpenClaw Invite Prompt
                </div>
                {snippetCopied && (
                  <span
                    key={snippetCopyDelightId}
                    className="flex items-center gap-1 text-xs text-green-600 animate-pulse"
                  >
                    <Check className="h-3 w-3" />
                    Copied
                  </span>
                )}
              </div>
              <div className="mt-1 space-y-1.5">
                <textarea
                  className="h-[28rem] w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none"
                  value={inviteSnippet}
                  readOnly
                />
                <div className="flex justify-end">
                  <Button
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
                    {snippetCopied ? "Copied snippet" : "Copy snippet"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Messaging Bridges */}
      <MessagingSetup companyId={selectedCompanyId!} />

      {/* Import / Export */}
      <div className="space-y-4">
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Company Packages
        </h2>
        <div className="rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Import and export have moved to dedicated pages accessible from the{" "}
            <a href="/org" className="underline hover:text-foreground">Org Chart</a> header.
          </p>
          <div className="mt-3 flex items-center gap-2">
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
        <h2 className="text-xs font-medium text-destructive uppercase tracking-wide">
          Danger Zone
        </h2>
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

      {/* Team & Invites */}
      {canManageMembers && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Team Members
            </h2>
            <Button size="sm" variant="outline" onClick={() => setInviteDialogOpen(true)}>
              <UserPlus className="h-3.5 w-3.5 mr-1.5" />
              Invite User
            </Button>
          </div>
          <div className="rounded-md border border-border divide-y divide-border">
            {(membersQuery.data ?? []).length === 0 && (
              <div className="px-4 py-3 text-xs text-muted-foreground">
                No team members yet. Invite users to get started.
              </div>
            )}
          </div>
        </div>
      )}

      {/* API Keys */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
          <Key className="h-3.5 w-3.5" />
          LLM API Keys
        </div>
        <ApiKeyOnboardingBanner />
        {configuredKeys.size > 0 && (
          <div className="rounded-md border border-border px-4 py-3">
            <div className="flex gap-2">
              {["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].map((keyName) => (
                <span
                  key={keyName}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
                    configuredKeys.has(keyName)
                      ? "bg-green-500/10 text-green-600 dark:text-green-400"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {configuredKeys.has(keyName) && <Check className="h-3 w-3" />}
                  {keyName === "ANTHROPIC_API_KEY" ? "Anthropic" : "OpenAI"}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Data Export */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
          <Download className="h-3.5 w-3.5" />
          Data Export
        </div>
        <div className="rounded-md border border-border px-4 py-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Download all your company data including agents, projects, issues, knowledge base, and activity history.
          </p>
          <p className="text-xs text-muted-foreground italic">
            API keys and secrets are never included in exports.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={handleDataExport}
            disabled={exportLoading}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {exportLoading ? "Generating export..." : "Export my data"}
          </Button>
        </div>
      </div>

      {/* Data & Privacy */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
          <Shield className="h-3.5 w-3.5" />
          Data &amp; Privacy
        </div>
        <div className="rounded-md border border-border px-4 py-4 space-y-4">
          {/* Retention policies */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Database className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">Data Retention Policy</span>
            </div>
            {privacySummaryQuery.data ? (
              <div className="space-y-1">
                {Object.entries(privacySummaryQuery.data.retentionPolicies).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}
                    </span>
                    <span className="font-mono text-muted-foreground">{value}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Activity log</span>
                  <span className="font-mono text-muted-foreground">365 days</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Cost events</span>
                  <span className="font-mono text-muted-foreground">365 days</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Execution logs</span>
                  <span className="font-mono text-muted-foreground">90 days</span>
                </div>
              </div>
            )}
          </div>

          {/* Deletion status or request button */}
          {selectedCompany.status === "pending_erasure" ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-destructive">Deletion scheduled</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  All data is scheduled for permanent deletion in 30 days. Contact support to cancel.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                You can request permanent deletion of all company data. Data will be removed 30 days after the request.
              </p>
              {erasureConfirm ? (
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                  <span className="text-xs text-destructive font-medium">
                    This schedules permanent deletion of ALL data. Are you sure?
                  </span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => erasureMutation.mutate()}
                    disabled={erasureMutation.isPending}
                  >
                    {erasureMutation.isPending ? "Requesting..." : "Confirm"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setErasureConfirm(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive border-destructive/40 hover:bg-destructive/5"
                  onClick={() => setErasureConfirm(true)}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Request data deletion
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Privacy & Data Link */}
      <div className="py-6 border-t border-border">
        <Link
          to="/privacy-settings"
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <Settings className="h-4 w-4" />
          Privacy & Data Settings
          <span className="text-xs text-muted-foreground ml-1">— Full data export, erasure, and GDPR rights</span>
        </Link>
      </div>

      {/* Default Autonomy Level */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Default Autonomy Level
        </div>
        <div className="rounded-md border border-border px-4 py-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Set the default level of human oversight applied to new agents in this company.
          </p>
          <div className="space-y-2">
            {AUTONOMY_LEVELS.map((level) => (
              <label
                key={level.key}
                className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                  defaultAutonomy === level.key
                    ? "border-indigo-500/60 bg-indigo-500/5"
                    : "border-border hover:border-border/80 hover:bg-muted/30"
                }`}
              >
                <input
                  type="radio"
                  name="autonomy-level"
                  value={level.key}
                  checked={defaultAutonomy === level.key}
                  onChange={() => handleAutonomyChange(level.key)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-indigo-500"
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-semibold text-indigo-400 uppercase">
                      {level.key.toUpperCase()}
                    </span>
                    <span className="text-sm font-medium">{level.label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{level.description}</p>
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Model Routing */}
      <ModelRoutingSection companyId={selectedCompanyId!} />

      {/* Department Templates */}
      <DepartmentTemplatesSection companyId={selectedCompanyId!} />

      {/* Risk Thresholds */}
      <RiskThresholdsSection companyId={selectedCompanyId!} />

      {/* Talent Pool */}
      <TalentPoolSection companyId={selectedCompanyId!} />

      <InviteUserDialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen} />
    </div>
  );
}

/* ── Model Routing Section ── */

const MODEL_ROUTING_STORAGE_KEY_PREFIX = "ironworks:modelRouting:";

function ModelRoutingSection({ companyId }: { companyId: string }) {
  const { pushToast } = useToast();
  const storageKey = `${MODEL_ROUTING_STORAGE_KEY_PREFIX}${companyId}`;

  const [enabled, setEnabled] = useState<boolean>(() => {
    const stored = localStorage.getItem(storageKey);
    return stored === null ? true : stored === "true";
  });

  function handleToggle(next: boolean) {
    setEnabled(next);
    localStorage.setItem(storageKey, String(next));
    pushToast({
      title: next ? "Smart model routing enabled" : "Smart model routing disabled",
      tone: "success",
    });
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Model Routing
      </h2>
      <div className="rounded-md border border-border px-4 py-3">
        <ToggleField
          label="Enable smart model routing"
          hint="Automatically use cheaper models for routine tasks and more capable models for complex work"
          checked={enabled}
          onChange={handleToggle}
        />
      </div>
    </div>
  );
}

/* ── Talent Pool Section ── */

function TalentPoolSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [formTitle, setFormTitle] = useState("");
  const [formRole, setFormRole] = useState<string>("engineer");
  const [formDepartment, setFormDepartment] = useState<string>("engineering");
  const [formEmploymentType, setFormEmploymentType] = useState<string>("full_time");
  const [formDescription, setFormDescription] = useState("");

  const templatesQuery = useQuery({
    queryKey: queryKeys.roleTemplates.list(companyId),
    queryFn: () => roleTemplatesApi.list(companyId),
    enabled: !!companyId,
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      roleTemplatesApi.create(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.roleTemplates.list(companyId) });
      pushToast({ title: "Template created", tone: "success" });
      resetForm();
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to create template", body: err.message, tone: "error" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      roleTemplatesApi.update(companyId, id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.roleTemplates.list(companyId) });
      pushToast({ title: "Template updated", tone: "success" });
      resetForm();
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to update template", body: err.message, tone: "error" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => roleTemplatesApi.remove(companyId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.roleTemplates.list(companyId) });
      pushToast({ title: "Template deleted", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to delete template", body: err.message, tone: "error" });
    },
  });

  function resetForm() {
    setShowForm(false);
    setEditingId(null);
    setFormTitle("");
    setFormRole("engineer");
    setFormDepartment("engineering");
    setFormEmploymentType("full_time");
    setFormDescription("");
  }

  function startEdit(t: RoleTemplate) {
    setEditingId(t.id);
    setFormTitle(t.title);
    setFormRole(t.role);
    setFormDepartment(t.department ?? "engineering");
    setFormEmploymentType(t.employmentType);
    setFormDescription(t.description ?? "");
    setShowForm(true);
  }

  function handleSave() {
    const data: Record<string, unknown> = {
      title: formTitle.trim(),
      role: formRole,
      department: formDepartment,
      employmentType: formEmploymentType,
      description: formDescription.trim() || null,
    };
    if (editingId) {
      updateMutation.mutate({ id: editingId, data });
    } else {
      createMutation.mutate(data);
    }
  }

  const templates = templatesQuery.data ?? [];
  const isSystemTemplate = (t: RoleTemplate) => t.key.startsWith("system:");
  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
          <Users className="h-3.5 w-3.5" />
          Talent Pool
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            resetForm();
            setShowForm(true);
          }}
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Create Template
        </Button>
      </div>

      {showForm && (
        <div className="rounded-md border border-border px-4 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {editingId ? "Edit Template" : "New Template"}
            </span>
            <button
              className="text-muted-foreground hover:text-foreground transition-colors"
              onClick={resetForm}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="space-y-2">
            <Field label="Title">
              <input
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="e.g. Senior Engineer"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              />
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Role">
                <select
                  value={formRole}
                  onChange={(e) => setFormRole(e.target.value)}
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                >
                  {AGENT_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {(AGENT_ROLE_LABELS as Record<string, string>)[r] ?? r}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Department">
                <select
                  value={formDepartment}
                  onChange={(e) => setFormDepartment(e.target.value)}
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                >
                  {DEPARTMENTS.map((d) => (
                    <option key={d} value={d}>
                      {(DEPARTMENT_LABELS as Record<string, string>)[d] ?? d}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Type">
                <select
                  value={formEmploymentType}
                  onChange={(e) => setFormEmploymentType(e.target.value)}
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                >
                  {EMPLOYMENT_TYPES.map((et) => (
                    <option key={et} value={et}>
                      {(EMPLOYMENT_TYPE_LABELS as Record<string, string>)[et] ?? et}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Description">
              <input
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Optional description"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!formTitle.trim() || isSaving}
            >
              {isSaving ? "Saving..." : editingId ? "Update" : "Create"}
            </Button>
            <Button size="sm" variant="ghost" onClick={resetForm}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {templates.length === 0 && !showForm && (
        <div className="rounded-md border border-border px-4 py-6 text-center">
          <p className="text-xs text-muted-foreground">
            No role templates yet. Create one to speed up hiring.
          </p>
        </div>
      )}

      {templates.length > 0 && (
        <div className="space-y-2">
          {templates.map((t) => (
            <div
              key={t.id}
              className="rounded-md border border-border px-4 py-3 flex items-center justify-between"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{t.title}</span>
                  {isSystemTemplate(t) && (
                    <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">System</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-muted-foreground">
                    {(AGENT_ROLE_LABELS as Record<string, string>)[t.role] ?? t.role}
                  </span>
                  {t.department && (
                    <>
                      <span className="text-border">|</span>
                      <span className="text-xs text-muted-foreground">
                        {(DEPARTMENT_LABELS as Record<string, string>)[t.department] ?? t.department}
                      </span>
                    </>
                  )}
                  <span className="text-border">|</span>
                  <span className="text-xs text-muted-foreground">
                    {(EMPLOYMENT_TYPE_LABELS as Record<string, string>)[t.employmentType] ?? t.employmentType}
                  </span>
                </div>
                {t.description && (
                  <p className="text-xs text-muted-foreground/70 mt-0.5">{t.description}</p>
                )}
              </div>
              {!isSystemTemplate(t) && (
                <div className="flex items-center gap-1 shrink-0 ml-3">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => startEdit(t)}
                    title="Edit template"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-destructive"
                    onClick={() => {
                      if (window.confirm(`Delete template "${t.title}"?`)) {
                        deleteMutation.mutate(t.id);
                      }
                    }}
                    title="Delete template"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Department Templates Section ── */

interface DeptTemplate {
  key: string;
  name: string;
  description: string;
  roles: Array<{ title: string; role: string; icon: string }>;
}

const DEPT_TEMPLATES: DeptTemplate[] = [
  {
    key: "engineering",
    name: "Engineering",
    description: "Core technical team: a CTO to lead, plus a senior engineer and DevOps agent.",
    roles: [
      { title: "CTO", role: "cto", icon: "cpu" },
      { title: "Senior Engineer", role: "engineer", icon: "code" },
      { title: "DevOps Engineer", role: "devops", icon: "server" },
    ],
  },
  {
    key: "marketing",
    name: "Marketing",
    description: "Brand and growth team: a CMO plus a content and analyst agent.",
    roles: [
      { title: "CMO", role: "cmo", icon: "megaphone" },
      { title: "Content Marketer", role: "specialist", icon: "pen-line" },
      { title: "Marketing Analyst", role: "analyst", icon: "target" },
    ],
  },
  {
    key: "finance",
    name: "Finance",
    description: "Financial operations: a CFO and a finance analyst to track spend and reporting.",
    roles: [
      { title: "CFO", role: "cfo", icon: "dollar-sign" },
      { title: "Finance Analyst", role: "analyst", icon: "scale" },
    ],
  },
  {
    key: "legal",
    name: "Legal",
    description: "Compliance and legal: a compliance director and legal counsel.",
    roles: [
      { title: "Compliance Director", role: "director", icon: "gavel" },
      { title: "Legal Counsel", role: "specialist", icon: "scale" },
    ],
  },
  {
    key: "support",
    name: "Support",
    description: "Customer-facing support: a support manager and two specialist agents.",
    roles: [
      { title: "Support Manager", role: "manager", icon: "users" },
      { title: "Support Specialist", role: "specialist", icon: "message-square" },
    ],
  },
];

/* ── Risk Thresholds Section ── */

function RiskThresholdsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const { data: settings } = useQuery({
    queryKey: ["risk-settings", companyId],
    queryFn: () => executiveApi.getRiskSettings(companyId),
    enabled: !!companyId,
  });

  const [spendDollars, setSpendDollars] = useState("");
  const [perfThreshold, setPerfThreshold] = useState("");
  const [resolveHours, setResolveHours] = useState("");

  useEffect(() => {
    if (!settings) return;
    setSpendDollars(String((settings.spendingAlertThresholdCents / 100).toFixed(0)));
    setPerfThreshold(String(settings.performanceAlertThreshold));
    setResolveHours(String(settings.autoResolveTimeoutHours));
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: () =>
      executiveApi.updateRiskSettings(companyId, {
        spendingAlertThresholdCents: Math.round(parseFloat(spendDollars) * 100),
        performanceAlertThreshold: parseInt(perfThreshold, 10),
        autoResolveTimeoutHours: parseInt(resolveHours, 10),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["risk-settings", companyId] });
      pushToast({ title: "Risk thresholds saved", tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to save risk thresholds", tone: "error" });
    },
  });

  return (
    <div className="space-y-4">
      <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5" />
        Risk Thresholds
      </h2>
      <div className="rounded-md border border-border px-4 py-4 space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Spending alert threshold (per run)</label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <input
              type="number"
              inputMode="decimal"
              min={1}
              step={1}
              value={spendDollars}
              onChange={(e) => setSpendDollars(e.target.value)}
              className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            />
          </div>
          <p className="text-xs text-muted-foreground">Alert fires when a single agent run exceeds this amount.</p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Performance alert threshold</label>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            value={perfThreshold}
            onChange={(e) => setPerfThreshold(e.target.value)}
            className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          />
          <p className="text-xs text-muted-foreground">Agents scoring below this threshold trigger a medium alert.</p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Auto-resolve timeout (hours)</label>
          <input
            type="number"
            inputMode="decimal"
            min={1}
            value={resolveHours}
            onChange={(e) => setResolveHours(e.target.value)}
            className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          />
          <p className="text-xs text-muted-foreground">Low-severity alerts are auto-resolved after this many hours.</p>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? "Saving..." : "Save thresholds"}
          </button>
          {saveMutation.isSuccess && (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <Check className="h-3 w-3" />
              Saved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function DepartmentTemplatesSection({ companyId }: { companyId: string }) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [deployingKey, setDeployingKey] = useState<string | null>(null);

  const hireMutation = useMutation({
    mutationFn: async (template: DeptTemplate) => {
      const results: unknown[] = [];
      for (const r of template.roles) {
        const result = await agentsApi.hire(companyId, {
          name: r.title,
          role: r.role,
          icon: r.icon,
          employmentType: "full_time",
          department: template.key,
        });
        results.push(result);
      }
      return results;
    },
    onSuccess: (_, template) => {
      setDeployingKey(null);
      pushToast({
        title: `${template.name} department created`,
        body: `${template.roles.length} agents hired`,
        tone: "success",
      });
      queryClient.invalidateQueries({ queryKey: ["agents", companyId] });
    },
    onError: (err: Error, template) => {
      setDeployingKey(null);
      pushToast({
        title: `Failed to create ${template.name} department`,
        body: err.message,
        tone: "error",
      });
    },
  });

  return (
    <div className="space-y-4">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
        <Building2 className="h-3.5 w-3.5" />
        Department Templates
      </div>
      <p className="text-sm text-muted-foreground">
        Quickly create a pre-configured set of agents for a department. Each template hires the suggested roles via the standard hiring workflow.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {DEPT_TEMPLATES.map((template) => (
          <div
            key={template.key}
            className="rounded-md border border-border px-4 py-3 space-y-2"
          >
            <div>
              <p className="text-sm font-medium">{template.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{template.description}</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {template.roles.map((r) => (
                <span
                  key={r.role + r.title}
                  className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground"
                >
                  {r.title}
                </span>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={hireMutation.isPending && deployingKey === template.key}
              onClick={() => {
                setDeployingKey(template.key);
                hireMutation.mutate(template);
              }}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              {hireMutation.isPending && deployingKey === template.key
                ? "Creating..."
                : "Create Department"}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildAgentSnippet(input: AgentSnippetInput) {
  const candidateUrls = buildCandidateOnboardingUrls(input);
  const resolutionTestUrl = buildResolutionTestUrl(input);

  const candidateList =
    candidateUrls.length > 0
      ? candidateUrls.map((u) => `- ${u}`).join("\n")
      : "- (No candidate URLs available yet.)";

  const connectivityBlock =
    candidateUrls.length === 0
      ? `No candidate URLs are available. Ask your user to configure a reachable hostname in Ironworks, then retry.
Suggested steps:
- choose a hostname that resolves to the Ironworks host from your runtime
- run: pnpm ironworksai allowed-hostname <host>
- restart Ironworks
- verify with: curl -fsS http://<host>:3100/api/health
- regenerate this invite snippet`
      : `If none are reachable, ask your user to add a reachable hostname in Ironworks, restart, and retry.
Suggested command:
- pnpm ironworksai allowed-hostname <host>
Then verify with: curl -fsS <base-url>/api/health`;

  const resolutionLine = resolutionTestUrl
    ? `\nYou MUST test Ironworks-to-gateway reachability, call: ${resolutionTestUrl}?url=<urlencoded-gateway-url> (using the hostname that worked above). Do not assume your 172.x is necessarily reachable from Ironworks. Test it. `
    : "";

  return `You're invited to join a Ironworks organization.

The URLs you should try are:
${candidateList}

Connectivity guidance:
If you are running on a different machine than Ironworks, Ironworks must be reachable at one of the hostnames used above.
Verify the hostname works from your runtime with: GET <base-url>/api/health

${connectivityBlock}

For your "agentName", just use your own agent name (OpenClaw or whatever your name is) and send it directly.
You also need to send a gateway URL that Ironworks can access. Check your config and include that URL.${resolutionLine}

---

This onboarding flow is for OpenClaw Gateway.
When you submit the join request, use:
- \`adapterType: "openclaw_gateway"\`
- \`agentDefaultsPayload.url\` as your \`ws://\` or \`wss://\` gateway URL
- \`agentDefaultsPayload.headers["x-openclaw-token"]\` with your gateway token
- (legacy accepted) \`agentDefaultsPayload.headers["x-openclaw-auth"]\`
- Keep device auth enabled (recommended). If \`devicePrivateKeyPem\` is omitted, Ironworks will generate and persist one during join so pairing approvals remain stable.
- Only use \`disableDeviceAuth=true\` for special environments where pairing cannot be completed.

Do NOT use \`/v1/responses\` or \`/hooks/*\` in this join flow.

Before you do anything, please respond to your user that you understand the instructions and you're going to work on them. Then do the step above in another session called "ironworks-onboarding" and then tell your user when you're done. Update your user in intermediate steps along the way so they know what's going on.

Then after you've connected to Ironworks (exchanged keys etc.) you MUST review and follow the onboarding instructions in onboarding.txt they give you.

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
