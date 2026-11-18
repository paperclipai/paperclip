import { z } from "zod";
import {
  AUTOMATION_CONVERSATION_ORIGIN_KIND,
  ONBOARDING_FIRST_TASK_ORIGIN_KIND,
  RESPONSIBILITY_BAR_ORIGIN_KIND,
  RESPONSIBILITY_DASHBOARD_ORIGIN_KIND,
  RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND,
  type IssueStatus,
  type RoutineStatus,
} from "./constants.js";
import {
  ROUTINE_SUGGESTION_WEEKDAYS,
  routineSuggestionCadenceLabel,
  routineSuggestionCadenceSchema,
  type RoutineSuggestionCadence,
  type RoutineSuggestionWeekday,
} from "./routine-suggestions.js";
import type { StandingCheckOutcome } from "./standing-checks.js";
import type { ProposeAutomationInteraction } from "./types/issue.js";

/**
 * How automated a responsibility is (experimental, `enableResponsibilities`):
 * how much of the work filed under it runs without the person, and which of
 * its manual tasks could be automated and how. The rule lives here, pure, so
 * the server's read and the views agree on every word.
 *
 * - Automations: routines under the responsibility (directly or through a
 *   linked project) that are actually running: active, assigned to an agent,
 *   and, for a standing check, with an agent that wakes up on its own. Every
 *   way a routine starts counts: a schedule, a webhook, a standing check on
 *   each wake-up, or a request.
 * - Manual tasks: tasks under it that no routine created, open or completed
 *   in the last `RESPONSIBILITY_AUTOMATION_RECENT_DAYS` days. Tasks a routine
 *   created, the onboarding task, bar and automation conversations, status
 *   update requests (and their subtasks), and tasks already turned into an
 *   automation are not manual work.
 * - Share: automations ÷ (automations + manual tasks); none without either.
 */

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** In the order the view counts them: where the opportunity is first. */
export const RESPONSIBILITY_AUTOMATION_LEVELS = ["manual", "some_automated", "mostly_automated", "automated"] as const;
export type ResponsibilityAutomationLevel = (typeof RESPONSIBILITY_AUTOMATION_LEVELS)[number];

export const RESPONSIBILITY_AUTOMATION_LEVEL_LABEL: Record<ResponsibilityAutomationLevel, string> = {
  manual: "Manual",
  some_automated: "Some automated",
  mostly_automated: "Mostly automated",
  automated: "Automated",
};

/** A share at or above this is "Mostly automated" (below it, "Some automated"). */
export const RESPONSIBILITY_AUTOMATION_MOSTLY_SHARE = 0.5;
/** Finished manual tasks count as hand work for this many days after completion. */
export const RESPONSIBILITY_AUTOMATION_RECENT_DAYS = 30;
/** Ranked manual tasks the read returns per responsibility (the total is always given). */
export const RESPONSIBILITY_AUTOMATION_CANDIDATE_LIMIT = 6;
/** Running automations the read lists per responsibility (the total is always given). */
export const RESPONSIBILITY_AUTOMATION_ROUTINE_LIMIT = 6;

/**
 * An automation a person made from a task records the task as its origin
 * (`routines.origin_kind` / `origin_id` = the task id), so the task is no
 * longer offered as a manual task while that routine is not archived.
 */
export const ROUTINE_FROM_TASK_ORIGIN_KIND = "repeated_task";

/** Task origins (on the task or any ancestor) that are never manual work. */
export const RESPONSIBILITY_AUTOMATION_EXCLUDED_ORIGIN_KINDS = [
  "routine_execution",
  ONBOARDING_FIRST_TASK_ORIGIN_KIND,
  RESPONSIBILITY_BAR_ORIGIN_KIND,
  AUTOMATION_CONVERSATION_ORIGIN_KIND,
  RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND,
  RESPONSIBILITY_DASHBOARD_ORIGIN_KIND,
] as const;

/** Automations ÷ (automations + manual tasks), 0–1; null with neither. */
export function responsibilityAutomationShare(automations: number, manualTasks: number): number | null {
  const running = Math.max(0, automations);
  const total = running + Math.max(0, manualTasks);
  return total > 0 ? running / total : null;
}

