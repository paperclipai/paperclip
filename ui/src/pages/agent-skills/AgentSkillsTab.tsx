import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, ChevronDown, Loader2, Search, Store, X } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "../../api/agents";
import { companySkillsApi } from "../../api/companySkills";
import { queryKeys } from "../../lib/queryKeys";
import { resolveSkillSummaryText } from "../../lib/company-skill-summary";
import { adapterLabels } from "../../components/agent-config-primitives";
import { cn } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { PageSkeleton } from "../../components/PageSkeleton";
import {
  applyAgentSkillSnapshot,
  isReadOnlyUnmanagedSkillEntry,
  sameSkillSelection,
  shouldScheduleSkillAutosave,
} from "../../lib/agent-skills-state";
import { AgentSkillRow, type AgentSkillRowData } from "./AgentSkillRow";
import { filterAgentSkills } from "./agent-skill-filter";
import { buildAgentSkillSourceMeta } from "./agent-skill-source";

const MATERIALIZATION_NOTE =
  "Enabled skills are materialized into the stable Paperclip-managed prompt bundle on the agent's next run.";

export function AgentSkillsTab({ agent, companyId }: { agent: Agent; companyId?: string }) {
  const queryClient = useQueryClient();
  const [skillDraft, setSkillDraft] = useState<string[]>([]);
  const [lastSavedSkills, setLastSavedSkills] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [detectedOpen, setDetectedOpen] = useState(false);
  const lastSavedSkillsRef = useRef<string[]>([]);
  const hasHydratedSkillSnapshotRef = useRef(false);
  const skipNextSkillAutosaveRef = useRef(true);
  // The exact draft of a save that failed, so we don't re-fire the identical
  // payload on every `isPending` flip (that was an infinite 422 retry storm).
  const failedSkillDraftRef = useRef<string[] | null>(null);

  const { data: skillSnapshot, isLoading } = useQuery({
    queryKey: queryKeys.agents.skills(agent.id),
    queryFn: () => agentsApi.skills(agent.id, companyId),
    enabled: Boolean(companyId),
  });

  const { data: companySkills } = useQuery({
    queryKey: queryKeys.companySkills.list(companyId ?? ""),
    queryFn: () => companySkillsApi.list(companyId!),
    enabled: Boolean(companyId),
  });

  const syncSkills = useMutation({
    mutationFn: (desiredSkills: string[]) => agentsApi.syncSkills(agent.id, desiredSkills, companyId),
    onSuccess: async (snapshot) => {
      queryClient.setQueryData(queryKeys.agents.skills(agent.id), snapshot);
      lastSavedSkillsRef.current = snapshot.desiredSkills;
      setLastSavedSkills(snapshot.desiredSkills);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) }),
      ]);
    },
    onError: (_error, attemptedDesiredSkills) => {
      // Remember the payload that failed so the autosave effect stops retrying
      // it until the user edits the draft again.
      failedSkillDraftRef.current = attemptedDesiredSkills;
    },
  });

  useEffect(() => {
    setSkillDraft([]);
    setLastSavedSkills([]);
    lastSavedSkillsRef.current = [];
    hasHydratedSkillSnapshotRef.current = false;
    skipNextSkillAutosaveRef.current = true;
    failedSkillDraftRef.current = null;
  }, [agent.id]);

  useEffect(() => {
    if (!skillSnapshot) return;
    const nextState = applyAgentSkillSnapshot(
      {
        draft: skillDraft,
        lastSaved: lastSavedSkillsRef.current,
        hasHydratedSnapshot: hasHydratedSkillSnapshotRef.current,
      },
      skillSnapshot.desiredSkills,
    );
    skipNextSkillAutosaveRef.current = nextState.shouldSkipAutosave;
    hasHydratedSkillSnapshotRef.current = nextState.hasHydratedSnapshot;
    setSkillDraft(nextState.draft);
    lastSavedSkillsRef.current = nextState.lastSaved;
    setLastSavedSkills(nextState.lastSaved);
  }, [skillDraft, skillSnapshot]);

  useEffect(() => {
    if (!skillSnapshot) return;
    if (skipNextSkillAutosaveRef.current) {
      skipNextSkillAutosaveRef.current = false;
      return;
    }
    if (syncSkills.isPending) return;
    if (
      !shouldScheduleSkillAutosave({
        draft: skillDraft,
        lastSaved: lastSavedSkillsRef.current,
        failedDraft: failedSkillDraftRef.current,
      })
    ) {
      return;
    }

    const timeout = window.setTimeout(() => {
      if (
        shouldScheduleSkillAutosave({
          draft: skillDraft,
          lastSaved: lastSavedSkillsRef.current,
          failedDraft: failedSkillDraftRef.current,
        })
      ) {
        syncSkills.mutate(skillDraft);
      }
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [skillDraft, skillSnapshot, syncSkills.isPending, syncSkills.isError, syncSkills.mutate]);

  const companySkillByKey = useMemo(
    () => new Map((companySkills ?? []).map((skill) => [skill.key, skill])),
    [companySkills],
  );
  const companySkillKeys = useMemo(
    () => new Set((companySkills ?? []).map((skill) => skill.key)),
    [companySkills],
  );
  const adapterEntryByKey = useMemo(
    () => new Map((skillSnapshot?.entries ?? []).map((entry) => [entry.key, entry])),
    [skillSnapshot],
  );

  const unsupported = skillSnapshot?.mode === "unsupported";

  // Library skills → row models (the store's visual language, tuned for rows).
  const libraryRows = useMemo<AgentSkillRowData[]>(
    () =>
      (companySkills ?? []).map((skill) => ({
        key: skill.key,
        name: skill.name,
        icon: {
          key: skill.key,
          name: skill.name,
          slug: skill.slug,
          iconUrl: skill.iconUrl,
          color: skill.color,
        },
        summary: resolveSkillSummaryText(skill, { fallbackKey: true }),
        chip: skill.categories[0] ?? null,
        sourceMeta: buildAgentSkillSourceMeta(skill),
        linkTo: `/skills/${skill.id}`,
        // search haystack (mirrors the store's discoveryMatchesSearch fields)
        slug: skill.slug,
        author: skill.authorName ?? skill.sourceLabel,
        tagline: skill.tagline,
        description: skill.description,
        categories: skill.categories,
      })),
    [companySkills],
  );

  // Adapter-detected, user-installed / unmanaged skills → read-only rows.
  const detectedRows = useMemo<AgentSkillRowData[]>(
    () =>
      (skillSnapshot?.entries ?? [])
        .filter((entry) => isReadOnlyUnmanagedSkillEntry(entry, companySkillKeys))
        .map((entry) => ({
          key: entry.key,
          name: entry.runtimeName ?? entry.key,
          icon: { key: entry.key, name: entry.runtimeName ?? entry.key, slug: null, iconUrl: null, color: null },
          summary: entry.detail ?? null,
          chip: null,
          linkTo: null,
          originLabel: entry.originLabel ?? null,
          locationLabel: entry.locationLabel ?? null,
        })),
    [companySkillKeys, skillSnapshot],
  );

  const enabledRows = useMemo(
    () => libraryRows.filter((row) => skillDraft.includes(row.key)),
    [libraryRows, skillDraft],
  );
  const availableRows = useMemo(
    () => libraryRows.filter((row) => !skillDraft.includes(row.key)),
    [libraryRows, skillDraft],
  );

  // Desired keys that no longer exist in the library → actionable warnings.
  const staleDesiredKeys = useMemo(
    () => skillDraft.filter((key) => !companySkillByKey.has(key)),
    [companySkillByKey, skillDraft],
  );

  const filteredEnabled = useMemo(() => filterAgentSkills(enabledRows, search), [enabledRows, search]);
  const filteredAvailable = useMemo(() => filterAgentSkills(availableRows, search), [availableRows, search]);
  const filteredDetected = useMemo(() => filterAgentSkills(detectedRows, search), [detectedRows, search]);

  const applicationLabel = useMemo(() => {
    switch (skillSnapshot?.mode) {
      case "persistent":
        return "Kept in workspace";
      case "ephemeral":
        return "Applied on next run";
      case "unsupported":
        return "Tracked only";
      default:
        return null;
    }
  }, [skillSnapshot?.mode]);

  const unsupportedMessage = useMemo(() => {
    if (!unsupported) return null;
    if (
      agent.adapterType === "acpx_local" &&
      typeof agent.adapterConfig.agent === "string" &&
      agent.adapterConfig.agent === "custom"
    ) {
      return "Paperclip cannot manage skills for custom ACP commands yet.";
    }
    if (agent.adapterType === "openclaw_gateway") {
      return "Paperclip cannot manage OpenClaw skills here. Visit your OpenClaw instance to manage this agent's skills.";
    }
    return "Paperclip cannot manage skills for this adapter yet. Manage them in the adapter directly.";
  }, [agent.adapterConfig.agent, agent.adapterType, unsupported]);

  const hasUnsavedChanges = !sameSkillSelection(skillDraft, lastSavedSkills);

  const toggleSkill = (key: string, next: boolean) => {
    setSkillDraft((current) =>
      next
        ? Array.from(new Set([...current, key]))
        : current.filter((value) => value !== key),
    );
  };

  const renderRow = (row: AgentSkillRowData, variant: "enabled" | "available") => (
    <AgentSkillRow
      key={row.key}
      variant={variant}
      data={row}
      checked={variant === "enabled"}
      disabled={unsupported}
      disabledReason={unsupportedMessage}
      onCheckedChange={(next) => toggleSkill(row.key, next)}
    />
  );

  const libraryEmpty = libraryRows.length === 0;

  return (
    <div className="max-w-4xl space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {enabledRows.length} of {libraryRows.length} enabled
          </span>
          {applicationLabel ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex cursor-default items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                  {applicationLabel}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                {unsupported ? unsupportedMessage : MATERIALIZATION_NOTE}
              </TooltipContent>
            </Tooltip>
          ) : null}
          <SaveStatusChip
            pending={syncSkills.isPending}
            unsaved={hasUnsavedChanges}
            error={syncSkills.isError && hasUnsavedChanges}
          />
          <div className="ml-auto flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
            <div className="relative w-full sm:w-auto">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search skills"
                className="h-8 w-full pl-8 sm:w-56"
                aria-label="Search skills"
              />
            </div>
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link to="/skills" className="no-underline">
                <Store className="h-3.5 w-3.5" />
                Browse skills store
              </Link>
            </Button>
          </div>
        </div>

        {syncSkills.isError ? (
          <p className="text-xs text-destructive">
            {syncSkills.error instanceof Error ? syncSkills.error.message : "Failed to update skills"}
          </p>
        ) : null}
      </div>

      {/* Unsupported adapter banner */}
      {unsupportedMessage ? (
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          {unsupportedMessage}
        </div>
      ) : null}

      {/* Stale desired-skill warnings — one compact, removable row per key */}
      {staleDesiredKeys.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-amber-300/60 dark:border-amber-500/30">
          {staleDesiredKeys.map((key) => (
            <div
              key={key}
              className="flex items-center justify-between gap-3 border-b border-amber-300/40 bg-amber-50/60 px-3 py-2 text-xs text-amber-800 last:border-b-0 dark:border-amber-500/20 dark:bg-amber-950/20 dark:text-amber-200"
            >
              <span className="min-w-0 truncate">
                <span className="font-medium">{key}</span> is enabled but missing from the company library.
              </span>
              <button
                type="button"
                onClick={() => toggleSkill(key, false)}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-400/50 px-2 py-0.5 font-medium transition-colors hover:bg-amber-100/60 dark:hover:bg-amber-900/30"
              >
                <X className="h-3 w-3" />
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : libraryEmpty && detectedRows.length === 0 ? (
        <EmptyLibraryCard />
      ) : (
        <div className="space-y-4">
          <SkillSection title="Enabled on this agent" count={filteredEnabled.length}>
            {filteredEnabled.length > 0 ? (
              filteredEnabled.map((row) => renderRow(row, "enabled"))
            ) : (
              <SectionEmpty>
                {search ? "No enabled skills match your search." : "No skills enabled on this agent yet."}
              </SectionEmpty>
            )}
          </SkillSection>

          <SkillSection title="Available from the library" count={filteredAvailable.length}>
            {filteredAvailable.length > 0 ? (
              filteredAvailable.map((row) => renderRow(row, "available"))
            ) : (
              <SectionEmpty>
                {search
                  ? "No available skills match your search."
                  : libraryEmpty
                    ? "Import skills into the company library to enable them here."
                    : "Every library skill is enabled on this agent."}
              </SectionEmpty>
            )}
          </SkillSection>

          {detectedRows.length > 0 ? (
            <Collapsible open={detectedOpen} onOpenChange={setDetectedOpen}>
              <div className="overflow-hidden rounded-lg border border-border">
                <CollapsibleTrigger className="flex w-full items-center gap-2 bg-muted/50 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 text-muted-foreground transition-transform",
                      detectedOpen ? "" : "-rotate-90",
                    )}
                  />
                  <span className="text-xs font-medium text-muted-foreground">
                    Detected on adapter (read-only)
                  </span>
                  <span className="text-xs text-muted-foreground/70">{filteredDetected.length}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {filteredDetected.length > 0 ? (
                    filteredDetected.map((row) => (
                      <AgentSkillRow key={row.key} variant="readonly" data={row} />
                    ))
                  ) : (
                    <SectionEmpty>No detected skills match your search.</SectionEmpty>
                  )}
                </CollapsibleContent>
              </div>
            </Collapsible>
          ) : null}

          <div className="text-xs text-muted-foreground">
            Adapter: {adapterLabels[agent.adapterType] ?? agent.adapterType}
          </div>
        </div>
      )}
    </div>
  );
}

function SaveStatusChip({
  pending,
  unsaved,
  error,
}: {
  pending: boolean;
  unsaved: boolean;
  error: boolean;
}) {
  if (pending) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Saving…
      </span>
    );
  }
  if (error) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
        <AlertCircle className="h-3.5 w-3.5" />
        Couldn’t save
      </span>
    );
  }
  if (unsaved) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Saving soon…
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-(--status-task-done)">
      <CheckCircle2 className="h-3.5 w-3.5" />
      Saved
    </span>
  );
}

function SkillSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 bg-muted/50 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <span className="text-xs text-muted-foreground/70">{count}</span>
      </div>
      <div>{children}</div>
    </section>
  );
}

function SectionEmpty({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-4 text-xs text-muted-foreground">{children}</div>;
}

function EmptyLibraryCard() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <Store className="h-8 w-8 text-muted-foreground/60" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">No skills in the company library</p>
        <p className="text-xs text-muted-foreground">
          Install skills to the company, then enable them on this agent.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link to="/skills" className="no-underline">
          <Store className="h-3.5 w-3.5" />
          Browse skills store
        </Link>
      </Button>
    </div>
  );
}
