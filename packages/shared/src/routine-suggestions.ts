import { z } from "zod";

/**
 * Routine suggestions: after an agent finishes a task that plausibly recurs,
 * it may offer, once, to repeat that task on a schedule. The offer is a
 * `suggest_routine` conversation card on the finished task; accepting it
 * creates a routine with the task's agent and project. Experimental, behind
 * `enableResponsibilities`.
 *
 * The agent describes the cadence in a small structured form; the server
 * derives the schedule expression and the plain-words label from it, so the
 * words a person reads always match what will run.
 */

export const ROUTINE_SUGGESTION_FREQUENCIES = ["daily", "weekdays", "weekly", "monthly"] as const;
export type RoutineSuggestionFrequency = (typeof ROUTINE_SUGGESTION_FREQUENCIES)[number];

/** Index order matches cron day-of-week numbering (0 = Sunday). */
export const ROUTINE_SUGGESTION_WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
export type RoutineSuggestionWeekday = (typeof ROUTINE_SUGGESTION_WEEKDAYS)[number];

/** Monthly suggestions stay on days every month has. */
export const ROUTINE_SUGGESTION_MAX_DAY_OF_MONTH = 28;

export interface RoutineSuggestionCadence {
  frequency: RoutineSuggestionFrequency;
  /** Required for `weekly`; ignored otherwise. */
  dayOfWeek?: RoutineSuggestionWeekday | null;
  /** Required for `monthly` (1-28); ignored otherwise. */
  dayOfMonth?: number | null;
  /** Wall-clock time in the accepting person's time zone, 24-hour `HH:MM`. */
  time: string;
}

export interface SuggestRoutinePayload {
  version: 1;
  /** What would repeat; becomes the routine title. */
  title: string;
  /** What each run should do; becomes the routine description. */
  instructions: string;
  /** The agent's short, plain-words offer shown on the card. */
  message: string | null;
  cadence: RoutineSuggestionCadence;
  /** Server-derived from `cadence`, for example "Every Monday at 9 AM". */
  cadenceLabel: string;
  /** Server-derived five-field schedule expression. */
  cronExpression: string;
  /** Copied from the task when the offer is made. */
  assigneeAgentId: string;
  projectId: string | null;
}

export const SUGGEST_ROUTINE_OUTCOMES = [
  "accepted",
  "declined",
  "withdrawn",
  "issue_closed",
  "addressee_deleted",
  "skipped",
] as const;
export type SuggestRoutineOutcome = (typeof SUGGEST_ROUTINE_OUTCOMES)[number];

