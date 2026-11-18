import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_ROUTINE_CADENCE,
  ROUTINE_SUGGESTION_FREQUENCIES,
  ROUTINE_SUGGESTION_MAX_DAY_OF_MONTH,
  ROUTINE_SUGGESTION_WEEKDAYS,
  routineSuggestionCadenceLabel,
  routineSuggestionCronExpression,
  suggestCadenceFromTitle,
  type Agent,
  type RoutineFromTaskResult,
  type RoutineSuggestionCadence,
  type RoutineSuggestionFrequency,
  type RoutineSuggestionWeekday,
} from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { responsibilitiesApi } from "@/api/responsibilities";
import { routineSuggestionsApi } from "@/api/routine-suggestions";
import { routinesApi } from "@/api/routines";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";

/** The task a routine would repeat, and what the form starts on. */
export interface RoutineTaskTarget {
  issueId: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
  /** The cadence to start on (an agent's offer, or one the title names); else read from the title. */
  suggestedCadence?: RoutineSuggestionCadence | null;
  cadenceSource?: "offer" | "title" | "default";
}

const FREQUENCY_LABEL: Record<RoutineSuggestionFrequency, string> = {
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week",
  monthly: "Every month",
};

const WEEKDAY_ORDER: readonly RoutineSuggestionWeekday[] = [...ROUTINE_SUGGESTION_WEEKDAYS.slice(1), ROUTINE_SUGGESTION_WEEKDAYS[0]];

function capitalize(word: string) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Who runs it by default: the task's agent when it can take work, else the
 * organization's first agent (the earliest created that is not terminated).
 */
export function defaultRoutineAgentId(agents: readonly Agent[], taskAgentId: string | null): string {
  const available = agents.filter((agent) => agent.status !== "terminated");
  if (taskAgentId && available.some((agent) => agent.id === taskAgentId)) return taskAgentId;
  const first = [...available].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
  return first?.id ?? "";
}

/** A routine that repeats nothing yet: made from scratch and filed under one responsibility. */
export interface NewRoutineTarget {
  responsibilityId: string;
  responsibilityTitle: string;
  /** Who runs it to start with (an agent working under the responsibility), else the organization's first agent. */
  assigneeAgentId?: string | null;
}

/**
 * A new routine from scratch with the routines module's own calls, as the
 * Routines page makes one: the routine, then its schedule (a routine left
 * without its schedule is archived before the error is shown), then filed
 * under the responsibility.
 */
export async function createRoutineUnderResponsibility(
  companyId: string,
  target: NewRoutineTarget,
  input: { title: string; cadence: RoutineSuggestionCadence; cadenceLabel: string; assigneeAgentId: string; timezone: string },
) {
  const routine = await routinesApi.create(companyId, { title: input.title, assigneeAgentId: input.assigneeAgentId });
  try {
    await routinesApi.createTrigger(routine.id, {
      kind: "schedule",
      label: input.cadenceLabel,
      cronExpression: routineSuggestionCronExpression(input.cadence),
      timezone: input.timezone,
    });
  } catch (error) {
    await routinesApi.update(routine.id, { status: "archived" }).catch(() => undefined);
    throw error;
  }
  await responsibilitiesApi.link(target.responsibilityId, { routineId: routine.id });
  return routine;
}

