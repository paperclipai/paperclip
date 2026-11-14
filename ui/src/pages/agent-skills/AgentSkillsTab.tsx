import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, ChevronDown, Loader2, Search, Store, X } from "lucide-react";
import type { Agent, AgentDesiredSkillEntry } from "@paperclipai/shared";
import { agentsApi } from "../../api/agents";
import { describeError } from "../../api/errors";
import { companySkillsApi } from "../../api/companySkills";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { queryKeys } from "../../lib/queryKeys";
import { resolveSkillSummaryText } from "../../lib/company-skill-summary";
import { adapterLabels } from "../../components/agent-config-primitives";
import { cn } from "../../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { QueryErrorState } from "../../components/QueryView";
import { PageSkeleton } from "../../components/PageSkeleton";
import {
  agentSkillLibrarySelection,
  sameSkillLibrarySelection,
  type AgentSkillLibrarySelection,
  isReadOnlyUnmanagedSkillEntry,
} from "../../lib/agent-skills-state";
import { AgentSkillRow, type AgentSkillRowData } from "./AgentSkillRow";
import { filterAgentSkills } from "./agent-skill-filter";
import { buildAgentSkillSourceMeta } from "./agent-skill-source";
import { AgentSkillReleasePicker, releaseShortLabel } from "./AgentSkillReleasePicker";

const MATERIALIZATION_NOTE =
  "Enabled skills are materialized into the stable Paperclip-managed prompt bundle on the agent's next run.";

/** Company skill key of the Paperclip core skill that carries beta releases. */
const PAPERCLIP_CORE_SKILL_KEY = "paperclipai/paperclip/paperclip";

/** Build the desired-skill sync payload, carrying any active version pins. */
export function toDesiredSkillPayload(
  keys: string[],
  pins: Record<string, string>,
  versionPinsEnabled = true,
): Array<string | AgentDesiredSkillEntry> {
  return keys.map((key) => (
    versionPinsEnabled && pins[key] ? { key, versionId: pins[key]! } : key
  ));
}

/** Reduce desired entries to a key → versionId map for non-default pins only. */
function pinsFromEntries(entries: AgentDesiredSkillEntry[] | undefined): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const entry of entries ?? []) {
    if (entry.versionId) pins[entry.key] = entry.versionId;
  }
  return pins;
}

export function AgentSkillsTab(props: { agent: Agent; companyId?: string }) {
  // A new agent owns a new draft, debounce, search, and mutation lifecycle.
  return <AgentSkillsEditor key={props.agent.id} {...props} />;
}

