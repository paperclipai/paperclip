import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanySkillDetail,
  CompanySkillListItem,
  CompanySkillTrustLevel,
} from "@paperclipai/shared";
import { companySkillsApi } from "../api/companySkills";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { PageSkeleton } from "../components/PageSkeleton";
import { EntityRow } from "../components/EntityRow";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowUpRight,
  BookOpen,
  Boxes,
  FolderInput,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";

function stripFrontmatter(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return normalized.trim();
  return normalized.slice(closing + 5).trim();
}

function trustTone(trustLevel: CompanySkillTrustLevel) {
  switch (trustLevel) {
    case "markdown_only":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "assets":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "scripts_executables":
      return "bg-red-500/10 text-red-700 dark:text-red-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function trustLabel(trustLevel: CompanySkillTrustLevel) {
  switch (trustLevel) {
    case "markdown_only":
      return "Markdown only";
    case "assets":
      return "Assets";
    case "scripts_executables":
      return "Scripts";
    default:
      return trustLevel;
  }
}

function compatibilityLabel(detail: CompanySkillDetail | CompanySkillListItem) {
  switch (detail.compatibility) {
    case "compatible":
      return "Compatible";
    case "unknown":
      return "Unknown";
    case "invalid":
      return "Invalid";
    default:
      return detail.compatibility;
  }
}

function SkillListItem({
  skill,
  selected,
}: {
  skill: CompanySkillListItem;
  selected: boolean;
}) {
  return (
    <Link
      to={`/skills/${skill.id}`}
      className={cn(
        "block rounded-xl border p-3 no-underline transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-border/70 bg-card hover:border-border hover:bg-accent/20",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-foreground">{skill.name}</span>
            <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {skill.slug}
            </span>
          </div>
          {skill.description && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {skill.description}
            </p>
          )}
        </div>
        <span className={cn("shrink-0 rounded-full px-2 py-1 text-[10px] font-medium", trustTone(skill.trustLevel))}>
          {trustLabel(skill.trustLevel)}
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span>{skill.attachedAgentCount} agent{skill.attachedAgentCount === 1 ? "" : "s"}</span>
        <span>{skill.fileInventory.length} file{skill.fileInventory.length === 1 ? "" : "s"}</span>
      </div>
    </Link>
  );
}

function SkillDetailPanel({
  detail,
  isLoading,
}: {
  detail: CompanySkillDetail | null | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (!detail) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card/40 p-8">
        <div className="max-w-md space-y-3">
          <div className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
            <BookOpen className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Select a skill</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Review its markdown, inspect files, and see which agents have it attached.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const markdownBody = stripFrontmatter(detail.markdown);

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border bg-[linear-gradient(135deg,rgba(24,24,27,0.02),rgba(24,24,27,0.06))] px-5 py-4 dark:bg-[linear-gradient(135deg,rgba(255,255,255,0.03),rgba(255,255,255,0.06))]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold">{detail.name}</h2>
                <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {detail.slug}
                </span>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", trustTone(detail.trustLevel))}>
                  {trustLabel(detail.trustLevel)}
                </span>
              </div>
              {detail.description && (
                <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{detail.description}</p>
              )}
            </div>
            <div className="grid shrink-0 gap-1 text-right text-[11px] text-muted-foreground">
              <span>{compatibilityLabel(detail)}</span>
              <span>{detail.attachedAgentCount} attached agent{detail.attachedAgentCount === 1 ? "" : "s"}</span>
            </div>
          </div>
        </div>

        <div className="grid gap-5 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">SKILL.md</h3>
              {detail.sourceLocator && (
                <a
                  href={detail.sourceLocator}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  Open source
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            <div className="rounded-xl border border-border/70 bg-background px-4 py-4">
              <MarkdownBody>{markdownBody}</MarkdownBody>
            </div>
          </div>

          <div className="space-y-4">
            <section className="rounded-xl border border-border/70 bg-background px-4 py-4">
              <h3 className="text-sm font-medium">Inventory</h3>
              <div className="mt-3 space-y-2">
                {detail.fileInventory.map((entry) => (
                  <div key={`${entry.kind}:${entry.path}`} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate font-mono text-muted-foreground">{entry.path}</span>
                    <span className="rounded-full border border-border/70 px-2 py-0.5 uppercase tracking-wide text-[10px] text-muted-foreground">
                      {entry.kind}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-border/70 bg-background px-4 py-4">
              <h3 className="text-sm font-medium">Used By Agents</h3>
              {detail.usedByAgents.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No agents are currently attached to this skill.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {detail.usedByAgents.map((agent) => (
                    <EntityRow
                      key={agent.id}
                      title={agent.name}
                      subtitle={agent.adapterType}
                      to={`/agents/${agent.urlKey}/skills`}
                      trailing={agent.actualState ? (
                        <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {agent.actualState}
                        </span>
                      ) : undefined}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}

export function CompanySkills() {
  const { skillId } = useParams<{ skillId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [source, setSource] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: "Skills", href: "/skills" },
      ...(skillId ? [{ label: "Detail" }] : []),
    ]);
  }, [setBreadcrumbs, skillId]);

  const {
    data: skills,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const selectedSkillId = useMemo(() => {
    if (!skillId) return skills?.[0]?.id ?? null;
    return skillId;
  }, [skillId, skills]);

  const {
    data: detail,
    isLoading: detailLoading,
  } = useQuery({
    queryKey: queryKeys.companySkills.detail(selectedCompanyId ?? "", selectedSkillId ?? ""),
    queryFn: () => companySkillsApi.detail(selectedCompanyId!, selectedSkillId!),
    enabled: Boolean(selectedCompanyId && selectedSkillId),
  });

  const importSkill = useMutation({
    mutationFn: (importSource: string) => companySkillsApi.importFromSource(selectedCompanyId!, importSource),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      if (result.imported[0]) {
        navigate(`/skills/${result.imported[0].id}`);
      }
      pushToast({
        tone: "success",
        title: "Skills imported",
        body: `${result.imported.length} skill${result.imported.length === 1 ? "" : "s"} added to the company library.`,
      });
      if (result.warnings[0]) {
        pushToast({
          tone: "warn",
          title: "Import warnings",
          body: result.warnings[0],
        });
      }
      setSource("");
    },
    onError: (importError) => {
      pushToast({
        tone: "error",
        title: "Skill import failed",
        body: importError instanceof Error ? importError.message : "Failed to import skill source.",
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Boxes} message="Select a company to manage skills." />;
  }

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.10),transparent_38%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.10),transparent_40%)] px-5 py-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                <Boxes className="h-3.5 w-3.5" />
                Company skill library
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">Manage reusable skills once, attach them anywhere.</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Import `SKILL.md` packages from local paths, GitHub repos, or direct URLs. Agents attach by skill shortname, while adapters decide how those skills are installed or mounted.
              </p>
            </div>
            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
              <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-3">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  Markdown-first
                </div>
                <p className="mt-1">`skills.sh` compatible packages stay readable and repo-native.</p>
              </div>
              <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-3">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <FolderInput className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                  GitHub aware
                </div>
                <p className="mt-1">Import a repo, a subtree, or a single skill file without a registry.</p>
              </div>
              <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-3">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                  Trust surfaced
                </div>
                <p className="mt-1">Scripts and executable bundles stay visible instead of being hidden in setup.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-border px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="flex-1">
              <Input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder="Local path, GitHub repo/tree/blob URL, or direct SKILL.md URL"
                className="h-10"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId) })}
                disabled={isLoading}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Refresh
              </Button>
              <Button
                size="sm"
                onClick={() => importSkill.mutate(source.trim())}
                disabled={importSkill.isPending || source.trim().length === 0}
              >
                {importSkill.isPending ? "Importing..." : "Import skill"}
              </Button>
            </div>
          </div>
        </div>
      </section>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && (skills?.length ?? 0) === 0 ? (
        <EmptyState
          icon={TerminalSquare}
          message="No company skills yet."
          action="Import your first skill"
          onAction={() => {
            const trimmed = source.trim();
            if (trimmed) importSkill.mutate(trimmed);
          }}
        />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[22rem_minmax(0,1fr)]">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-medium">Library</h2>
                <p className="text-xs text-muted-foreground">
                  {skills?.length ?? 0} tracked skill{(skills?.length ?? 0) === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            {isLoading ? (
              <PageSkeleton variant="list" />
            ) : (
              <div className="space-y-2">
                {(skills ?? []).map((skill) => (
                  <SkillListItem
                    key={skill.id}
                    skill={skill}
                    selected={skill.id === selectedSkillId}
                  />
                ))}
              </div>
            )}
          </section>

          <SkillDetailPanel detail={detail} isLoading={detailLoading} />
        </div>
      )}
    </div>
  );
}