/**
 * Manual: no running automation (this includes nothing filed at all).
 * Automated: running automations and no manual work.
 * Otherwise Mostly automated at a share of half or more, else Some automated.
 */
export function responsibilityAutomationLevel(automations: number, manualTasks: number): ResponsibilityAutomationLevel {
  if (automations <= 0) return "manual";
  if (manualTasks <= 0) return "automated";
  const share = responsibilityAutomationShare(automations, manualTasks) ?? 0;
  return share >= RESPONSIBILITY_AUTOMATION_MOSTLY_SHARE ? "mostly_automated" : "some_automated";
}

/** "62": the share as a whole percent, or null. */
export function responsibilityAutomationPercent(share: number | null): number | null {
  return share === null ? null : Math.round(share * 100);
}

// ---------------------------------------------------------------------------
// How an automation starts
// ---------------------------------------------------------------------------

/** The three ways a manual task can be automated, in the order the hint weighs them. */
export const AUTOMATION_TRIGGERS = ["schedule", "webhook", "standing_check"] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  schedule: "On a schedule",
  webhook: "From a webhook",
  standing_check: "Standing check",
};

// ---------------------------------------------------------------------------
// The trigger hint: which way a manual task could be automated
// ---------------------------------------------------------------------------

const SUFFIXES = ["ing", "ed", "es", "s"] as const;

function normalizeWord(word: string): string {
  let stem = word.toLowerCase();
  for (const suffix of SUFFIXES) {
    if (stem.endsWith(suffix) && stem.length - suffix.length >= 3) {
      stem = stem.slice(0, -suffix.length);
      break;
    }
  }
  return stem.endsWith("e") && stem.length > 3 ? stem.slice(0, -1) : stem;
}

interface Token {
  raw: string;
  stem: string;
}

function titleTokens(title: string): Token[] {
  return title.split(/[^A-Za-z0-9]+/).filter(Boolean).map((raw) => ({ raw, stem: normalizeWord(raw) }));
}

/** Words that name when the work happens. Matched as whole words after a light normalization. */
export const AUTOMATION_HINT_TIME_WORDS = [
  "daily", "nightly", "hourly", "weekly", "biweekly", "fortnightly", "monthly", "quarterly", "yearly", "annual", "annually",
  "weekday", "weekdays",
  ...ROUTINE_SUGGESTION_WEEKDAYS,
] as const;
/** "every"/"each" name a time only when a unit of time follows: "every Monday", "each week". */
const EVERY_UNITS = ["day", "morning", "evening", "night", "week", "weekday", "month", "quarter", "year", "hour", ...ROUTINE_SUGGESTION_WEEKDAYS];
/** Regular production: work that usually comes round again, without saying when. */
export const AUTOMATION_HINT_PRODUCTION_WORDS = [
  "report", "review", "audit", "reconcile", "reconciliation", "digest", "recap", "roundup", "newsletter", "standup",
] as const;
/** Things arriving: work that starts when something comes in. */
export const AUTOMATION_HINT_ARRIVAL_WORDS = [
  "when", "new", "incoming", "inbound", "reply", "replies", "request", "ticket", "alert", "submitted", "submission",
  "signup", "triage",
] as const;
const ARRIVAL_PHRASES = [["pull", "request"], ["sign", "up"]];
/** Watching for a condition: work that is a standing check. */
export const AUTOMATION_HINT_WATCH_WORDS = [
  "monitor", "ensure", "chase", "waiting", "waited", "overdue", "stale", "followup",
] as const;
const WATCH_PHRASES = [["keep", "an", "eye"], ["make", "sure"], ["check", "whether"], ["check", "that"], ["check", "if"], ["follow", "up"], ["watch", "for"]];
/** "Send the board update", "send a digest": regular production said with a verb. */
const SEND_OBJECTS = ["update", "digest", "recap", "report", "newsletter", "summary", "roundup"];