/** "Pricing", "Pricing and Market", "Pricing, Market and Ops". */
function joinTitles(titles: readonly string[]): string {
  if (titles.length <= 1) return titles[0] ?? "";
  return `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
}

/**
 * "Make it a routine": a person turns a task into a routine that repeats it
 * on a schedule. What repeats (the task's title), how often (in the words the
 * schedule will run on), and which agent runs it. The task is left as it is;
 * the routine is filed under every responsibility the task is under.
 *
 * With `newFor` instead of a task, the same three questions make a new
 * routine from scratch, filed under that responsibility.
 */
export function MakeRoutineDialog({
  open,
  onOpenChange,
  companyId,
  task,
  newFor = null,
  agents,
  filedUnder,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  task: RoutineTaskTarget | null;
  /** Make a new routine under this responsibility (when `task` is null). */
  newFor?: NewRoutineTarget | null;
  agents: readonly Agent[];
  /** Titles of the responsibilities the task is under, as far as the page knows. */
  filedUnder: readonly string[];
  onCreated?: (result: RoutineFromTaskResult, task: RoutineTaskTarget) => void;
}) {
  const fresh = !task && !!newFor;
  const queryClient = useQueryClient();
  const titleInput = useRef<HTMLInputElement>(null);
  const available = useMemo(() => agents.filter((agent) => agent.status !== "terminated"), [agents]);
  const [title, setTitle] = useState("");
  const [frequency, setFrequency] = useState<RoutineSuggestionFrequency>("weekly");
  const [dayOfWeek, setDayOfWeek] = useState<RoutineSuggestionWeekday>("monday");
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [time, setTime] = useState(DEFAULT_ROUTINE_CADENCE.time);
  const [agentId, setAgentId] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  // A fresh form for each task, starting on the cadence suggested for it.
  useEffect(() => {
    if (!open || task || !newFor) return;
    setTitle("");
    setFrequency(DEFAULT_ROUTINE_CADENCE.frequency);
    setDayOfWeek(DEFAULT_ROUTINE_CADENCE.dayOfWeek ?? "monday");
    setDayOfMonth(DEFAULT_ROUTINE_CADENCE.dayOfMonth ?? 1);
    setTime(DEFAULT_ROUTINE_CADENCE.time);
    setAgentId("");
    setHint(null);
  }, [open, task, newFor]);
  useEffect(() => {
    if (!open || !task) return;
    const fromTitle = suggestCadenceFromTitle(task.title);
    const start = task.suggestedCadence ?? fromTitle ?? DEFAULT_ROUTINE_CADENCE;
    const source = task.cadenceSource ?? (!task.suggestedCadence && fromTitle ? "title" : "default");
    setTitle(task.title);
    setFrequency(start.frequency);
    setDayOfWeek(start.dayOfWeek ?? "monday");
    setDayOfMonth(start.dayOfMonth ?? 1);
    setTime(start.time);
    setAgentId("");
    setHint(source === "offer" ? "The agent suggested this." : source === "title" ? "Suggested from the title." : null);
  }, [open, task]);

  const effectiveAgentId = agentId || defaultRoutineAgentId(available, task?.assigneeAgentId ?? newFor?.assigneeAgentId ?? null);
  const cadence: RoutineSuggestionCadence = {
    frequency,
    dayOfWeek: frequency === "weekly" ? dayOfWeek : null,
    dayOfMonth: frequency === "monthly" ? dayOfMonth : null,
    time: /^\d{2}:\d{2}$/.test(time) ? time : DEFAULT_ROUTINE_CADENCE.time,
  };
  const cadenceLabel = routineSuggestionCadenceLabel(cadence);
  const zone = localTimeZone();

  const create = useMutation({
    mutationFn: async (): Promise<RoutineFromTaskResult | null> => {
      if (!task) {
        await createRoutineUnderResponsibility(companyId, newFor!, {
          title: title.trim(),
          cadence,
          cadenceLabel,
          assigneeAgentId: effectiveAgentId,
          timezone: zone,
        });
        return null;
      }
      return routineSuggestionsApi.repeatAsRoutine(task.issueId, {
        title: title.trim(),
        cadence,
        assigneeAgentId: effectiveAgentId,
        timezone: zone,
      });
    },
    onSuccess: async (result) => {
      if (result && task) onCreated?.(result, task);
      onOpenChange(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all }),
        queryClient.invalidateQueries({ queryKey: ["routines"] }),
        queryClient.invalidateQueries({ queryKey: ["issues", "interactions"] }),
      ]);
    },
  });
  const resetCreate = create.reset;
  useEffect(() => {
    if (open) resetCreate();
  }, [open, resetCreate]);

  const canSubmit = (!!task || fresh) && title.trim().length > 0 && !!effectiveAgentId && !create.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) create.mutate();
  };

  return (
    <Dialog open={open && (!!task || fresh)} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleInput.current?.focus();
        }}
      >
        <form className="flex flex-col gap-5" onSubmit={submit} data-make-routine-dialog="">
          <DialogHeader>
            <DialogTitle>{fresh ? "New routine" : "Make it a routine"}</DialogTitle>
            <DialogDescription>
              {fresh ? "An agent does this on a schedule." : "An agent repeats this on a schedule, so it no longer needs you to start it."}
            </DialogDescription>
          </DialogHeader>

          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium text-foreground">What repeats</span>
            <Input
              ref={titleInput}
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              required
              aria-label="What repeats"
              placeholder={fresh ? "e.g. Review the investor pipeline" : undefined}
            />
          </label>

          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="mb-2 font-medium text-foreground">How often</legend>
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect
                aria-label="How often"
                className="w-auto"
                value={frequency}
                onChange={(event) => setFrequency(event.target.value as RoutineSuggestionFrequency)}
              >
                {ROUTINE_SUGGESTION_FREQUENCIES.map((value) => (
                  <option key={value} value={value}>{FREQUENCY_LABEL[value]}</option>
                ))}
              </NativeSelect>
              {frequency === "weekly" ? (
                <>
                  <span className="text-muted-foreground">on</span>
                  <NativeSelect
                    aria-label="Day of the week"
                    className="w-auto"
                    value={dayOfWeek}
                    onChange={(event) => setDayOfWeek(event.target.value as RoutineSuggestionWeekday)}
                  >
                    {WEEKDAY_ORDER.map((day) => (
                      <option key={day} value={day}>{capitalize(day)}</option>
                    ))}
                  </NativeSelect>
                </>
              ) : null}
              {frequency === "monthly" ? (
                <>
                  <span className="text-muted-foreground">on day</span>
                  <NativeSelect
                    aria-label="Day of the month"
                    className="w-auto"
                    value={String(dayOfMonth)}
                    onChange={(event) => setDayOfMonth(Number(event.target.value))}
                  >
                    {Array.from({ length: ROUTINE_SUGGESTION_MAX_DAY_OF_MONTH }, (_, index) => index + 1).map((day) => (
                      <option key={day} value={day}>{day}</option>
                    ))}
                  </NativeSelect>
                </>
              ) : null}
              <span className="text-muted-foreground">at</span>
              <Input
                type="time"
                aria-label="Time"
                className="w-auto"
                value={time}
                step={300}
                onChange={(event) => setTime(event.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground" data-cadence-preview="">
              {cadenceLabel}, your time ({zone}).{hint ? ` ${hint}` : ""}
            </p>
          </fieldset>

          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium text-foreground">Who runs it</span>
            <NativeSelect
              aria-label="Who runs it"
              value={effectiveAgentId}
              onChange={(event) => setAgentId(event.target.value)}
              disabled={available.length === 0}
            >
              {available.length === 0 ? <option value="">No agents yet</option> : null}
              {available.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </NativeSelect>
            {available.length === 0 ? (
              <span className="text-xs text-muted-foreground">Add an agent first: a routine needs one to run it.</span>
            ) : null}
          </label>

          <p className="text-xs text-muted-foreground" data-routine-filing-note="">
            {fresh ? `Filed under ${newFor!.responsibilityTitle}.` : (
              <>
                The task itself stays as it is.{" "}
                {filedUnder.length > 0
                  ? `The routine is filed under ${joinTitles(filedUnder)}, like the task.`
                  : "The routine is filed wherever the task is."}
              </>
            )}
          </p>

          {create.error ? (
            <p role="alert" className="text-sm text-destructive">
              Couldn’t make the routine. {describeError(create.error).body}
            </p>
          ) : null}

          <DialogFooter className="sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {create.isPending ? "Making the routine…" : fresh ? "Make the routine" : "Make it a routine"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
