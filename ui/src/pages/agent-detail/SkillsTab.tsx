import { useEffect, useMemo, useState, useRef } from "react";
import { Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../../api/agents";
import { companySkillsApi } from "../../api/companySkills";
import { queryKeys } from "../../lib/queryKeys";
import { adapterLabels } from "../../components/agent-config-primitives";
import { MarkdownBody } from "../../components/MarkdownBody";
import { PageSkeleton } from "../../components/PageSkeleton";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Loader2 } from "lucide-react";
import type { Agent, AgentSkillEntry } from "@paperclipai/shared";
import {
  applyAgentSkillSnapshot,
  arraysEqual,
  isReadOnlyUnmanagedSkillEntry,
} from "../../lib/agent-skills-state";

export function AgentSkillsTab({
  agent,
  companyId,
}: {
  agent: Agent;
  companyId?: string;
}) {
  type SkillRow = {
    id: string;
    key: string;
    name: string;
    description: string | null;
    detail: string | null;
    locationLabel: string | null;
    originLabel: string | null;
    linkTo: string | null;
    readOnly: boolean;
    adapterEntry: AgentSkillEntry | null;
  };

  const queryClient = useQueryClient();
  const [skillDraft, setSkillDraft] = useState<string[]>([]);
  const [lastSavedSkills, setLastSavedSkills] = useState<string[]>([]);
  const lastSavedSkillsRef = useRef<string[]>([]);
  const hasHydratedSkillSnapshotRef = useRef(false);
  const skipNextSkillAutosaveRef = useRef(true);

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
  });

  useEffect(() => {
    setSkillDraft([]);
    setLastSavedSkills([]);
    lastSavedSkillsRef.current = [];
    hasHydratedSkillSnapshotRef.current = false;
    skipNextSkillAutosaveRef.current = true;
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
    if (arraysEqual(skillDraft, lastSavedSkillsRef.current)) return;

    const timeout = window.setTimeout(() => {
      if (!arraysEqual(skillDraft, lastSavedSkillsRef.current)) {
        syncSkills.mutate(skillDraft);
      }
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [skillDraft, skillSnapshot, syncSkills.isPending, syncSkills.mutate]);

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
  const optionalSkillRows = useMemo<SkillRow[]>(
    () =>
      (companySkills ?? [])
        .filter((skill) => !adapterEntryByKey.get(skill.key)?.required)
        .map((skill) => ({
          id: skill.id,
          key: skill.key,
          name: skill.name,
          description: skill.description,
          detail: adapterEntryByKey.get(skill.key)?.detail ?? null,
          locationLabel: adapterEntryByKey.get(skill.key)?.locationLabel ?? null,
          originLabel: adapterEntryByKey.get(skill.key)?.originLabel ?? null,
          linkTo: `/skills/${skill.id}`,
          readOnly: false,
          adapterEntry: adapterEntryByKey.get(skill.key) ?? null,
        })),
    [adapterEntryByKey, companySkills],
  );
  const requiredSkillRows = useMemo<SkillRow[]>(
    () =>
      (skillSnapshot?.entries ?? [])
        .filter((entry) => entry.required)
        .map((entry) => {
          const companySkill = companySkillByKey.get(entry.key);
          return {
            id: companySkill?.id ?? `required:${entry.key}`,
            key: entry.key,
            name: companySkill?.name ?? entry.key,
            description: companySkill?.description ?? null,
            detail: entry.detail ?? null,
            locationLabel: entry.locationLabel ?? null,
            originLabel: entry.originLabel ?? null,
            linkTo: companySkill ? `/skills/${companySkill.id}` : null,
            readOnly: false,
            adapterEntry: entry,
          };
        }),
    [companySkillByKey, skillSnapshot],
  );
  const unmanagedSkillRows = useMemo<SkillRow[]>(
    () =>
      (skillSnapshot?.entries ?? [])
        .filter((entry) => isReadOnlyUnmanagedSkillEntry(entry, companySkillKeys))
        .map((entry) => ({
          id: `external:${entry.key}`,
          key: entry.key,
          name: entry.runtimeName ?? entry.key,
          description: null,
          detail: entry.detail ?? null,
          locationLabel: entry.locationLabel ?? null,
          originLabel: entry.originLabel ?? null,
          linkTo: null,
          readOnly: true,
          adapterEntry: entry,
        })),
    [companySkillKeys, skillSnapshot],
  );
  const desiredOnlyMissingSkills = useMemo(
    () => skillDraft.filter((key) => !companySkillByKey.has(key)),
    [companySkillByKey, skillDraft],
  );
  const skillApplicationLabel = useMemo(() => {
    switch (skillSnapshot?.mode) {
      case "persistent":
        return "Kept in the workspace";
      case "ephemeral":
        return "Applied when the agent runs";
      case "unsupported":
        return "Tracked only";
      default:
        return "Unknown";
    }
  }, [skillSnapshot?.mode]);
  const unsupportedSkillMessage = useMemo(() => {
    if (skillSnapshot?.mode !== "unsupported") return null;
    if (agent.adapterType === "openclaw_gateway") {
      return "Paperclip cannot manage OpenClaw skills here. Visit your OpenClaw instance to manage this agent's skills.";
    }
    return "Paperclip cannot manage skills for this adapter yet. Manage them in the adapter directly.";
  }, [agent.adapterType, skillSnapshot?.mode]);
  const hasUnsavedChanges = !arraysEqual(skillDraft, lastSavedSkills);
  const saveStatusLabel = syncSkills.isPending
    ? "Saving changes..."
    : hasUnsavedChanges
      ? "Saving soon..."
      : null;

  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/skills"
          className="text-sm font-medium text-foreground underline-offset-4 no-underline transition-colors hover:text-foreground/70 hover:underline"
        >
          View company skills library
        </Link>
        {saveStatusLabel ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {syncSkills.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            <span>{saveStatusLabel}</span>
          </div>
        ) : null}
      </div>

      {skillSnapshot?.warnings.length ? (
        <div className="space-y-1 rounded-xl border border-amber-300/60 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
          {skillSnapshot.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      ) : null}

      {unsupportedSkillMessage ? (
        <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
          {unsupportedSkillMessage}
        </div>
      ) : null}

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : (
        <>
          {(() => {
            const renderSkillRow = (skill: SkillRow) => {
              const adapterEntry = skill.adapterEntry ?? adapterEntryByKey.get(skill.key);
              const required = Boolean(adapterEntry?.required);
              const rowClassName = cn(
                "flex items-start gap-3 border-b border-border px-3 py-3 text-sm last:border-b-0",
                skill.readOnly ? "bg-muted/20" : "hover:bg-accent/20",
              );
              const body = (
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <span className="truncate font-medium">{skill.name}</span>
                    </div>
                    {skill.linkTo ? (
                      <Link
                        to={skill.linkTo}
                        className="shrink-0 text-xs text-muted-foreground no-underline hover:text-foreground"
                      >
                        View
                      </Link>
                    ) : null}
                  </div>
                  {skill.description && (
                    <MarkdownBody className="mt-1 text-xs text-muted-foreground prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                      {skill.description}
                    </MarkdownBody>
                  )}
                  {skill.readOnly && skill.originLabel && (
                    <p className="mt-1 text-xs text-muted-foreground">{skill.originLabel}</p>
                  )}
                  {skill.readOnly && skill.locationLabel && (
                    <p className="mt-1 text-xs text-muted-foreground">Location: {skill.locationLabel}</p>
                  )}
                  {skill.detail && (
                    <p className="mt-1 text-xs text-muted-foreground">{skill.detail}</p>
                  )}
                </div>
              );

              if (skill.readOnly) {
                return (
                  <div key={skill.id} className={rowClassName}>
                    <span className="mt-1 h-2 w-2 rounded-full bg-muted-foreground/40" />
                    {body}
                  </div>
                );
              }

              const checked = required || skillDraft.includes(skill.key);
              const disabled = required || skillSnapshot?.mode === "unsupported";
              const checkbox = (
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? Array.from(new Set([...skillDraft, skill.key]))
                      : skillDraft.filter((value) => value !== skill.key);
                    setSkillDraft(next);
                  }}
                  className="mt-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                />
              );

              return (
                <label key={skill.id} className={rowClassName}>
                  {required && adapterEntry?.requiredReason ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>{checkbox}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top">{adapterEntry.requiredReason}</TooltipContent>
                    </Tooltip>
                  ) : skillSnapshot?.mode === "unsupported" ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>{checkbox}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {unsupportedSkillMessage ?? "Manage skills in the adapter directly."}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    checkbox
                  )}
                  {body}
                </label>
              );
            };

            if (optionalSkillRows.length === 0 && requiredSkillRows.length === 0 && unmanagedSkillRows.length === 0) {
              return (
                <section className="border-y border-border">
                  <div className="px-3 py-6 text-sm text-muted-foreground">
                    Import skills into the company library first, then attach them here.
                  </div>
                </section>
              );
            }

            return (
              <>
                {optionalSkillRows.length > 0 && (
                  <section className="border-y border-border">
                    {optionalSkillRows.map(renderSkillRow)}
                  </section>
                )}

                {requiredSkillRows.length > 0 && (
                  <section className="border-y border-border">
                    <div className="border-b border-border bg-muted/40 px-3 py-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        Required by Paperclip
                      </span>
                    </div>
                    {requiredSkillRows.map(renderSkillRow)}
                  </section>
                )}

                {unmanagedSkillRows.length > 0 && (
                  <section className="border-y border-border">
                    <div className="border-b border-border bg-muted/40 px-3 py-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        User-installed skills, not managed by Paperclip
                      </span>
                    </div>
                    {unmanagedSkillRows.map(renderSkillRow)}
                  </section>
                )}
              </>
            );
          })()}

          {desiredOnlyMissingSkills.length > 0 && (
            <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
              <div className="font-medium">Requested skills missing from the company library</div>
              <div className="mt-1 text-xs">
                {desiredOnlyMissingSkills.join(", ")}
              </div>
            </div>
          )}

          <section className="border-t border-border pt-4">
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
                <span className="text-muted-foreground">Adapter</span>
                <span className="font-medium">{adapterLabels[agent.adapterType] ?? agent.adapterType}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
                <span className="text-muted-foreground">Skills applied</span>
                <span>{skillApplicationLabel}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
                <span className="text-muted-foreground">Selected skills</span>
                <span>{skillDraft.length}</span>
              </div>
            </div>

            {syncSkills.isError && (
              <p className="mt-3 text-xs text-destructive">
                {syncSkills.error instanceof Error ? syncSkills.error.message : "Failed to update skills"}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