const stems = (words: readonly string[]) => new Set(words.map(normalizeWord));
const TIME_STEMS = stems(AUTOMATION_HINT_TIME_WORDS);
const EVERY_UNIT_STEMS = stems(EVERY_UNITS);
const PRODUCTION_STEMS = stems(AUTOMATION_HINT_PRODUCTION_WORDS);
const ARRIVAL_STEMS = stems(AUTOMATION_HINT_ARRIVAL_WORDS);
const WATCH_STEMS = stems(AUTOMATION_HINT_WATCH_WORDS);
const SEND_OBJECT_STEMS = stems(SEND_OBJECTS);
const SEND_STEM = normalizeWord("send");

/** The words of the first phrase found in `tokens`, as written, or null. */
function findPhrase(tokens: readonly Token[], phrases: readonly string[][]): string | null {
  for (const phrase of phrases) {
    const want = phrase.map(normalizeWord);
    for (let index = 0; index + want.length <= tokens.length; index += 1) {
      if (want.every((stem, offset) => tokens[index + offset]!.stem === stem)) {
        return tokens.slice(index, index + want.length).map((token) => token.raw).join(" ");
      }
    }
  }
  return null;
}

function findWord(tokens: readonly Token[], set: ReadonlySet<string>): string | null {
  return tokens.find((token) => set.has(token.stem))?.raw ?? null;
}

/** "every Monday", "each week": the phrase as written, or null. */
function findEvery(tokens: readonly Token[]): string | null {
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const stem = tokens[index]!.stem;
    if ((stem === "every" || stem === "each") && EVERY_UNIT_STEMS.has(tokens[index + 1]!.stem)) {
      return `${tokens[index]!.raw} ${tokens[index + 1]!.raw}`;
    }
  }
  return null;
}

/** "Send the board update": the words from "send" to the thing sent, or null. */
function findSendUpdate(tokens: readonly Token[]): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]!.stem !== SEND_STEM) continue;
    for (let end = index + 1; end < Math.min(tokens.length, index + 5); end += 1) {
      if (SEND_OBJECT_STEMS.has(tokens[end]!.stem)) return tokens.slice(index, end + 1).map((token) => token.raw).join(" ");
    }
  }
  return null;
}

/** The cadence a new automation starts on when nothing else suggests one. */
export const DEFAULT_ROUTINE_CADENCE: RoutineSuggestionCadence = { frequency: "weekly", dayOfWeek: "monday", dayOfMonth: null, time: "09:00" };
const DEFAULT_TIME = DEFAULT_ROUTINE_CADENCE.time;

const WEEKDAY_STEMS = new Map<string, RoutineSuggestionWeekday>(
  ROUTINE_SUGGESTION_WEEKDAYS.map((day) => [normalizeWord(day), day]),
);

/**
 * The cadence a title names, or null: a day name ("Monday metrics") is that
 * day every week; "weekday" every weekday; "daily", "nightly", "every day" or
 * "every morning" every day; "weekly" or "week" every Monday; "monthly" or
 * "month" the 1st of every month. Always at 9 AM. Quarterly, hourly and the
 * like have no cadence here: how often is left to settle.
 */
export function suggestCadenceFromTitle(title: string): RoutineSuggestionCadence | null {
  const tokenStems = titleTokens(title).map((token) => token.stem);
  const has = (...words: string[]) => words.some((word) => tokenStems.includes(normalizeWord(word)));
  const named = tokenStems.map((stem) => WEEKDAY_STEMS.get(stem)).find(Boolean);
  if (named) return { frequency: "weekly", dayOfWeek: named, dayOfMonth: null, time: DEFAULT_TIME };
  if (has("weekday")) return { frequency: "weekdays", dayOfWeek: null, dayOfMonth: null, time: DEFAULT_TIME };
  const everyDay = tokenStems.some((stem, index) => (stem === "every" || stem === "each")
    && ["day", "morning"].map(normalizeWord).includes(tokenStems[index + 1] ?? ""));
  if (has("daily", "nightly") || everyDay) return { frequency: "daily", dayOfWeek: null, dayOfMonth: null, time: DEFAULT_TIME };
  if (has("weekly", "week")) return { frequency: "weekly", dayOfWeek: "monday", dayOfMonth: null, time: DEFAULT_TIME };
  if (has("monthly", "month")) return { frequency: "monthly", dayOfWeek: null, dayOfMonth: 1, time: DEFAULT_TIME };
  return null;
}

