import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, authUsers, issueThreadInteractions, issues, responsibilities, responsibilityLinks } from "@paperclipai/db";
import {
  AUTOMATION_CONVERSATION_ORIGIN_KIND,
  automationHintForTask,
  type ProposeAutomationPayload,
} from "@paperclipai/shared";
import { asNumber, parseObject } from "../adapters/utils.js";
import { agentWakesOnItsOwn } from "./routine-standing-checks.js";

/**
 * The standing instructions for the agent in an automation conversation: a
 * task a person opens to turn one of their manual tasks into an automation.
 * They ride on the per-task prompt (legacy adapters and native runners alike),
 * because native agents do not receive the paperclip skill. This module reads
 * only rows, so the heartbeat can import it without the services behind the
 * conversation itself (responsibility-automation-conversations.ts).
 */

const PROPOSAL_HISTORY = 3;
const DESCRIPTION_LIMIT = 1500;

/** "every 30 minutes", "every 2 hours", "every day". */
export function heartbeatIntervalWords(intervalSec: number): string {
  if (intervalSec <= 0) return "never";
  const minutes = Math.round(intervalSec / 60);
  if (minutes < 60) return minutes <= 1 ? "every minute" : `every ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "every hour" : `every ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "every day" : `every ${days} days`;
}

/** Null unless the task is an automation conversation assigned to this agent and the task it automates still exists. The caller checks the flag. */
export async function loadAutomationConversationGuidance(db: Db, input: {
  issue: { id: string; companyId: string; originKind: string | null; originId: string | null; assigneeAgentId: string | null };
  agentId: string;
}): Promise<string | null> {
  const { issue } = input;
  if (issue.originKind !== AUTOMATION_CONVERSATION_ORIGIN_KIND || !issue.originId || issue.assigneeAgentId !== input.agentId) {
    return null;
  }
  const [source] = await db.select().from(issues)
    .where(and(eq(issues.id, issue.originId), eq(issues.companyId, issue.companyId)));
  if (!source) return null;
  const [conversation] = await db.select({ createdByUserId: issues.createdByUserId }).from(issues)
    .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
  const [agent, person, filed, history] = await Promise.all([
    db.select({ name: agents.name, adapterType: agents.adapterType, status: agents.status, runtimeConfig: agents.runtimeConfig })
      .from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, issue.companyId)))
      .then((rows) => rows[0] ?? null),
    conversation?.createdByUserId
      ? db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, conversation.createdByUserId)).then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    db.selectDistinct({ title: responsibilities.title }).from(responsibilityLinks)
      .innerJoin(responsibilities, eq(responsibilities.id, responsibilityLinks.responsibilityId))
      .where(and(
        eq(responsibilityLinks.companyId, issue.companyId),
        inArray(responsibilities.status, ["proposed", "active"]),
        source.projectId
          ? or(eq(responsibilityLinks.issueId, source.id), eq(responsibilityLinks.projectId, source.projectId))
          : eq(responsibilityLinks.issueId, source.id),
      )),
    db.select({
      status: issueThreadInteractions.status,
      payload: issueThreadInteractions.payload,
      result: issueThreadInteractions.result,
    }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, issue.companyId),
      eq(issueThreadInteractions.issueId, issue.id),
      eq(issueThreadInteractions.kind, "propose_automation"),
    )).orderBy(desc(issueThreadInteractions.createdAt)).limit(PROPOSAL_HISTORY),
  ]);
  if (!agent) return null;
  const heartbeat = parseObject(parseObject(agent.runtimeConfig).heartbeat);
  const hint = automationHintForTask(source);
  return buildAutomationConversationGuidance({
    issueId: issue.id,
    personName: person?.name?.trim() || null,
    agentName: agent.name,
    standingChecksAvailable: agentWakesOnItsOwn(agent),
    heartbeatInterval: heartbeatIntervalWords(Math.max(0, asNumber(heartbeat.intervalSec, 0))),
    task: {
      identifier: source.identifier,
      title: source.title,
      description: source.description,
      status: source.status,
      withAgent: source.assigneeAgentId !== null,
      filedUnder: filed.map((row) => row.title),
      hint: hint?.why ?? null,
    },
    proposals: history.map((entry) => {
      const payload = entry.payload as Partial<ProposeAutomationPayload> | null;
      const result = entry.result as { outcome?: string } | null;
      return {
        title: payload?.title ?? "",
        start: payload?.startLabel ?? "",
        state: entry.status === "pending" ? "waiting for the person"
          : result?.outcome === "declined" ? "the person said it is not right"
            : result?.outcome === "replaced" ? "replaced by a later proposal"
              : result?.outcome === "accepted" ? "accepted and set up"
                : "closed",
      };
    }),
  });
}

export interface AutomationConversationGuidanceInput {
  issueId: string;
  personName: string | null;
  agentName: string;
  /** Whether this agent wakes up on its own, so a standing check would run. */
  standingChecksAvailable: boolean;
  /** "every 30 minutes". */
  heartbeatInterval: string;
  task: {
    identifier: string | null;
    title: string;
    description: string | null;
    status: string;
    withAgent: boolean;
    filedUnder: string[];
    /** The instant hint the person saw, or null. */
    hint: string | null;
  };
  /** Newest first. */
  proposals: Array<{ title: string; start: string; state: string }>;
}