export interface SuggestRoutineResult {
  version: 1;
  outcome: SuggestRoutineOutcome;
  reason?: string | null;
  /** Set once an accepted offer's routine exists. */
  routineId?: string | null;
  routineTitle?: string | null;
  cadenceLabel?: string | null;
  timezone?: string | null;
  /** Responsibilities the new routine was filed under (empty when the task was loose). */
  responsibilityIds?: string[];
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const routineSuggestionCadenceSchema = z
  .object({
    frequency: z.enum(ROUTINE_SUGGESTION_FREQUENCIES),
    dayOfWeek: z.enum(ROUTINE_SUGGESTION_WEEKDAYS).optional().nullable(),
    dayOfMonth: z.number().int().min(1).max(ROUTINE_SUGGESTION_MAX_DAY_OF_MONTH).optional().nullable(),
    time: z.string().regex(HH_MM, "time must be 24-hour HH:MM, for example 09:00"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.frequency === "weekly" && !value.dayOfWeek) {
      ctx.addIssue({ code: "custom", path: ["dayOfWeek"], message: "A weekly routine needs dayOfWeek" });
    }
    if (value.frequency === "monthly" && !value.dayOfMonth) {
      ctx.addIssue({ code: "custom", path: ["dayOfMonth"], message: "A monthly routine needs dayOfMonth (1-28)" });
    }
  });

// A scheduled routine cannot ask for run inputs, so the offered text must not
// contain routine variable placeholders.
const NO_PLACEHOLDERS = (value: string) => !value.includes("{{");
const NO_PLACEHOLDERS_MESSAGE = "Write the text out in full; scheduled routines cannot use {{placeholders}}";

/** Body an agent sends to offer a routine for the task it just finished. */
export const createRoutineSuggestionSchema = z
  .object({
    title: z.string().trim().min(1).max(200).refine(NO_PLACEHOLDERS, NO_PLACEHOLDERS_MESSAGE),
    instructions: z.string().trim().min(1).max(10_000).refine(NO_PLACEHOLDERS, NO_PLACEHOLDERS_MESSAGE),
    cadence: routineSuggestionCadenceSchema,
    message: z.string().trim().min(1).max(500).optional().nullable(),
  })
  .strict();
export type CreateRoutineSuggestion = z.infer<typeof createRoutineSuggestionSchema>;

/** Accepting may name the person's IANA time zone; the schedule runs in it. */
export const acceptRoutineSuggestionSchema = z
  .object({
    timezone: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type AcceptRoutineSuggestion = z.infer<typeof acceptRoutineSuggestionSchema>;

export const declineRoutineSuggestionSchema = z.object({}).strict();
export type DeclineRoutineSuggestion = z.infer<typeof declineRoutineSuggestionSchema>;

export const suggestRoutinePayloadSchema = z.object({
  version: z.literal(1),
  title: z.string(),
  instructions: z.string(),
  message: z.string().nullable(),
  cadence: routineSuggestionCadenceSchema,
  cadenceLabel: z.string(),
  cronExpression: z.string(),
  assigneeAgentId: z.string(),
  projectId: z.string().nullable(),
});

export const suggestRoutineResultSchema = z.object({
  version: z.literal(1),
  outcome: z.enum(SUGGEST_ROUTINE_OUTCOMES),
  reason: z.string().nullable().optional(),
  routineId: z.string().nullable().optional(),
  routineTitle: z.string().nullable().optional(),
  cadenceLabel: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  responsibilityIds: z.array(z.string()).optional(),
});

function normalizedCadence(cadence: RoutineSuggestionCadence) {
  const [hour, minute] = cadence.time.split(":").map((part) => Number(part));
  return { ...cadence, hour: hour!, minute: minute! };
}

/** Five-field cron for a cadence, evaluated in the routine trigger's time zone. */
export function routineSuggestionCronExpression(cadence: RoutineSuggestionCadence): string {
  const { frequency, hour, minute, dayOfWeek, dayOfMonth } = normalizedCadence(cadence);
  switch (frequency) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${ROUTINE_SUGGESTION_WEEKDAYS.indexOf(dayOfWeek!)}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
  }
}

function clockLabel(hour: number, minute: number) {
  const suffix = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function ordinal(day: number) {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
}

/** Plain words for a cadence, for example "Every Monday at 9 AM". */
export function routineSuggestionCadenceLabel(cadence: RoutineSuggestionCadence): string {
  const { frequency, hour, minute, dayOfWeek, dayOfMonth } = normalizedCadence(cadence);
  const at = `at ${clockLabel(hour, minute)}`;
  switch (frequency) {
    case "daily":
      return `Every day ${at}`;
    case "weekdays":
      return `Every weekday ${at}`;
    case "weekly":
      return `Every ${dayOfWeek!.charAt(0).toUpperCase()}${dayOfWeek!.slice(1)} ${at}`;
    case "monthly":
      return `On the ${ordinal(dayOfMonth!)} of every month ${at}`;
  }
}

/**
 * Standing instruction added to a task's prompt while routine suggestions are
 * enabled (legacy adapters and native runners alike). Keep it short: it rides
 * on every eligible task.
 */
export function routineSuggestionAgentGuidance(issueId: string): string {
  return [
    "When you finish this task, decide whether the person will plausibly want the same work again on a schedule: a recurring report, check, digest, follow-up or reconciliation, output that goes stale, or they asked for it periodically.",
    `If so, offer once to repeat it as a routine with POST /api/issues/${issueId}/routine-suggestions and { title, instructions, cadence: { frequency: daily | weekdays | weekly | monthly, dayOfWeek for weekly (monday..sunday), dayOfMonth for monthly (1-28), time "HH:MM" in the person's local time }, message }. Do it right after your completion message and marking the task done, or just before finish_task.`,
    "instructions must say in full what each run should do; message is one plain sentence in your voice that says task and routine, never issue or scheduling internals.",
    "Do not offer for one-off work (a fix, build, migration, single document or decision, one-time research, setup) or when unsure. The person accepts or declines in the task conversation and you are not woken by the answer. A 409, 404 or 422 means no offer is possible here; carry on without it.",
  ].join(" ");
}