/** Which part of the rule found the hint, strongest first. */
export const AUTOMATION_HINT_SIGNALS = ["time", "watch", "arrival", "production"] as const;
export type AutomationHintSignal = (typeof AUTOMATION_HINT_SIGNALS)[number];

/**
 * An instant, rule-based suggestion for how a manual task could be automated.
 * It is a hint the agent refines in the conversation, never a decision.
 */
export interface AutomationHint {
  trigger: AutomationTrigger;
  signal: AutomationHintSignal;
  /** The words in the title that suggest it, as written ("weekly", "keep an eye"). */
  words: string;
  /** For a schedule, the cadence the title names; null when it does not say how often. */
  cadence: RoutineSuggestionCadence | null;
  /** "Every Monday at 9 AM" for a named cadence, else null. */
  cadenceLabel: string | null;
  /** One plain, hedged line of why. */
  why: string;
}

/**
 * The trigger hint for a task, from its title alone, or null when the title
 * gives no signal (the person can still work it out with the agent).
 * Strongest first:
 * 1. a time ("weekly", "Monday", "every morning") → a schedule on that cadence;
 * 2. watching for a condition ("make sure", "overdue", "follow up", "chase",
 *    "waiting", "monitor") → a standing check on each wake-up;
 * 3. something arriving ("new", "incoming", "reply", "request", "ticket",
 *    "pull request", "alert", "when", "triage") → a webhook;
 * 4. regular production ("report", "review", "audit", "reconcile", "send the
 *    board update") → a schedule, how often still to settle.
 * Status and assignee do not change the hint; they rank the tasks (see
 * `rankAutomationCandidates`).
 */
