import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LinkResponsibility } from "@paperclipai/shared";
import { Plus } from "lucide-react";
import { ApiError } from "@/api/client";
import { describeError } from "@/api/errors";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { companySkillsApi } from "@/api/companySkills";
import { issuesApi } from "@/api/issues";
import { responsibilitiesApi, type ResponsibilityLinkResult } from "@/api/responsibilities";
import { routinesApi } from "@/api/routines";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { companyProjectsQuery } from "@/lib/company-projects-query";
import { queryKeys } from "@/lib/queryKeys";

export type ResponsibilityWorkKind = "project" | "task" | "routine" | "skill";

const TASK_SEARCH_LIMIT = 20;
const TASK_SEARCH_DEBOUNCE_MS = 200;

const NOUN: Record<ResponsibilityWorkKind, string> = { project: "project", task: "task", routine: "routine", skill: "skill" };

interface PickerOption {
  id: string;
  label: string;
  detail?: string | null;
}

/**
 * Readable copy for a refused link. Filing is additive (an item can sit under
 * several responsibilities), so a 404 means the item is gone or out of reach.
 */
export function describeLinkError(error: unknown, kind: ResponsibilityWorkKind): string {
  if (error instanceof ApiError && error.status === 404) {
    return `That ${NOUN[kind]} is no longer available to you. It may have been deleted or made private.`;
  }
  return describeError(error).body;
}

function linkBody(kind: ResponsibilityWorkKind, id: string): LinkResponsibility {
  if (kind === "project") return { projectId: id };
  if (kind === "task") return { issueId: id };
  if (kind === "skill") return { skillId: id };
  return { routineId: id };
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * "Add existing…": search the company's projects, tasks, routines or skills
 * and file one under the responsibility (it stays wherever else it is filed). Lists
 * load only while the picker is open; tasks are searched on the server. Items
 * already directly under this responsibility are left out.
 *
 * By default it opens from its own "Add existing" button. With `anchor` (and
 * `open`/`onOpenChange`), another control opens it, and it sits under that.
 */
export function AddExistingWorkPicker({
  companyId,
  responsibilityId,
  kind,
  linkedIds,
  onLinked,
  open: controlledOpen,
  onOpenChange,
  anchor,
}: {
  companyId: string;
  responsibilityId: string;
  kind: ResponsibilityWorkKind;
  /** Ids already linked directly to this responsibility. */
  linkedIds: ReadonlySet<string>;
  onLinked?: (result: ResponsibilityLinkResult) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** What the picker opens under, in place of its own button. */
  anchor?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const [query, setQuery] = useState("");
  const taskQuery = useDebounced(query.trim(), TASK_SEARCH_DEBOUNCE_MS);

  const projects = useQuery({ ...companyProjectsQuery(companyId), enabled: open && kind === "project" });
  const routines = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
    enabled: open && kind === "routine",
  });
  const skills = useQuery({
    queryKey: queryKeys.companySkills.list(companyId),
    queryFn: () => companySkillsApi.list(companyId),
    enabled: open && kind === "skill",
  });
  const tasks = useQuery({
    queryKey: queryKeys.issues.search(companyId, taskQuery, undefined, TASK_SEARCH_LIMIT),
    queryFn: () => issuesApi.list(companyId, { q: taskQuery || undefined, limit: TASK_SEARCH_LIMIT }),
    enabled: open && kind === "task",
  });

  const options = useMemo<PickerOption[]>(() => {
    if (kind === "project") {
      return (projects.data ?? []).map((project) => ({ id: project.id, label: project.name }));
    }
    if (kind === "routine") {
      return (routines.data ?? []).map((routine) => ({ id: routine.id, label: routine.title }));
    }
    if (kind === "skill") {
      return (skills.data ?? []).map((skill) => ({ id: skill.id, label: skill.name }));
    }
    return (tasks.data ?? []).map((task) => ({ id: task.id, label: task.title, detail: task.identifier }));
  }, [kind, projects.data, routines.data, skills.data, tasks.data]);
  const available = useMemo(() => options.filter((option) => !linkedIds.has(option.id)), [options, linkedIds]);

  const source = kind === "project" ? projects : kind === "routine" ? routines : kind === "skill" ? skills : tasks;
  const sourceView = useQueryView<unknown>({
    data: source.data,
    error: source.error,
    status: source.status,
    fetchStatus: source.fetchStatus,
    failureReason: source.failureReason,
    refetch: source.refetch,
  });

  const link = useMutation({
    mutationFn: (id: string) => responsibilitiesApi.link(responsibilityId, linkBody(kind, id)),
    onSuccess: (result) => {
      setOpen(false);
      setQuery("");
      onLinked?.(result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all });
    },
  });

  const resetLink = link.reset;
  useEffect(() => {
    if (open) resetLink();
  }, [open, resetLink]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {anchor ? (
        <PopoverAnchor asChild>
          <span className="inline-flex">{anchor}</span>
        </PopoverAnchor>
      ) : (
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost">
            <Plus aria-hidden="true" />
            Add existing {NOUN[kind]}
          </Button>
        </PopoverTrigger>
      )}
      <PopoverContent align="end" className="w-80 p-0">
        <Command shouldFilter={kind !== "task"}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={`Search ${NOUN[kind]}s…`}
            aria-label={`Search ${NOUN[kind]}s`}
          />
          <CommandList>
            {sourceView.kind === "error" ? (
              <div className="px-3 py-4">
                <QueryErrorState
                  error={sourceView.error}
                  size="inline"
                  action={`load ${NOUN[kind]}s`}
                  onRetry={sourceView.retry}
                  retrying={sourceView.isFetching}
                />
              </div>
            ) : !sourceView.data ? (
              <p className="px-3 py-4 text-sm text-muted-foreground" role="status">Loading…</p>
            ) : (
              <>
                <CommandEmpty>
                  {options.length > 0 && available.length === 0
                    ? `Every matching ${NOUN[kind]} is already here.`
                    : `No ${NOUN[kind]}s found.`}
                </CommandEmpty>
                {available.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={`${option.label} ${option.detail ?? ""} ${option.id}`}
                    disabled={link.isPending}
                    onSelect={() => link.mutate(option.id)}
                  >
                    {option.detail ? <span className="font-mono text-xs text-muted-foreground">{option.detail}</span> : null}
                    <span className="truncate">{option.label}</span>
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
          {link.error ? (
            <p role="alert" className="border-t border-border px-3 py-2 text-sm text-destructive">
              {describeLinkError(link.error, kind)}
            </p>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