/** Pure: the automation-conversation instructions for the agent's per-task prompt. */
export function buildAutomationConversationGuidance(input: AutomationConversationGuidanceInput): string {
  const person = input.personName ?? "the person";
  const { task } = input;
  const lines: string[] = [
    `This task is a conversation with ${person} about turning one of their manual tasks into an automation that runs without them. End it with ONE proposed automation they can accept with one tap. You never set it up yourself: only the person can, by accepting your proposal.`,
    "",
    "The task to automate:",
    `- Title: ${task.title}${task.identifier ? ` (${task.identifier})` : ""}`,
    `- Status: ${task.status}${task.withAgent ? ", with an agent" : ", done by hand"}`,
  ];
  const description = task.description?.trim();
  if (description) {
    lines.push(`- What it says: ${description.length > DESCRIPTION_LIMIT ? `${description.slice(0, DESCRIPTION_LIMIT)}…` : description}`);
  }
  if (task.filedUnder.length > 0) lines.push(`- Filed under the responsibilities: ${task.filedUnder.join(", ")}`);
  lines.push(task.hint
    ? `- The quick suggestion the person saw (a guess from the title; confirm or change it): ${task.hint}`
    : "- The person saw no quick suggestion: the title did not say how it could start.");
  if (input.proposals.length > 0) {
    lines.push("", "Your proposals in this conversation, newest first:");
    for (const proposal of input.proposals) lines.push(`- "${proposal.title}" (${proposal.start}): ${proposal.state}`);
  }
  lines.push(
    "",
    "How to hold the conversation:",
    "1. Open with one or two sentences saying what you understand the task to be and how it could run without them.",
    "2. Ask at most two short questions, only what you cannot work out yourself, in one questions card (request_human_input with interactionKind \"questions\" on a native runner, otherwise an ask_user_questions interaction) with continuationPolicy wake_assignee. Prefer choices the person can tap over free text. Skip the questions when you already know enough.",
    "3. Propose one automation with the call below. Then post one short line saying the proposal is ready, and mark this task done. The card stays open for the person after the task is done.",
    "4. If the person says the proposal is not right, or replies, you are woken here: ask what to change, or propose again. A new proposal replaces the waiting one, so there is only ever one.",
    "",
    "How it can start (pick the one that fits the work):",
    "- schedule: on a cadence, for work that comes round at known times (a weekly report, a monthly reconciliation). trigger { kind: \"schedule\", cadence: { frequency: daily | weekdays | weekly | monthly, dayOfWeek for weekly (monday..sunday), dayOfMonth for monthly (1-28), time \"HH:MM\" in the person's local time } }.",
    "- webhook: when another system calls in, for work that reacts to something arriving (a new ticket, a form submitted, a pull request opened). trigger { kind: \"webhook\", caller: in words, what should call it and when }. After accepting, the person gets the address to call and the secret to give that system; each call starts one run.",
  );
  if (input.standingChecksAvailable) {
    lines.push(`- standing_check: you carry it out each time your heartbeat wakes you (${input.heartbeatInterval}), for work that watches for a condition (something overdue, waiting too long, stale). No task is created unless you find something. trigger { kind: "standing_check", lookFor: what you look for, whenFound: what you do when you find it }.`);
  } else {
    lines.push("- standing_check is not available: you do not wake up on your own (no heartbeat), so a standing check would never run. For watching work, propose a schedule that checks at sensible times instead.");
  }
  lines.push(
    "",
    "What makes a good automation:",
    "- title says what is done each time, in a few words (\"Triage new support tickets\").",
    "- instructions stand on their own: what each time should do and deliver, written out in full, with no {{placeholders}}. Each run starts fresh from them.",
    "- It does the work the person did by hand, no more. If part of it needs their judgement, say in the instructions what you will hand back to them.",
    `- You (${input.agentName}) run it; it is filed under the same responsibilities as the task.`,
    "",
    "The call:",
    `POST /api/issues/${input.issueId}/automation-proposals (native runner: call_api with operationId "POST /api/issues/{id}/automation-proposals" and this task's id) with { title, instructions, trigger, message (optional, one plain sentence to the person) }. Examples:`,
    `- ${JSON.stringify({ title: "Send the weekly investor update", instructions: "Collect this week's pipeline changes and send the update to the investor list.", trigger: { kind: "schedule", cadence: { frequency: "weekly", dayOfWeek: "friday", time: "16:00" } } })}`,
    `- ${JSON.stringify({ title: "Triage new support tickets", instructions: "Read the new ticket, label it by product area and urgency, and assign it.", trigger: { kind: "webhook", caller: "The help desk, each time a ticket is opened" } })}`,
  );
  if (input.standingChecksAvailable) {
    lines.push(`- ${JSON.stringify({ title: "Chase candidates waiting on us", instructions: "Look through open hiring tasks for candidates who have waited more than two days for a reply.", trigger: { kind: "standing_check", lookFor: "Candidates waiting more than two days for a reply", whenFound: "Draft the reply and create a task for the hiring manager to send it" } })}`);
  }
  lines.push(
    "201 shows the card in this conversation. 400 or 422 says what is wrong: fix it and send again. 409 means this conversation was cancelled or the task was already automated, and 404 that the feature is off: say so and stop. Use plain words with the person: task, automation, schedule, webhook, standing check; never issue, interaction, cron, trigger or field names.",
  );
  return lines.join("\n");
}
