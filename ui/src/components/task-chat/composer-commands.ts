import { parseLeadingUserCommand } from "@paperclipai/shared";

/**
 * Slash commands typed in the task composer. What the signed-in user submits
 * here is the user-authored text `parseLeadingUserCommand` requires, and that
 * shared function is the one rule for a leading command. This module only
 * undoes editor artifacts first and turns a recognised command into an action.
 */

export type RunnerGoalComposerCommand =
  | { action: "focus" }
  | { action: "create"; objective: string }
  | { action: "edit" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "clear" };

export type ParsedRunnerGoalCommand =
  | { matched: false }
  | { matched: true; command: RunnerGoalComposerCommand }
  | { matched: true; error: string };

function normalizeActionCommandText(value: string, command: "goal" | "plan"): string {
  const trimmed = value.trim();
  // MDXEditor's link extension can reinterpret a selected action command plus
  // its subsequently typed argument as one relative autolink. Accept only the
  // exact whole-document shape it generates so the action still cannot fall
  // through as a comment. Ordinary Markdown links remain ordinary comments.
  // The label is any prefix of the command typed before it was selected.
  const label = command === "goal" ? "(?:go(?:al)?)?" : "(?:p(?:l(?:an?)?)?)?";
  const relativeAutolink = trimmed.match(
    new RegExp(`^\\[\\/${label}[ \\t\\u00a0]*\\]\\(<(\\/${command}(?:[ \\t\\u00a0].*)?)>\\)$`, "s"),
  );
  if (relativeAutolink) return relativeAutolink[1]!.replaceAll(" ", " ");

  const encodedAutolink = trimmed.match(
    new RegExp(`^\\[\\/${label}[ \\t\\u00a0]*\\]\\((\\/${command}(?:%20|%C2%A0).*)\\)$`, "s"),
  );
  if (encodedAutolink) {
    try {
      return decodeURIComponent(encodedAutolink[1]!).replaceAll(" ", " ");
    } catch {
      return trimmed;
    }
  }
  return trimmed.replaceAll(" ", " ");
}

/**
 * `/plan <request>` is the typed form of the Plan mode control: the request is
 * sent in Plan mode, without the command. A `/plan` anywhere else stays text.
 */
export function parsePlanCommand(value: string): { matched: false } | { matched: true; request: string } {
  const command = parseLeadingUserCommand(normalizeActionCommandText(value, "plan"), ["plan"]);
  return command ? { matched: true, request: command.argument } : { matched: false };
}

export type PlanSubmission =
  | { kind: "none" }
  /** Select Plan mode and send nothing. */
  | { kind: "switch_mode" }
  /** Send this text (possibly empty) in Plan mode. */
  | { kind: "send"; text: string };

/**
 * The one decision both submit paths use. A bare `/plan` sends only when the
 * message still carries something to plan from (an attachment that can be
 * sent without text); otherwise it only selects Plan mode.
 */
export function planSubmission(value: string, canSendWithoutText: boolean): PlanSubmission {
  const plan = parsePlanCommand(value);
  if (!plan.matched) return { kind: "none" };
  if (!plan.request && !canSendWithoutText) return { kind: "switch_mode" };
  return { kind: "send", text: plan.request };
}

export function parseRunnerGoalCommand(value: string): ParsedRunnerGoalCommand {
  const command = parseLeadingUserCommand(normalizeActionCommandText(value, "goal"), ["goal"]);
  if (!command) return { matched: false };
  const remainder = command.argument;
  if (!remainder) return { matched: true, command: { action: "focus" } };
  const [subcommand, ...extra] = remainder.split(/\s+/);
  if (["edit", "pause", "resume", "clear"].includes(subcommand!)) {
    if (extra.length > 0) {
      return { matched: true, error: `/goal ${subcommand} does not accept extra arguments.` };
    }
    return { matched: true, command: { action: subcommand as "edit" | "pause" | "resume" | "clear" } };
  }
  return { matched: true, command: { action: "create", objective: remainder } };
}