export function automationHintForTask(task: { title: string }): AutomationHint | null {
  const tokens = titleTokens(task.title);
  const quote = (words: string) => `“${words}”`;
  const time = findEvery(tokens) ?? findWord(tokens, TIME_STEMS);
  if (time) {
    const cadence = suggestCadenceFromTitle(task.title);
    const cadenceLabel = cadence ? routineSuggestionCadenceLabel(cadence) : null;
    return {
      trigger: "schedule",
      signal: "time",
      words: time,
      cadence,
      cadenceLabel,
      why: cadenceLabel
        ? `The title says ${quote(time)}, so a schedule could fit: ${cadenceLabel.charAt(0).toLowerCase()}${cadenceLabel.slice(1)}.`
        : `The title says ${quote(time)}, so a schedule could fit; how often is still to settle.`,
    };
  }
  const watch = findPhrase(tokens, WATCH_PHRASES) ?? findWord(tokens, WATCH_STEMS);
  if (watch) {
    return {
      trigger: "standing_check",
      signal: "watch",
      words: watch,
      cadence: null,
      cadenceLabel: null,
      why: `It sounds like watching for something (${quote(watch)}), so a standing check on each wake-up could fit.`,
    };
  }
  const arrival = findPhrase(tokens, ARRIVAL_PHRASES) ?? findWord(tokens, ARRIVAL_STEMS);
  if (arrival) {
    return {
      trigger: "webhook",
      signal: "arrival",
      words: arrival,
      cadence: null,
      cadenceLabel: null,
      why: `It sounds like reacting to something coming in (${quote(arrival)}), so a webhook could start it.`,
    };
  }
  const production = findSendUpdate(tokens) ?? findWord(tokens, PRODUCTION_STEMS);
  if (production) {
    return {
      trigger: "schedule",
      signal: "production",
      words: production,
      cadence: null,
      cadenceLabel: null,
      why: `${quote(production)} usually comes round regularly, so a schedule could fit; how often is still to settle.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Which manual tasks to suggest first
// ---------------------------------------------------------------------------

/**
 * Why a manual task is listed, in order of strength: an agent already offered
 * to repeat it; the hint found a way to automate it; an agent finished it; it
 * was finished (by a person); an agent has it open; or just that it is open.
 */
export const AUTOMATION_CANDIDATE_REASONS = ["pending_offer", "hint", "done_by_agent", "done", "with_agent", "open"] as const;
export type AutomationCandidateReason = (typeof AUTOMATION_CANDIDATE_REASONS)[number];

export interface AutomationCandidateInput {
  id: string;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  /** When it was finished; null while open. */
  completedAt: Date | string | null;
  updatedAt: Date | string;
  hasPendingOffer: boolean;
}

function isDone(task: Pick<AutomationCandidateInput, "status">) {
  return task.status === "done";
}

export function automationCandidateReason(task: AutomationCandidateInput): AutomationCandidateReason {
  if (task.hasPendingOffer) return "pending_offer";
  if (automationHintForTask(task)) return "hint";
  if (isDone(task)) return task.assigneeAgentId ? "done_by_agent" : "done";
  return task.assigneeAgentId ? "with_agent" : "open";
}

function timeOf(value: Date | string | null): number {
  if (value === null) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * The manual tasks most worth automating first: an agent's pending offer,
 * then a task the hint has a suggestion for, then completed before open, then
 * with an agent before not; ties go to the most recent (finished, else
 * updated), then the id.
 */
export function rankAutomationCandidates<T extends AutomationCandidateInput>(tasks: readonly T[]): T[] {
  const keyed = tasks.map((task) => ({
    task,
    keys: [
      Number(task.hasPendingOffer),
      Number(automationHintForTask(task) !== null),
      Number(isDone(task)),
      Number(task.assigneeAgentId !== null),
    ],
    recent: timeOf(task.completedAt) || timeOf(task.updatedAt),
  }));
  keyed.sort((a, b) => {
    for (let index = 0; index < a.keys.length; index += 1) {
      const difference = b.keys[index]! - a.keys[index]!;
      if (difference !== 0) return difference;
    }
    return b.recent - a.recent || a.task.id.localeCompare(b.task.id);
  });
  return keyed.map(({ task }) => task);
}

/**
 * The agent responsible for automating a task: the agent the task is
 * assigned to; otherwise an agent already working under the responsibility;
 * otherwise the organization's first-created agent that can be assigned.
 * Each list holds only agents that can take work, in preference order.
 */
export function responsibleAutomationAgentId(input: {
  taskAgentId: string | null;
  agentsUnderResponsibility: readonly string[];
  firstAssignableAgentId: string | null;
  canTakeWork: (agentId: string) => boolean;
}): string | null {
  if (input.taskAgentId && input.canTakeWork(input.taskAgentId)) return input.taskAgentId;
  const working = input.agentsUnderResponsibility.find((id) => input.canTakeWork(id));
  return working ?? input.firstAssignableAgentId;
}

// ---------------------------------------------------------------------------
// The read: GET /companies/:companyId/responsibilities/automation
// ---------------------------------------------------------------------------

/** What a standing check found the last time its agent carried it out. */
export interface StandingCheckLastResult {
  checkedAt: string;
  outcome: StandingCheckOutcome;
  note: string | null;
  /** A task the agent created when it acted, if it named one. */
  issue: { id: string; identifier: string | null; title: string } | null;
}

/** How a running automation starts. A routine with several triggers shows its first (standing check, schedule, webhook). */
export type AutomationStart =
  | { kind: "schedule"; cadenceLabel: string | null; timezone: string | null; nextRunAt: string | null }
  | { kind: "webhook"; webhookUrl: string | null; signingMode: string | null; lastDeliveryAt: string | null }
  | { kind: "standing_check"; lastResult: StandingCheckLastResult | null }
  /** No trigger of its own: it runs when someone (or another system) asks. */
  | { kind: "on_request" };
export type AutomationStartKind = AutomationStart["kind"];

/** An automation that runs on its own: active, with an agent (that wakes up, for a standing check). */
export interface ResponsibilityAutomationItem {
  id: string;
  title: string;
  assigneeAgentId: string;
  start: AutomationStart;
  /** Further triggers beyond `start`. */
  otherStarts: number;
  lastRunAt: string | null;
}

/**
 * An automation filed here that does not run: paused, active with no agent,
 * or a standing check whose agent never wakes up on its own.
 */
export interface ResponsibilityAutomationStalled {
  id: string;
  title: string;
  status: RoutineStatus;
  assigneeAgentId: string | null;
  startKind: AutomationStartKind;
  reason: "paused" | "no_agent" | "no_wakeups";
}

/** An agent's pending offer (the `suggest_routine` card) on a finished task. */
export interface ResponsibilityRoutineOffer {
  interactionId: string;
  agentId: string | null;
  title: string;
  cadence: RoutineSuggestionCadence;
  cadenceLabel: string;
}

/** The conversation about automating a task, while it is open or has a proposal waiting. */
export interface AutomationConversationRef {
  issueId: string;
  identifier: string | null;
  agentId: string | null;
  state: "discussing" | "proposal_waiting";
}

/** A manual task that could be automated. */
export interface AutomationCandidate {
  issueId: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  completedAt: string | null;
  updatedAt: string;
  reason: AutomationCandidateReason;
  /** The instant suggestion, or null when the title gives no signal. */
  hint: AutomationHint | null;
  pendingOffer: ResponsibilityRoutineOffer | null;
  /** What the "set it up by hand" form starts on. */
  suggestedCadence: RoutineSuggestionCadence;
  cadenceSource: "offer" | "title" | "default";
  /** Who the conversation would be with; null when no agent in the organization can take it. */
  responsibleAgentId: string | null;
  conversation: AutomationConversationRef | null;
}

export interface ResponsibilityAutomation {
  responsibilityId: string;
  areaId: string | null;
  level: ResponsibilityAutomationLevel;
  /** 0–1, or null with neither automations nor manual tasks. */
  share: number | null;
  automationCount: number;
  manualTaskCount: number;
  openManualTaskCount: number;
  /** Nothing at all is filed under it (no project, task or routine). */
  nothingFiled: boolean;
  /** Up to `RESPONSIBILITY_AUTOMATION_ROUTINE_LIMIT`, by title. */
  automations: ResponsibilityAutomationItem[];
  stalledAutomations: ResponsibilityAutomationStalled[];
  /** Up to `RESPONSIBILITY_AUTOMATION_CANDIDATE_LIMIT`, most worth automating first. */
  candidates: AutomationCandidate[];
  /** Every manual task is a candidate; this is how many there are. */
  candidateTotal: number;
  /** Every manual task's id, most worth automating first, for marking rows elsewhere. */
  manualTaskIds: string[];
}

export interface ResponsibilityAutomationAreaTotals {
  areaId: string | null;
  /** Distinct across the area: an automation or task under two responsibilities counts once. */
  automations: number;
  manualTasks: number;
  share: number | null;
}

export interface ResponsibilityAutomationTotals {
  responsibilities: number;
  byLevel: Record<ResponsibilityAutomationLevel, number>;
  /** Distinct across everything the person owns. */
  automations: number;
  manualTasks: number;
  share: number | null;
}

export interface ResponsibilityAutomationOverview {
  ownerUserId: string;
  recentDays: number;
  responsibilities: ResponsibilityAutomation[];
  areas: ResponsibilityAutomationAreaTotals[];
  totals: ResponsibilityAutomationTotals;
}

// ---------------------------------------------------------------------------
// Setting an automation up by hand (a person's choice, not an agent's offer)
// ---------------------------------------------------------------------------

const NO_PLACEHOLDERS = (value: string) => !value.includes("{{");
const NO_PLACEHOLDERS_MESSAGE = "Write the text out in full; automations cannot use {{placeholders}}";

/** Body of POST /issues/:id/repeat-as-routine. */
export const createRoutineFromTaskSchema = z
  .object({
    /** What repeats; becomes the routine title. */
    title: z.string().trim().min(1).max(200).refine(NO_PLACEHOLDERS, "Write the title out in full; scheduled routines cannot use {{placeholders}}"),
    cadence: routineSuggestionCadenceSchema,
    assigneeAgentId: z.string().uuid(),
    /** The person's IANA time zone; defaults to their saved one, else UTC. */
    timezone: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type CreateRoutineFromTask = z.infer<typeof createRoutineFromTaskSchema>;

export interface RoutineFromTaskResult {
  routine: { id: string; title: string; assigneeAgentId: string | null; projectId: string | null; status: string };
  cadenceLabel: string;
  timezone: string;
  /** Responsibilities the routine was filed under. */
  responsibilityIds: string[];
  /** The agent's pending offer on the task that this settled, if there was one. */
  acceptedOfferId: string | null;
}

// ---------------------------------------------------------------------------
// The automation conversation: a person and an agent turn one manual task
// into an automation, ending in a proposal the person accepts with one tap
// ---------------------------------------------------------------------------

/** How the agent proposes the automation starts. */
export const automationProposalTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("schedule"),
    cadence: routineSuggestionCadenceSchema,
  }).strict(),
  z.object({
    kind: z.literal("webhook"),
    /** In words: what should call it, and when ("Our support desk, each time a ticket is opened"). */
    caller: z.string().trim().min(1).max(500),
  }).strict(),
  z.object({
    kind: z.literal("standing_check"),
    /** What the agent looks for on each wake-up. */
    lookFor: z.string().trim().min(1).max(1000),
    /** What it does when it finds it. */
    whenFound: z.string().trim().min(1).max(1000),
  }).strict(),
]);
export type AutomationProposalTrigger = z.infer<typeof automationProposalTriggerSchema>;

/** Body an agent sends from an automation conversation to propose one automation. */
export const createAutomationProposalSchema = z
  .object({
    /** What will be done each time; becomes the routine title. */
    title: z.string().trim().min(1).max(200).refine(NO_PLACEHOLDERS, NO_PLACEHOLDERS_MESSAGE),
    /** In full, what each time should do; becomes the routine's instructions. */
    instructions: z.string().trim().min(1).max(10_000).refine(NO_PLACEHOLDERS, NO_PLACEHOLDERS_MESSAGE),
    trigger: automationProposalTriggerSchema,
    /** One plain sentence to the person. */
    message: z.string().trim().min(1).max(500).optional().nullable(),
  })
  .strict();
export type CreateAutomationProposal = z.infer<typeof createAutomationProposalSchema>;

export const acceptAutomationProposalSchema = z
  .object({
    /** The person's IANA time zone, for a schedule; defaults to their saved one, else UTC. */
    timezone: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type AcceptAutomationProposal = z.infer<typeof acceptAutomationProposalSchema>;

export const declineAutomationProposalSchema = z.object({}).strict();
export type DeclineAutomationProposal = z.infer<typeof declineAutomationProposalSchema>;

/** Start (or reopen) the conversation about automating a task. Omit agentId for the responsible agent. */
export const startAutomationConversationSchema = z
  .object({
    agentId: z.string().uuid().optional(),
    /** The responsibility the person started from, for choosing the agent and the link back. */
    responsibilityId: z.string().uuid().optional(),
  })
  .strict();
export type StartAutomationConversation = z.infer<typeof startAutomationConversationSchema>;

/** The proposed trigger as the card carries it, with server-derived words. */
export type ProposedAutomationTrigger =
  | { kind: "schedule"; cadence: RoutineSuggestionCadence; cadenceLabel: string; cronExpression: string }
  | { kind: "webhook"; caller: string }
  | { kind: "standing_check"; lookFor: string; whenFound: string };

export interface ProposeAutomationPayload {
  version: 1;
  /** The manual task being automated. */
  sourceIssueId: string;
  sourceIdentifier: string | null;
  sourceTitle: string;
  title: string;
  instructions: string;
  message: string | null;
  trigger: ProposedAutomationTrigger;
  /** Server-derived plain words for how it starts: "Every Monday at 9 AM", "When another system calls it", "Each time Analyst wakes up". */
  startLabel: string;
  /** The conversation's agent, who runs it. */
  assigneeAgentId: string;
  agentName: string;
  /** Copied from the source task. */
  projectId: string | null;
  /** Where it will be filed: every responsibility the source task is under, when proposed. */
  filedUnder: Array<{ id: string; title: string }>;
}

/**
 * `replaced`: a newer proposal took its place. `issue_closed`: the conversation
 * was cancelled. `withdrawn` and `addressee_deleted` are the administrative
 * outcomes every conversation card can reach.
 */
export const PROPOSE_AUTOMATION_OUTCOMES = ["accepted", "declined", "replaced", "issue_closed", "withdrawn", "addressee_deleted"] as const;
export type ProposeAutomationOutcome = (typeof PROPOSE_AUTOMATION_OUTCOMES)[number];

export interface ProposeAutomationResult {
  version: 1;
  outcome: ProposeAutomationOutcome;
  reason?: string | null;
  replacedByInteractionId?: string | null;
  /** Set once an accepted proposal's automation exists. */
  routineId?: string | null;
  routineTitle?: string | null;
  triggerId?: string | null;
  cadenceLabel?: string | null;
  timezone?: string | null;
  /** For a webhook: the address to call and how calls are secured (the secret itself is shown once, never stored here). */
  webhookUrl?: string | null;
  signingMode?: string | null;
  responsibilityIds?: string[];
}

const proposedCadencePayloadSchema = z.object({
  frequency: z.enum(["daily", "weekdays", "weekly", "monthly"]),
  dayOfWeek: z.enum(ROUTINE_SUGGESTION_WEEKDAYS).nullable().optional(),
  dayOfMonth: z.number().int().nullable().optional(),
  time: z.string(),
});

export const proposeAutomationPayloadSchema = z.object({
  version: z.literal(1),
  sourceIssueId: z.string(),
  sourceIdentifier: z.string().nullable(),
  sourceTitle: z.string(),
  title: z.string(),
  instructions: z.string(),
  message: z.string().nullable(),
  trigger: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("schedule"), cadence: proposedCadencePayloadSchema, cadenceLabel: z.string(), cronExpression: z.string() }),
    z.object({ kind: z.literal("webhook"), caller: z.string() }),
    z.object({ kind: z.literal("standing_check"), lookFor: z.string(), whenFound: z.string() }),
  ]),
  startLabel: z.string(),
  assigneeAgentId: z.string(),
  agentName: z.string(),
  projectId: z.string().nullable(),
  filedUnder: z.array(z.object({ id: z.string(), title: z.string() })),
});

export const proposeAutomationResultSchema = z.object({
  version: z.literal(1),
  outcome: z.enum(PROPOSE_AUTOMATION_OUTCOMES),
  reason: z.string().nullable().optional(),
  replacedByInteractionId: z.string().nullable().optional(),
  routineId: z.string().nullable().optional(),
  routineTitle: z.string().nullable().optional(),
  triggerId: z.string().nullable().optional(),
  cadenceLabel: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  webhookUrl: z.string().nullable().optional(),
  signingMode: z.string().nullable().optional(),
  responsibilityIds: z.array(z.string()).optional(),
});

/** The plain words for how a proposed automation starts. */
export function automationStartLabel(trigger: AutomationProposalTrigger, agentName: string): string {
  switch (trigger.kind) {
    case "schedule":
      return routineSuggestionCadenceLabel(trigger.cadence);
    case "webhook":
      return "When another system calls it";
    case "standing_check":
      return `Each time ${agentName} wakes up`;
  }
}

/** Where a task's automation conversation stands. */
export const AUTOMATION_CONVERSATION_STATES = ["none", "discussing", "proposal_waiting", "settled"] as const;
export type AutomationConversationState = (typeof AUTOMATION_CONVERSATION_STATES)[number];

/** `GET`/`POST /api/issues/:id/automation-conversation`. */
export interface AutomationConversation {
  sourceIssueId: string;
  /**
   * `proposal_waiting`: a proposal waits for the person. `discussing`: the
   * conversation is open with nothing waiting. `settled`: the latest
   * conversation is finished, or its latest proposal was accepted. `none`:
   * there has been no conversation.
   */
  state: AutomationConversationState;
  /** The agent a new conversation would be held with; null when no agent can hold one. */
  defaultAgentId: string | null;
  /** The latest conversation that was not cancelled. */
  conversation: {
    issueId: string;
    identifier: string | null;
    title: string;
    status: string;
    agentId: string | null;
    createdAt: Date;
  } | null;
  /** The pending proposal, if any (at most one is pending at a time). */
  proposal: ProposeAutomationInteraction | null;
}

/** `POST /api/issues/:id/automation-proposals/:interactionId/accept`. */
export interface AcceptedAutomationProposal {
  interaction: ProposeAutomationInteraction;
  routine: { id: string; title: string; assigneeAgentId: string | null; projectId: string | null; status: string };
  /**
   * For a webhook only, and only in this response: the address, the secret
   * and how to send it. The secret is not stored on the card; a new one can
   * be made from the automation's page.
   */
  webhook: { url: string; secret: string; signingMode: string } | null;
}
