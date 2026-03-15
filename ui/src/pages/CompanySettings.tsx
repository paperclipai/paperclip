import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityExportResult,
  CompanyPortabilityPreviewRequest,
  CompanyPortabilityPreviewResult,
  CompanyPortabilitySource,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { companiesApi } from "../api/companies";
import { accessApi } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Settings, Check, Download, Github, Link2, Upload } from "lucide-react";
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
  const packageInputRef = useRef<HTMLInputElement | null>(null);

  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
  }, [selectedCompany]);

  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSnippet, setInviteSnippet] = useState<string | null>(null);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [snippetCopyDelightId, setSnippetCopyDelightId] = useState(0);
  const [packageIncludeCompany, setPackageIncludeCompany] = useState(true);
  const [packageIncludeAgents, setPackageIncludeAgents] = useState(true);
  const [importSourceMode, setImportSourceMode] = useState<"github" | "url" | "local">("github");
  const [importUrl, setImportUrl] = useState("");
  const [importTargetMode, setImportTargetMode] = useState<"existing" | "new">("existing");
  const [newCompanyName, setNewCompanyName] = useState("");
  const [collisionStrategy, setCollisionStrategy] = useState<CompanyPortabilityCollisionStrategy>("rename");
  const [localPackage, setLocalPackage] = useState<{
    rootPath: string | null;
    files: Record<string, string>;
  } | null>(null);
  const [importPreview, setImportPreview] = useState<CompanyPortabilityPreviewResult | null>(null);

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? ""));

  const packageInclude = useMemo(
    () => ({
      company: packageIncludeCompany,
      agents: packageIncludeAgents,
      projects: false,
      issues: false
    }),
    [packageIncludeAgents, packageIncludeCompany]
  );

  const importSource = useMemo<CompanyPortabilitySource | null>(() => {
    if (importSourceMode === "local") {
      if (!localPackage || Object.keys(localPackage.files).length === 0) return null;
      return {
        type: "inline",
        rootPath: localPackage.rootPath,
        files: localPackage.files
      };
    }
    const trimmed = importUrl.trim();
    if (!trimmed) return null;
    return importSourceMode === "github"
      ? { type: "github", url: trimmed }
      : { type: "url", url: trimmed };
  }, [importSourceMode, importUrl, localPackage]);

  const importPayload = useMemo<CompanyPortabilityPreviewRequest | null>(() => {
    if (!importSource) return null;
    return {
      source: importSource,
      include: packageInclude,
      target:
        importTargetMode === "new"
          ? {
              mode: "new_company",
              newCompanyName: newCompanyName.trim() || null
            }
          : {
              mode: "existing_company",
              companyId: selectedCompanyId!
            },
      agents: "all",
      collisionStrategy
    };
  }, [
    collisionStrategy,
    importSource,
    importTargetMode,
    newCompanyName,
    packageInclude,
    selectedCompanyId
  ]);

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

  const exportMutation = useMutation({
    mutationFn: () =>
      companiesApi.exportBundle(selectedCompanyId!, {
        include: packageInclude
      }),
    onSuccess: async (exported) => {
      await downloadCompanyPackage(exported);
      pushToast({
        tone: "success",
        title: "Company package exported",
        body: `${exported.rootPath}.tar downloaded with ${Object.keys(exported.files).length} file${Object.keys(exported.files).length === 1 ? "" : "s"}.`
      });
      if (exported.warnings.length > 0) {
        pushToast({
          tone: "warn",
          title: "Export completed with warnings",
          body: exported.warnings[0]
        });
      }
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Export failed",
        body: err instanceof Error ? err.message : "Failed to export company package"
      });
    }
  });

  const previewImportMutation = useMutation({
    mutationFn: (payload: CompanyPortabilityPreviewRequest) =>
      companiesApi.importPreview(payload),
    onSuccess: (preview) => {
      setImportPreview(preview);
      if (preview.errors.length > 0) {
        pushToast({
          tone: "warn",
          title: "Import preview found issues",
          body: preview.errors[0]
        });
        return;
      }
      pushToast({
        tone: "success",
        title: "Import preview ready",
        body: `${preview.plan.agentPlans.length} agent action${preview.plan.agentPlans.length === 1 ? "" : "s"} planned.`
      });
    },
    onError: (err) => {
      setImportPreview(null);
      pushToast({
        tone: "error",
        title: "Import preview failed",
        body: err instanceof Error ? err.message : "Failed to preview company package"
      });
    }
  });

  const importPackageMutation = useMutation({
    mutationFn: (payload: CompanyPortabilityPreviewRequest) =>
      companiesApi.importBundle(payload),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companies.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(result.company.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.org(result.company.id) })
      ]);
      if (importTargetMode === "new") {
        setSelectedCompanyId(result.company.id);
      }
      pushToast({
        tone: "success",
        title: "Company package imported",
        body: `${result.agents.filter((agent) => agent.action !== "skipped").length} agent${result.agents.filter((agent) => agent.action !== "skipped").length === 1 ? "" : "s"} applied.`
      });
      if (result.warnings.length > 0) {
        pushToast({
          tone: "warn",
          title: "Import completed with warnings",
          body: result.warnings[0]
        });
      }
      setImportPreview(null);
      setLocalPackage(null);
      setImportUrl("");
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Import failed",
        body: err instanceof Error ? err.message : "Failed to import company package"
      });
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

  useEffect(() => {
    setInviteError(null);
    setInviteSnippet(null);
    setSnippetCopied(false);
    setSnippetCopyDelightId(0);
  }, [selectedCompanyId]);

  useEffect(() => {
    setImportPreview(null);
  }, [
    collisionStrategy,
    importSourceMode,
    importTargetMode,
    importUrl,
    localPackage,
    newCompanyName,
    packageIncludeAgents,
    packageIncludeCompany,
    selectedCompanyId
  ]);

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

  async function handleChooseLocalPackage(
    event: ChangeEvent<HTMLInputElement>
  ) {
    const selection = event.target.files;
    if (!selection || selection.length === 0) {
      setLocalPackage(null);
      return;
    }
    try {
      const parsed = await readLocalPackageSelection(selection);
      setLocalPackage(parsed);
      pushToast({
        tone: "success",
        title: "Local package loaded",
        body: `${Object.keys(parsed.files).length} package file${Object.keys(parsed.files).length === 1 ? "" : "s"} ready for preview.`
      });
    } catch (err) {
      setLocalPackage(null);
      pushToast({
        tone: "error",
        title: "Failed to read local package",
        body: err instanceof Error ? err.message : "Could not read selected files"
      });
    } finally {
      event.target.value = "";
    }
  }

  function handlePreviewImport() {
    if (!importPayload) {
      pushToast({
        tone: "warn",
        title: "Source required",
        body:
          importSourceMode === "local"
            ? "Choose a local folder with COMPANY.md before previewing."
            : "Enter a company package URL before previewing."
      });
      return;
    }
    previewImportMutation.mutate(importPayload);
  }

  function handleApplyImport() {
    if (!importPayload) {
      pushToast({
        tone: "warn",
        title: "Source required",
        body:
          importSourceMode === "local"
            ? "Choose a local folder with COMPANY.md before importing."
            : "Enter a company package URL before importing."
      });
      return;
    }
    importPackageMutation.mutate(importPayload);
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
                brandColor={brandColor || null}
                className="rounded-[14px]"
              />
            </div>
            <div className="flex-1 space-y-2">
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
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Hiring
        </div>
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
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Invites
        </div>
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
            <p className="text-sm text-destructive">{inviteError}</p>
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

      {/* Import / Export */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Company Packages
        </div>

        <div className="space-y-4 rounded-md border border-border px-4 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="text-sm font-medium">Export markdown package</div>
              <p className="text-xs text-muted-foreground">
                Download a markdown-first company package as a single tar file.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => exportMutation.mutate()}
              disabled={
                exportMutation.isPending ||
                (!packageIncludeCompany && !packageIncludeAgents)
              }
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              {exportMutation.isPending ? "Exporting..." : "Export package"}
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={packageIncludeCompany}
                onChange={(e) => setPackageIncludeCompany(e.target.checked)}
              />
              Include company metadata
            </label>
            <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={packageIncludeAgents}
                onChange={(e) => setPackageIncludeAgents(e.target.checked)}
              />
              Include agents
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Export always includes `.paperclip.yaml` as a Paperclip sidecar while keeping the markdown package readable and shareable.
          </p>

          {exportMutation.data && (
            <div className="rounded-md border border-border bg-muted/20 p-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Last export
              </div>
              <div className="mt-2 text-sm">
                {exportMutation.data.rootPath}.tar with{" "}
                {Object.keys(exportMutation.data.files).length} file
                {Object.keys(exportMutation.data.files).length === 1 ? "" : "s"}. Includes{" "}
                <span className="font-mono">{exportMutation.data.paperclipExtensionPath}</span>.
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                {Object.keys(exportMutation.data.files).map((filePath) => (
                  <span
                    key={filePath}
                    className="rounded-full border border-border px-2 py-0.5"
                  >
                    {filePath}
                  </span>
                ))}
              </div>
              {exportMutation.data.warnings.length > 0 && (
                <div className="mt-3 space-y-1 text-xs text-amber-700">
                  {exportMutation.data.warnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4 rounded-md border border-border px-4 py-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">Import company package</div>
            <p className="text-xs text-muted-foreground">
              Preview a GitHub repo, direct COMPANY.md URL, or local folder before applying it.
            </p>
          </div>

          <div className="grid gap-2 md:grid-cols-3">
            <button
              type="button"
              className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                importSourceMode === "github"
                  ? "border-foreground bg-accent"
                  : "border-border hover:bg-accent/50"
              }`}
              onClick={() => setImportSourceMode("github")}
            >
              <div className="flex items-center gap-2">
                <Github className="h-4 w-4" />
                GitHub repo
              </div>
            </button>
            <button
              type="button"
              className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                importSourceMode === "url"
                  ? "border-foreground bg-accent"
                  : "border-border hover:bg-accent/50"
              }`}
              onClick={() => setImportSourceMode("url")}
            >
              <div className="flex items-center gap-2">
                <Link2 className="h-4 w-4" />
                Direct URL
              </div>
            </button>
            <button
              type="button"
              className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                importSourceMode === "local"
                  ? "border-foreground bg-accent"
                  : "border-border hover:bg-accent/50"
              }`}
              onClick={() => setImportSourceMode("local")}
            >
              <div className="flex items-center gap-2">
                <Upload className="h-4 w-4" />
                Local folder
              </div>
            </button>
          </div>

          {importSourceMode === "local" ? (
            <div className="rounded-md border border-dashed border-border px-3 py-3">
              <input
                ref={packageInputRef}
                type="file"
                multiple
                className="hidden"
                // @ts-expect-error webkitdirectory is supported by Chromium-based browsers
                webkitdirectory=""
                onChange={handleChooseLocalPackage}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => packageInputRef.current?.click()}
                >
                  Choose folder
                </Button>
                {localPackage && (
                  <span className="text-xs text-muted-foreground">
                    {localPackage.rootPath ?? "package"} with{" "}
                    {Object.keys(localPackage.files).length} package file
                    {Object.keys(localPackage.files).length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              {!localPackage && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Select a folder that contains COMPANY.md and any referenced
                  AGENTS.md files.
                </p>
              )}
            </div>
          ) : (
            <Field
              label={importSourceMode === "github" ? "GitHub URL" : "Package URL"}
              hint={
                importSourceMode === "github"
                  ? "Repo root, tree path, or blob URL to COMPANY.md. Unpinned refs warn but do not block."
                  : "Point directly at COMPANY.md or a directory that contains it."
              }
            >
              <input
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                type="text"
                value={importUrl}
                placeholder={
                  importSourceMode === "github"
                    ? "https://github.com/owner/repo/tree/main/company"
                    : "https://example.com/company/COMPANY.md"
                }
                onChange={(e) => setImportUrl(e.target.value)}
              />
            </Field>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label="Target"
              hint="Import into this company or create a new one from the package."
            >
              <select
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                value={importTargetMode}
                onChange={(e) =>
                  setImportTargetMode(e.target.value as "existing" | "new")
                }
              >
                <option value="existing">
                  Existing company: {selectedCompany.name}
                </option>
                <option value="new">Create new company</option>
              </select>
            </Field>
            <Field
              label="Collision strategy"
              hint="Controls what happens when imported agent slugs already exist."
            >
              <select
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                value={collisionStrategy}
                onChange={(e) =>
                  setCollisionStrategy(
                    e.target.value as CompanyPortabilityCollisionStrategy
                  )
                }
              >
                <option value="rename">Rename imported agents</option>
                <option value="skip">Skip existing agents</option>
                <option value="replace">Replace existing agents</option>
              </select>
            </Field>
          </div>

          {importTargetMode === "new" && (
            <Field
              label="New company name"
              hint="Optional override. Leave blank to use the package name."
            >
              <input
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                type="text"
                value={newCompanyName}
                onChange={(e) => setNewCompanyName(e.target.value)}
                placeholder="Imported Company"
              />
            </Field>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handlePreviewImport}
              disabled={
                previewImportMutation.isPending ||
                (!packageIncludeCompany && !packageIncludeAgents)
              }
            >
              {previewImportMutation.isPending ? "Previewing..." : "Preview import"}
            </Button>
            <Button
              size="sm"
              onClick={handleApplyImport}
              disabled={
                importPackageMutation.isPending ||
                previewImportMutation.isPending ||
                !!(importPreview && importPreview.errors.length > 0) ||
                (!packageIncludeCompany && !packageIncludeAgents)
              }
            >
              {importPackageMutation.isPending ? "Importing..." : "Apply import"}
            </Button>
          </div>

          {importPreview && (
            <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-md border border-border bg-background/70 px-3 py-2">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Company action
                  </div>
                  <div className="mt-1 text-sm font-medium">
                    {importPreview.plan.companyAction}
                  </div>
                </div>
                <div className="rounded-md border border-border bg-background/70 px-3 py-2">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Agent actions
                  </div>
                  <div className="mt-1 text-sm font-medium">
                    {importPreview.plan.agentPlans.length}
                  </div>
                </div>
                <div className="rounded-md border border-border bg-background/70 px-3 py-2">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Project actions
                  </div>
                  <div className="mt-1 text-sm font-medium">
                    {importPreview.plan.projectPlans.length}
                  </div>
                </div>
                <div className="rounded-md border border-border bg-background/70 px-3 py-2">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Task actions
                  </div>
                  <div className="mt-1 text-sm font-medium">
                    {importPreview.plan.issuePlans.length}
                  </div>
                </div>
              </div>

              {importPreview.plan.agentPlans.length > 0 && (
                <div className="space-y-2">
                  {importPreview.plan.agentPlans.map((agentPlan) => (
                    <div
                      key={agentPlan.slug}
                      className="rounded-md border border-border bg-background/70 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="font-medium">
                          {agentPlan.slug} {"->"} {agentPlan.plannedName}
                        </span>
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
                          {agentPlan.action}
                        </span>
                      </div>
                      {agentPlan.reason && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {agentPlan.reason}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {importPreview.plan.projectPlans.length > 0 && (
                <div className="space-y-2">
                  {importPreview.plan.projectPlans.map((projectPlan) => (
                    <div
                      key={projectPlan.slug}
                      className="rounded-md border border-border bg-background/70 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="font-medium">
                          {projectPlan.slug} {"->"} {projectPlan.plannedName}
                        </span>
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
                          {projectPlan.action}
                        </span>
                      </div>
                      {projectPlan.reason && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {projectPlan.reason}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {importPreview.plan.issuePlans.length > 0 && (
                <div className="space-y-2">
                  {importPreview.plan.issuePlans.map((issuePlan) => (
                    <div
                      key={issuePlan.slug}
                      className="rounded-md border border-border bg-background/70 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="font-medium">
                          {issuePlan.slug} {"->"} {issuePlan.plannedTitle}
                        </span>
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
                          {issuePlan.action}
                        </span>
                      </div>
                      {issuePlan.reason && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {issuePlan.reason}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {importPreview.envInputs.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Environment inputs
                  </div>
                  {importPreview.envInputs.map((inputValue) => (
                    <div
                      key={`${inputValue.agentSlug ?? "company"}:${inputValue.key}`}
                      className="text-xs text-muted-foreground"
                    >
                      {inputValue.key}
                      {inputValue.agentSlug ? ` for ${inputValue.agentSlug}` : ""}
                      {` · ${inputValue.kind}`}
                      {` · ${inputValue.requirement}`}
                      {inputValue.defaultValue !== null ? ` · default ${JSON.stringify(inputValue.defaultValue)}` : ""}
                      {inputValue.portability === "system_dependent" ? " · system-dependent" : ""}
                    </div>
                  ))}
                </div>
              )}

              {importPreview.warnings.length > 0 && (
                <div className="space-y-1 rounded-md border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-700">
                  {importPreview.warnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                </div>
              )}

              {importPreview.errors.length > 0 && (
                <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {importPreview.errors.map((error) => (
                    <div key={error}>{error}</div>
                  ))}
                </div>
              )}
            </div>
          )}
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

async function readLocalPackageSelection(fileList: FileList): Promise<{
  rootPath: string | null;
  files: Record<string, string>;
}> {
  const files: Record<string, string> = {};
  let rootPath: string | null = null;

  for (const file of Array.from(fileList)) {
    const relativePath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath?.replace(
        /\\/g,
        "/"
      ) || file.name;
    const isMarkdown = relativePath.endsWith(".md");
    const isPaperclipYaml =
      relativePath.endsWith(".paperclip.yaml") ||
      relativePath.endsWith(".paperclip.yml");
    if (!isMarkdown && !isPaperclipYaml) continue;
    const topLevel = relativePath.split("/")[0] ?? null;
    if (!rootPath && topLevel) rootPath = topLevel;
    files[relativePath] = await file.text();
  }

  if (Object.keys(files).length === 0) {
    throw new Error("No package files were found in the selected folder.");
  }

  return { rootPath, files };
}

async function downloadCompanyPackage(
  exported: CompanyPortabilityExportResult
): Promise<void> {
  const tarBytes = createTarArchive(exported.files, exported.rootPath);
  const tarBuffer = new ArrayBuffer(tarBytes.byteLength);
  new Uint8Array(tarBuffer).set(tarBytes);
  const blob = new Blob(
    [tarBuffer],
    {
      type: "application/x-tar"
    }
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${exported.rootPath}.tar`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createTarArchive(
  files: Record<string, string>,
  rootPath: string
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [relativePath, contents] of Object.entries(files)) {
    const tarPath = `${rootPath}/${relativePath}`.replace(/\\/g, "/");
    const body = encoder.encode(contents);
    chunks.push(buildTarHeader(tarPath, body.length));
    chunks.push(body);
    const remainder = body.length % 512;
    if (remainder > 0) {
      chunks.push(new Uint8Array(512 - remainder));
    }
  }

  chunks.push(new Uint8Array(1024));

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const archive = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return archive;
}

function buildTarHeader(pathname: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeTarString(header, 0, 100, pathname);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  for (let i = 148; i < 156; i += 1) {
    header[i] = 32;
  }
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarChecksum(header, checksum);
  return header;
}

function writeTarString(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string
) {
  const encoded = new TextEncoder().encode(value);
  target.set(encoded.slice(0, length), offset);
}

function writeTarOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number
) {
  const stringValue = value.toString(8).padStart(length - 1, "0");
  writeTarString(target, offset, length - 1, stringValue);
  target[offset + length - 1] = 0;
}

function writeTarChecksum(target: Uint8Array, checksum: number) {
  const stringValue = checksum.toString(8).padStart(6, "0");
  writeTarString(target, 148, 6, stringValue);
  target[154] = 0;
  target[155] = 32;
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
      ? `No candidate URLs are available. Ask your user to configure a reachable hostname in Paperclip, then retry.
Suggested steps:
- choose a hostname that resolves to the Paperclip host from your runtime
- run: pnpm paperclipai allowed-hostname <host>
- restart Paperclip
- verify with: curl -fsS http://<host>:3100/api/health
- regenerate this invite snippet`
      : `If none are reachable, ask your user to add a reachable hostname in Paperclip, restart, and retry.
Suggested command:
- pnpm paperclipai allowed-hostname <host>
Then verify with: curl -fsS <base-url>/api/health`;

  const resolutionLine = resolutionTestUrl
    ? `\nYou MUST test Paperclip-to-gateway reachability, call: ${resolutionTestUrl}?url=<urlencoded-gateway-url> (using the hostname that worked above). Do not assume your 172.x is necessarily reachable from Paperclip. Test it. `
    : "";

  return `You're invited to join a Paperclip organization.

The URLs you should try are:
${candidateList}

Connectivity guidance:
If you are running on a different machine than Paperclip, Paperclip must be reachable at one of the hostnames used above.
Verify the hostname works from your runtime with: GET <base-url>/api/health

${connectivityBlock}

For your "agentName", just use your own agent name (OpenClaw or whatever your name is) and send it directly.
You also need to send a gateway URL that Paperclip can access. Check your config and include that URL.${resolutionLine}

---

This onboarding flow is for OpenClaw Gateway.
When you submit the join request, use:
- \`adapterType: "openclaw_gateway"\`
- \`agentDefaultsPayload.url\` as your \`ws://\` or \`wss://\` gateway URL
- \`agentDefaultsPayload.headers["x-openclaw-token"]\` with your gateway token
- (legacy accepted) \`agentDefaultsPayload.headers["x-openclaw-auth"]\`
- Keep device auth enabled (recommended). If \`devicePrivateKeyPem\` is omitted, Paperclip will generate and persist one during join so pairing approvals remain stable.
- Only use \`disableDeviceAuth=true\` for special environments where pairing cannot be completed.

Do NOT use \`/v1/responses\` or \`/hooks/*\` in this join flow.

Before you do anything, please respond to your user that you understand the instructions and you're going to work on them. Then do the step above in another session called "paperclip-onboarding" and then tell your user when you're done. Update your user in intermediate steps along the way so they know what's going on.

Then after you've connected to Paperclip (exchanged keys etc.) you MUST review and follow the onboarding instructions in onboarding.txt they give you.

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