function AgentSkillsEditor({ agent, companyId }: { agent: Agent; companyId?: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AgentSkillLibrarySelection>({ enabled: [], installed: [] });
  const [lastSaved, setLastSaved] = useState<AgentSkillLibrarySelection>(draft);
  const lastSavedRef = useRef(lastSaved);
  const skillDraft = draft.enabled;
  // key → pinned versionId; absence means the live default (no pin).
  const [versionPins, setVersionPins] = useState<Record<string, string>>({});
  const versionPinsRef = useRef<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [detectedOpen, setDetectedOpen] = useState(false);
  const hasHydratedSkillSnapshotRef = useRef(false);
  // The exact draft of a save that failed, so we don't re-fire the identical
  // payload on every `isPending` flip (that was an infinite 422 retry storm).
  const failedSkillDraftRef = useRef<AgentSkillLibrarySelection | null>(null);

  const { data: skillSnapshot, isLoading, error: skillError, refetch: retrySkills } = useQuery({
    queryKey: queryKeys.agents.skills(agent.id),
    queryFn: () => agentsApi.skills(agent.id, companyId),
    enabled: Boolean(companyId),
  });

  const { data: companySkills, isLoading: libraryLoading, error: libraryError, refetch: retryLibrary } = useQuery({
    queryKey: queryKeys.companySkills.list(companyId ?? ""),
    queryFn: () => companySkillsApi.list(companyId!),
    enabled: Boolean(companyId),
  });

  // Beta skills experimental flag — gates the per-agent release picker entirely.
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const betaSkillsEnabled = experimentalSettings?.enableBetaSkills === true;

  const paperclipCoreSkill = useMemo(
    () => (companySkills ?? []).find((skill) => skill.key === PAPERCLIP_CORE_SKILL_KEY) ?? null,
    [companySkills],
  );

  // Seeded releases (release_id IS NOT NULL) for the paperclip core skill. Only
  // fetched when the flag is on and the skill is present in the library.
  const { data: paperclipVersions } = useQuery({
    queryKey: queryKeys.companySkills.versions(companyId ?? "", paperclipCoreSkill?.id ?? ""),
    queryFn: () => companySkillsApi.versions(companyId!, paperclipCoreSkill!.id),
    enabled: Boolean(companyId && betaSkillsEnabled && paperclipCoreSkill?.id),
  });
  const paperclipReleases = useMemo(
    () => (paperclipVersions ?? []).filter((version) => version.releaseId != null),
    [paperclipVersions],
  );

  const syncSkills = useMutation({
    mutationFn: ({ selection, pins }: { selection: AgentSkillLibrarySelection; pins: Record<string, string> }) =>
      agentsApi.syncSkills(agent.id, toDesiredSkillPayload(selection.enabled, pins, betaSkillsEnabled),
        "replace", companyId, selection.installed),
    onSuccess: async (snapshot, { selection }) => {
      const saved = agentSkillLibrarySelection(snapshot);
      setDraft((current) => sameSkillLibrarySelection(current, selection) ? saved : current);
      lastSavedRef.current = saved;
      setLastSaved(saved);
      queryClient.setQueryData(queryKeys.agents.skills(agent.id), snapshot);
      const nextPins = pinsFromEntries(snapshot.desiredSkillEntries);
      versionPinsRef.current = nextPins;
      setVersionPins(nextPins);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) }),
      ]);
    },
    onError: (_error, { selection }) => {
      failedSkillDraftRef.current = selection;
    },
  });

  useEffect(() => {
    if (!skillSnapshot || syncSkills.isPending) return;
    const nextPins = pinsFromEntries(skillSnapshot.desiredSkillEntries);
    versionPinsRef.current = nextPins;
    setVersionPins(nextPins);
  }, [skillSnapshot, syncSkills.isPending]);

  useEffect(() => {
    if (!skillSnapshot) return;
    const saved = agentSkillLibrarySelection(skillSnapshot);
    const previousSaved = lastSavedRef.current;
    const firstSnapshot = !hasHydratedSkillSnapshotRef.current;
    setDraft((current) => firstSnapshot || sameSkillLibrarySelection(current, previousSaved) ? saved : current);
    hasHydratedSkillSnapshotRef.current = true;
    lastSavedRef.current = saved;
    setLastSaved(saved);
  }, [skillSnapshot]);

  useEffect(() => {
    if (!skillSnapshot || !hasHydratedSkillSnapshotRef.current || syncSkills.isPending) return;
    if (sameSkillLibrarySelection(draft, lastSaved)
      || (failedSkillDraftRef.current && sameSkillLibrarySelection(draft, failedSkillDraftRef.current))) return;
    const timeout = window.setTimeout(() => {
      syncSkills.mutate({ selection: draft, pins: versionPinsRef.current });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [draft, lastSaved, skillSnapshot, syncSkills.isPending, syncSkills.mutate]);

  const companySkillByKey = useMemo(
    () => new Map((companySkills ?? []).map((skill) => [skill.key, skill])),
    [companySkills],
  );
  const companySkillKeys = useMemo(
    () => new Set((companySkills ?? []).map((skill) => skill.key)),
    [companySkills],
  );
  const readOnlySkillKeys = useMemo(
    () => new Set((skillSnapshot?.entries ?? []).filter((entry) => entry.readOnly).map((entry) => entry.key)),
    [skillSnapshot],
  );
  const unsupported = skillSnapshot?.mode === "unsupported";

  // Library skills → row models (the store's visual language, tuned for rows).
  const libraryRows = useMemo<AgentSkillRowData[]>(
    () =>
      (companySkills ?? []).filter((skill) => !readOnlySkillKeys.has(skill.key)).map((skill) => ({
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
    [companySkills, readOnlySkillKeys],
  );

  // Adapter-detected, user-installed / unmanaged skills → read-only rows.
  const detectedRows = useMemo<AgentSkillRowData[]>(
    () =>
      (skillSnapshot?.entries ?? [])
        .filter((entry) => (entry.readOnly && entry.desired) || isReadOnlyUnmanagedSkillEntry(entry, companySkillKeys))
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

  const enabledKeys = useMemo(() => new Set(skillDraft), [skillDraft]);
  const installedKeys = useMemo(() => new Set(draft.installed), [draft.installed]);
  const installedRows = useMemo(
    () => libraryRows.filter((row) => installedKeys.has(row.key)),
    [libraryRows, installedKeys],
  );
  const enabledCount = useMemo(() => installedRows.filter((row) => enabledKeys.has(row.key)).length,
    [installedRows, enabledKeys]);
  const hasSearch = search.trim().length > 0;
  const searchResults = useMemo(
    () => search.trim() ? filterAgentSkills(libraryRows.filter((row) => !installedKeys.has(row.key)), search) : [],
    [libraryRows, installedKeys, search],
  );

  // Desired keys that no longer exist in the library → actionable warnings.
  const staleDesiredKeys = useMemo(
    () => skillDraft.filter((key) => !companySkillByKey.has(key) && !readOnlySkillKeys.has(key)),
    [companySkillByKey, skillDraft, readOnlySkillKeys],
  );

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

  const hasUnsavedChanges = !sameSkillLibrarySelection(draft, lastSaved);

  const toggleSkill = (key: string, next: boolean) => {
    setDraft((current) => ({
      enabled: next ? Array.from(new Set([...current.enabled, key])) : current.enabled.filter((value) => value !== key),
      installed: Array.from(new Set([...current.installed, key])),
    }));
  };

  // Explicit release selection saves immediately (no autosave debounce), carrying
  // the current draft so an in-flight toggle isn't dropped.
  const handleReleaseChange = (key: string, versionId: string | null) => {
    const nextPins = { ...versionPinsRef.current };
    if (versionId) nextPins[key] = versionId;
    else delete nextPins[key];
    versionPinsRef.current = nextPins;
    setVersionPins(nextPins);
    syncSkills.mutate({ selection: draft, pins: nextPins });
  };

  // The release picker only applies to the enabled paperclip core skill while the
  // beta-skills flag is on and seeded releases exist.
  const releasePickerActive = betaSkillsEnabled && paperclipReleases.length > 0;

  const renderRow = (row: AgentSkillRowData, variant: "enabled" | "available") => {
    // Historical assignments stay interactive so the user can remove them.
    // The server rejects new assignments and omits stale ones from native
    // runtime context, so disabling an enabled row would only trap stale data.
    const legacyPaperclipBlocked = agent.adapterType === "paperclip_runner"
      && !enabledKeys.has(row.key)
      && row.key === PAPERCLIP_CORE_SKILL_KEY;
    const rowDisabled = unsupported || legacyPaperclipBlocked;
    const rowDisabledReason = legacyPaperclipBlocked
      ? "Paperclip Runner uses native semantic coordination and cannot attach the legacy Paperclip operational skill."
      : unsupportedMessage;
    const showReleasePicker =
      releasePickerActive && enabledKeys.has(row.key) && row.key === PAPERCLIP_CORE_SKILL_KEY;
    const pinnedVersionId = versionPins[row.key] ?? null;
    const pinnedRelease = pinnedVersionId
      ? paperclipReleases.find((release) => release.id === pinnedVersionId) ?? null
      : null;

    return (
      <AgentSkillRow
        key={row.key}
        variant={variant}
        data={row}
        checked={enabledKeys.has(row.key)}
        disabled={rowDisabled}
        disabledReason={rowDisabledReason}
        onCheckedChange={(next) => toggleSkill(row.key, next)}
        badge={
          showReleasePicker && pinnedRelease ? (
            <Badge variant="secondary" className="text-(length:--text-nano)">
              Beta · {releaseShortLabel(pinnedRelease)}
            </Badge>
          ) : undefined
        }
        accessory={
          showReleasePicker ? (
            <AgentSkillReleasePicker
              releases={paperclipReleases}
              value={pinnedVersionId}
              disabled={rowDisabled || syncSkills.isPending}
              onChange={(versionId) => handleReleaseChange(row.key, versionId)}
            />
          ) : undefined
        }
      />
    );
  };

  const libraryEmpty = libraryRows.length === 0;

  if (skillError) return <QueryErrorState error={skillError} action="load agent skills" onRetry={() => { void retrySkills(); }} />;
  if (libraryError) return <QueryErrorState error={libraryError} action="load the skill library" onRetry={() => { void retryLibrary(); }} />;

  return (
    <div className="max-w-4xl space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {enabledCount} enabled · {installedRows.length} installed
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
            error={syncSkills.isError && hasUnsavedChanges} // query-error-ok: syncSkills is a save mutation result, not a query read
          />
          <div data-canonical-toolbar="agent-skills" role="toolbar" aria-label="Agent skills controls" className="ml-auto flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link to="/skills" className="no-underline">
                <Store className="h-3.5 w-3.5" />
                Browse skills store
              </Link>
            </Button>
          </div>
        </div>

        {syncSkills.isError ? ( // query-error-ok: syncSkills is a save mutation result; copy rendered from the mutation error below
          <p className="text-xs text-destructive">
            {describeError(syncSkills.error).body}
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
                <span className="font-medium">{key}</span> is enabled but missing from the organization library.
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

      {isLoading || libraryLoading ? (
        <PageSkeleton variant="list" />
      ) : libraryEmpty && detectedRows.length === 0 ? (
        <EmptyLibraryCard />
      ) : (
        <div className="space-y-4">
          <SkillSection title="Installed on this agent" count={installedRows.length}>
            {installedRows.length > 0 ? (
              installedRows.map((row) => renderRow(row, "enabled"))
            ) : (
              <SectionEmpty>No skills installed on this agent yet. Search the library below to add skills.</SectionEmpty>
            )}
          </SkillSection>

          <SkillSection title="Add skills" count={searchResults.length}>
            <div className="px-3 py-3">
              <div className="relative">
                <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search the skill library"
                  className="w-full pl-8 pr-10 [&::-webkit-search-cancel-button]:appearance-none"
                  aria-label="Search the skill library"
                />
                {search ? (
                  <Button variant="ghost" size="icon-sm" className="absolute right-1 top-1/2 -translate-y-1/2"
                    aria-label="Clear skill search" onClick={() => setSearch("")}>
                    <X aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
            {searchResults.length > 0 ? (
              searchResults.map((row) => renderRow(row, "available"))
            ) : (
              <SectionEmpty>
                {hasSearch ? "No library skills match your search." : "Search the library to find and add skills."}
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
                    Automatic and detected skills (read-only)
                  </span>
                  <span className="text-xs text-muted-foreground/70">{detectedRows.length}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {detectedRows.length > 0 ? (
                    detectedRows.map((row) => (
                      <AgentSkillRow key={row.key} variant="readonly" data={row} />
                    ))
                  ) : (
                    <SectionEmpty>No detected skills.</SectionEmpty>
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
        <p className="text-sm font-medium text-foreground">No skills in the organization library</p>
        <p className="text-xs text-muted-foreground">
          Install skills to the organization, then enable them on this agent.
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
