import { and, eq, isNull, sql } from "drizzle-orm";
import { issueComments, type Db } from "@paperclipai/db";

export const HELD_TASK_INPUT_NOTICE_KIND = "held_task_input_deferred";

type HeldTaskInput = "agent_comment" | "check_in" | "blocker_resolved" | "wake";

/** Names the deferred input in words its sender and the task's people read. */
export function classifyHeldTaskInput(input: {
  requestedByActorType: string | null | undefined;
  reason: string | null | undefined;
  contextSource: unknown;
  wakeCommentId: string | null | undefined;
}): HeldTaskInput {
  if (input.contextSource === "issue.monitor" || input.reason === "issue_monitor_due") return "check_in";
  if (input.reason === "issue_blockers_resolved" || input.reason === "issue_children_completed") return "blocker_resolved";
  if (input.wakeCommentId && input.requestedByActorType === "agent") return "agent_comment";
  return "wake";
}

const INPUT_LABEL: Record<HeldTaskInput, string> = {
  agent_comment: "An agent's comment on this task did not start a run.",
  check_in: "A scheduled check-in on this task did not start a run.",
  blocker_resolved: "A blocker of this task closed, but that did not start a run.",
  wake: "A request to work on this task did not start a run.",
};

/**
 * Only a person can continue a task held after a run whose outcome is
 * uncertain. Input from agents, check-ins and closed blockers waits on that
 * person, so say so on the task once per hold instead of deferring silently.
 * A person's own message continues the task and needs no notice.
 */
export async function recordHeldTaskInputNotice(db: Pick<Db, "select" | "insert">, input: {
  companyId: string;
  issueId: string;
  recoveryActionId: string | null;
  nextAction: string;
  requestedByActorType: string | null | undefined;
  reason: string | null | undefined;
  contextSource: unknown;
  wakeCommentId: string | null | undefined;
}): Promise<boolean> {
  if (!input.recoveryActionId || input.requestedByActorType === "user") return false;
  const [existing] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    isNull(issueComments.deletedAt), eq(issueComments.authorType, "system"),
    sql`${issueComments.metadata}->'sections' @> ${JSON.stringify([{ rows: [
      { label: "Cause", value: HELD_TASK_INPUT_NOTICE_KIND },
      { label: "Recovery action", value: input.recoveryActionId },
    ] }])}::jsonb`,
  )).limit(1);
  if (existing) return false;
  const kind = classifyHeldTaskInput(input);
  await db.insert(issueComments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    authorType: "system",
    body: `${INPUT_LABEL[kind]} ` +
      "This task's last run stopped in a way Paperclip does not repeat by itself, so only a person can continue it. " +
      `${input.nextAction} New input waits until then.`,
    presentation: { kind: "system_notice", tone: "warning", title: "Waiting for a person to continue",
      detailsDefaultOpen: false, density: "compact" },
    metadata: { version: 1, sections: [{ title: "Recovery", rows: [
      { type: "key_value", label: "Cause", value: HELD_TASK_INPUT_NOTICE_KIND },
      { type: "key_value", label: "Recovery action", value: input.recoveryActionId },
      { type: "key_value", label: "Input", value: kind },
    ] }] },
  });
  return true;
}
