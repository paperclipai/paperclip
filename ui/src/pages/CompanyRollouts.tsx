import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Company,
  CompanyPortabilityExportPreviewResult,
  CompanyRolloutPreviewResult,
  CompanyRolloutRelease,
} from "@paperclipai/shared";
import { AlertTriangle, CheckCircle2, Eye, Package, Rocket, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { companiesApi } from "../api/companies";
import { companyRolloutsApi } from "../api/companyRollouts";
import { EmptyState } from "../components/EmptyState";
import { PackageFileTree, buildFileTree, collectAllPaths, countFiles, type FileTreeNode } from "../components/PackageFileTree";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

function ensureMarkdownPath(path: string) {
  return path.endsWith(".md") ? path : `${path}.md`;
}

function defaultRolloutFiles(exportPreview: CompanyPortabilityExportPreviewResult) {
  const selected = new Set(Object.keys(exportPreview.files));
  for (const issue of exportPreview.manifest.issues) {
    if (issue.recurring) continue;
    selected.delete(ensureMarkdownPath(issue.path));
  }
  return selected;
}

function statusTone(status: string) {
  if (status === "applied") return "text-emerald-500 border-emerald-500/30";
  if (status === "failed") return "text-destructive border-destructive/30";
  return "text-blue-500 border-blue-500/30";
}

function countSummary(counts: CompanyRolloutPreviewResult["targets"][number]["counts"]) {
  return [
    ["Create", counts.create],
    ["Update", counts.update],
    ["No change", counts.skipNoChange],
    ["Conflict", counts.skipUnmanagedConflict],
    ["Error", counts.error],
  ] as const;
}

function selectableTargetCompanies(companies: Company[], sourceCompanyId: string | null) {
  return companies.filter((company) => company.id !== sourceCompanyId && company.status !== "archived");
}

export function CompanyRollouts() {
  const { selectedCompanyId, selectedCompany, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const [targetCompanyIds, setTargetCompanyIds] = useState<Set<string>>(new Set());
  const [rolloutPreview, setRolloutPreview] = useState<CompanyRolloutPreviewResult | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings/data" },
      { label: "Rollouts" },
    ]);
  }, [setBreadcrumbs]);

  const exportPreviewQuery = useQuery({
    queryKey: selectedCompanyId ? ["company-rollout-export-preview", selectedCompanyId] : ["company-rollout-export-preview", "none"],
    queryFn: () =>
      companiesApi.exportPreview(selectedCompanyId!, {
        include: { company: true, agents: true, projects: true, issues: true, skills: true },
      }),
    enabled: Boolean(selectedCompanyId),
  });

  const releasesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.companyRollouts.list(selectedCompanyId) : ["company-rollouts", "none"],
    queryFn: () => companyRolloutsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const targetCompanies = useMemo(
    () => selectableTargetCompanies(companies, selectedCompanyId),
    [companies, selectedCompanyId],
  );

  useEffect(() => {
    if (!exportPreviewQuery.data) return;
    const defaults = defaultRolloutFiles(exportPreviewQuery.data);
    setCheckedFiles(defaults);
    const tree = buildFileTree(exportPreviewQuery.data.files);
    const topDirs = new Set<string>();
    for (const node of tree) {
      if (node.kind === "dir") topDirs.add(node.path);
    }
    setExpandedDirs(topDirs);
    setSelectedFile(Object.keys(exportPreviewQuery.data.files)[0] ?? null);
  }, [exportPreviewQuery.data]);

  useEffect(() => {
    const activeTargets = targetCompanies
      .filter((company) => company.status === "active")
      .map((company) => company.id);
    setTargetCompanyIds(new Set(activeTargets));
  }, [targetCompanies]);

  useEffect(() => {
    if (releasesQuery.data?.[0] && !selectedReleaseId) {
      setSelectedReleaseId(releasesQuery.data[0].id);
    }
  }, [releasesQuery.data, selectedReleaseId]);

  const createReleaseMutation = useMutation({
    mutationFn: () => {
      if (!selectedCompanyId) throw new Error("Select a source company first.");
      return companyRolloutsApi.create(selectedCompanyId, {
        title: title.trim() || `${selectedCompany?.name ?? "Company"} rollout`,
        notes: notes.trim() || null,
        selectedFiles: Array.from(checkedFiles).sort(),
      });
    },
    onSuccess: async (release) => {
      setSelectedReleaseId(release.id);
      setRolloutPreview(null);
      setTitle("");
      setNotes("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.companyRollouts.list(selectedCompanyId!) });
      pushToast({
        tone: "success",
        title: "Release created",
        body: `Version ${release.version} is ready to preview.`,
      });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Release failed",
        body: err instanceof Error ? err.message : "Could not create rollout release.",
      });
    },
  });

  const previewMutation = useMutation({
    mutationFn: () => {
      if (!selectedReleaseId) throw new Error("Choose a release first.");
      return companyRolloutsApi.preview(selectedReleaseId, {
        targetCompanyIds: Array.from(targetCompanyIds),
      });
    },
    onSuccess: (result) => setRolloutPreview(result),
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Preview failed",
        body: err instanceof Error ? err.message : "Could not preview rollout.",
      });
    },
  });

  const applyMutation = useMutation({
    mutationFn: () => {
      if (!selectedReleaseId) throw new Error("Choose a release first.");
      return companyRolloutsApi.apply(selectedReleaseId, {
        targetCompanyIds: Array.from(targetCompanyIds),
      });
    },
    onSuccess: async (result) => {
      setRolloutPreview(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companies.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companyRollouts.list(selectedCompanyId!) }),
      ]);
      for (const companyId of targetCompanyIds) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(companyId) }),
        ]);
      }
      pushToast({
        tone: "success",
        title: "Rollout applied",
        body: `${result.targets.filter((target) => target.applied).length} company${result.targets.length === 1 ? "" : "ies"} updated.`,
      });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Apply failed",
        body: err instanceof Error ? err.message : "Could not apply rollout.",
      });
    },
  });

  const releaseOptions = releasesQuery.data ?? [];
  const selectedRelease = releaseOptions.find((release) => release.id === selectedReleaseId) ?? null;
  const exportTree = useMemo(
    () => (exportPreviewQuery.data ? buildFileTree(exportPreviewQuery.data.files) : []),
    [exportPreviewQuery.data],
  );
  const totalFiles = useMemo(() => countFiles(exportTree), [exportTree]);
  const hasPreviewErrors = Boolean(rolloutPreview?.targets.some((target) => target.errors.length > 0));
  const canPreview = Boolean(selectedReleaseId && targetCompanyIds.size > 0);
  const canApply = Boolean(rolloutPreview && !hasPreviewErrors && targetCompanyIds.size > 0);

  function handleToggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function handleToggleCheck(path: string, kind: "file" | "dir") {
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      if (kind === "file") {
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }
      const findNode = (nodes: FileTreeNode[], target: string): FileTreeNode | null => {
        for (const node of nodes) {
          if (node.path === target) return node;
          const found = findNode(node.children, target);
          if (found) return found;
        }
        return null;
      };
      const node = findNode(exportTree, path);
      if (!node) return next;
      const childFiles = collectAllPaths(node.children, "file");
      for (const child of node.children) {
        if (child.kind === "file") childFiles.add(child.path);
      }
      const allChecked = [...childFiles].every((filePath) => next.has(filePath));
      for (const filePath of childFiles) {
        if (allChecked) next.delete(filePath);
        else next.add(filePath);
      }
      return next;
    });
  }

  function toggleTarget(companyId: string) {
    setTargetCompanyIds((prev) => {
      const next = new Set(prev);
      if (next.has(companyId)) next.delete(companyId);
      else next.add(companyId);
      return next;
    });
    setRolloutPreview(null);
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Package} message="Select a company to create a rollout." />;
  }

  return (
    <div className="space-y-5 px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Company Rollouts</h1>
          <p className="mt-1 text-sm text-muted-foreground">{selectedCompany?.name ?? "Source company"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!canPreview || previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            <Eye className="h-3.5 w-3.5" />
            {previewMutation.isPending ? "Previewing..." : "Preview"}
          </Button>
          <Button
            size="sm"
            disabled={!canApply || applyMutation.isPending}
            onClick={() => applyMutation.mutate()}
          >
            <Send className="h-3.5 w-3.5" />
            {applyMutation.isPending ? "Applying..." : "Apply"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)]">
        <section className="rounded-md border border-border">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Create Release</h2>
              <p className="text-xs text-muted-foreground">Agents, skills, projects, routines</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={createReleaseMutation.isPending || checkedFiles.size === 0}
              onClick={() => createReleaseMutation.mutate()}
            >
              <Rocket className="h-3.5 w-3.5" />
              {createReleaseMutation.isPending ? "Creating..." : "Create release"}
            </Button>
          </div>
          <div className="grid gap-0 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <div className="border-r border-border">
              <div className="space-y-3 border-b border-border p-3">
                <input
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  placeholder={`${selectedCompany?.name ?? "Company"} rollout`}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <textarea
                  className="min-h-20 w-full resize-y rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  placeholder="Release notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
                <div className="text-xs text-muted-foreground">
                  {checkedFiles.size} / {totalFiles} files selected
                </div>
              </div>
              <div className="max-h-[34rem] overflow-y-auto">
                {exportPreviewQuery.isLoading ? (
                  <div className="p-4 text-sm text-muted-foreground">Loading package...</div>
                ) : exportPreviewQuery.error ? (
                  <div className="p-4 text-sm text-destructive">Failed to load package preview.</div>
                ) : (
                  <PackageFileTree
                    nodes={exportTree}
                    selectedFile={selectedFile}
                    expandedDirs={expandedDirs}
                    checkedFiles={checkedFiles}
                    onToggleDir={handleToggleDir}
                    onSelectFile={setSelectedFile}
                    onToggleCheck={handleToggleCheck}
                  />
                )}
              </div>
            </div>
            <div className="space-y-4 p-4">
              <div>
                <h2 className="text-sm font-semibold">Release</h2>
                <select
                  className="mt-2 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  value={selectedReleaseId ?? ""}
                  onChange={(event) => {
                    setSelectedReleaseId(event.target.value || null);
                    setRolloutPreview(null);
                  }}
                >
                  <option value="">Select a release</option>
                  {releaseOptions.map((release: CompanyRolloutRelease) => (
                    <option key={release.id} value={release.id}>
                      v{release.version} - {release.title}
                    </option>
                  ))}
                </select>
                {selectedRelease && (
                  <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                    <div className="rounded-md border border-border p-2">{selectedRelease.counts.agents} agents</div>
                    <div className="rounded-md border border-border p-2">{selectedRelease.counts.projects} projects</div>
                    <div className="rounded-md border border-border p-2">{selectedRelease.counts.routines} routines</div>
                  </div>
                )}
              </div>

              <div>
                <h2 className="text-sm font-semibold">Targets</h2>
                <div className="mt-2 divide-y divide-border rounded-md border border-border">
                  {targetCompanies.length === 0 ? (
                    <div className="p-3 text-sm text-muted-foreground">No active target companies.</div>
                  ) : targetCompanies.map((company) => (
                    <label key={company.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={targetCompanyIds.has(company.id)}
                        onChange={() => toggleTarget(company.id)}
                      />
                      <span className="min-w-0 flex-1 truncate">{company.name}</span>
                      <span className={cn(
                        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide",
                        company.status === "active" ? "text-emerald-500 border-emerald-500/30" : "text-amber-500 border-amber-500/30",
                      )}>
                        {company.status}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-md border border-border">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Preview</h2>
            <p className="text-xs text-muted-foreground">Per-company actions</p>
          </div>
          {!rolloutPreview ? (
            <EmptyState icon={Eye} message="No preview yet." />
          ) : (
            <div className="divide-y divide-border">
              {rolloutPreview.targets.map((target) => (
                <div key={target.companyId} className="space-y-3 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{target.companyName}</span>
                    <span className={cn("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide", statusTone(target.status))}>
                      {target.status}
                    </span>
                  </div>
                  <div className="grid grid-cols-5 gap-1">
                    {countSummary(target.counts).map(([label, value]) => (
                      <div key={label} className="rounded-md border border-border px-2 py-1">
                        <div className="text-xs font-semibold tabular-nums">{value}</div>
                        <div className="truncate text-[10px] text-muted-foreground">{label}</div>
                      </div>
                    ))}
                  </div>
                  {target.errors.length > 0 && (
                    <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                      {target.errors.map((error) => (
                        <div key={error} className="flex gap-2 text-xs text-destructive">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          <span>{error}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {target.status === "applied" && (
                    <div className="flex gap-2 text-xs text-emerald-500">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Applied successfully.
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
