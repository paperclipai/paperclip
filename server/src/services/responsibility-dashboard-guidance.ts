import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, issueThreadInteractions, issues, responsibilities, responsibilityAreas } from "@paperclipai/db";
import {
  RESPONSIBILITY_DASHBOARD_ORIGIN_KIND,
  RESPONSIBILITY_DASHBOARD_SENTENCE_MAX,
  responsibilityDashboardSentence,
  type ProposeDashboardChangesPayload,
  type ResponsibilityDashboardMode,
} from "@paperclipai/shared";

/**
 * The standing instructions for the agent in a person's dashboard
 * conversation. They ride on the per-task prompt (legacy adapters and native
 * runners alike), because native agents do not receive the paperclip skill,
 * and they differ by mode. This module reads only rows, so the heartbeat can
 * import it without the services behind the conversation itself
 * (responsibility-dashboard.ts).
 */

const PROPOSAL_HISTORY = 3;
const OTHER_AREA_LIMIT = 40;

export interface DashboardGuidanceArea {
  id: string;
  title: string;
  /** How many other people have responsibilities in it. */
  others: number;
  /** This person's active responsibilities in it. */
  items: Array<{ id: string; sentence: string }>;
}

export interface DashboardGuidanceInput {
  issueId: string;
  companyId: string;
  ownerUserId: string;
  ownerName: string | null;
  mode: ResponsibilityDashboardMode;
  /** Areas the person has something in, in dashboard order. */
  areas: DashboardGuidanceArea[];
  /** The person's active responsibilities filed under no area. */
  unfiled: Array<{ id: string; sentence: string }>;
  /** Other live areas in the organization. */
  otherAreas: Array<{ id: string; title: string; others: number }>;
  /** Responsibilities proposed earlier that wait for the person. */
  proposed: string[];
  /** Newest first. */
  proposals: Array<{ changes: number; state: string }>;
}

/**
 * Null unless the task is a dashboard conversation assigned to this agent.
 * The caller checks the experimental flag. A fixed number of queries.
 */
export async function loadDashboardConversationGuidance(db: Db, input: {
  issue: { id: string; companyId: string; originKind: string | null; originId: string | null; assigneeAgentId: string | null };
  agentId: string;
}): Promise<string | null> {
  const { issue } = input;
  if (issue.originKind !== RESPONSIBILITY_DASHBOARD_ORIGIN_KIND || !issue.originId || issue.assigneeAgentId !== input.agentId) {
    return null;
  }
  const ownerUserId = issue.originId;
  const [issueRow, owner, items, areaRows, others, history] = await Promise.all([
    db.select({ originFingerprint: issues.originFingerprint }).from(issues)
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)))
      .then((rows) => rows[0] ?? null),
    db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, ownerUserId))
      .then((rows) => rows[0] ?? null),
    db.select({
      id: responsibilities.id,
      title: responsibilities.title,
      standard: responsibilities.standard,
      areaId: responsibilities.areaId,
      status: responsibilities.status,
    }).from(responsibilities).where(and(
      eq(responsibilities.companyId, issue.companyId),
      eq(responsibilities.ownerUserId, ownerUserId),
      inArray(responsibilities.status, ["active", "proposed"]),
    )).orderBy(responsibilities.sortOrder, responsibilities.createdAt),
    db.select({ id: responsibilityAreas.id, title: responsibilityAreas.title, status: responsibilityAreas.status })
      .from(responsibilityAreas)
      .where(eq(responsibilityAreas.companyId, issue.companyId))
      .orderBy(responsibilityAreas.sortOrder, sql`lower(${responsibilityAreas.title})`),
    db.select({ areaId: responsibilities.areaId, count: sql<number>`count(distinct ${responsibilities.ownerUserId})::int` })
      .from(responsibilities).where(and(
        eq(responsibilities.companyId, issue.companyId),
        ne(responsibilities.ownerUserId, ownerUserId),
        inArray(responsibilities.status, ["active", "proposed"]),
      )).groupBy(responsibilities.areaId),
    db.select({ status: issueThreadInteractions.status, payload: issueThreadInteractions.payload, result: issueThreadInteractions.result })
      .from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, issue.companyId),
        eq(issueThreadInteractions.issueId, issue.id),
        eq(issueThreadInteractions.kind, "propose_dashboard_changes"),
      )).orderBy(desc(issueThreadInteractions.createdAt)).limit(PROPOSAL_HISTORY),
  ]);
  if (!issueRow) return null;
  const othersByArea = new Map(others.filter((row) => row.areaId).map((row) => [row.areaId!, row.count]));
  const active = items.filter((item) => item.status === "active");
  const mine = new Set(active.map((item) => item.areaId).filter((id): id is string => id !== null));
  const areas: DashboardGuidanceArea[] = areaRows
    .filter((area) => mine.has(area.id))
    .map((area) => ({
      id: area.id,
      title: area.title,
      others: othersByArea.get(area.id) ?? 0,
      items: active.filter((item) => item.areaId === area.id).map((item) => ({ id: item.id, sentence: responsibilityDashboardSentence(item) })),
    }));
  return buildDashboardConversationGuidance({
    issueId: issue.id,
    companyId: issue.companyId,
    ownerUserId,
    ownerName: owner?.name?.trim() || null,
    mode: issueRow.originFingerprint === "edit" ? "edit" : "create",
    areas,
    unfiled: active.filter((item) => item.areaId === null).map((item) => ({ id: item.id, sentence: responsibilityDashboardSentence(item) })),
    otherAreas: areaRows
      .filter((area) => area.status !== "archived" && !mine.has(area.id))
      .slice(0, OTHER_AREA_LIMIT)
      .map((area) => ({ id: area.id, title: area.title, others: othersByArea.get(area.id) ?? 0 })),
    proposed: items.filter((item) => item.status === "proposed").map((item) => responsibilityDashboardSentence(item)),
    proposals: history.map((entry) => {
      const payload = entry.payload as Partial<ProposeDashboardChangesPayload> | null;
      const result = entry.result as { outcome?: string; dropped?: number[] | null } | null;
      const dropped = result?.dropped?.length ?? 0;
      return {
        changes: payload?.changes?.length ?? 0,
        state: entry.status === "pending" ? "waiting for the person"
          : result?.outcome === "declined" ? "the person said it is not right"
            : result?.outcome === "replaced" ? "replaced by a later proposal"
              : result?.outcome === "accepted"
                ? dropped > 0 ? `applied without ${dropped === 1 ? "1 change" : `${dropped} changes`} the person dropped` : "applied"
                : "closed",
      };
    }),
  });
}

function shared(others: number) {
  return others === 0 ? "" : `; ${others === 1 ? "1 other person has" : `${others} other people have`} responsibilities in it`;
}

const CREATE_EXAMPLE = {
  message: "Here is a first dashboard from your answers and what I found in your calendar and mail.",
  changes: [
    { op: "add_area", ref: "fundraising", name: "Fundraising" },
    { op: "add_responsibility", areaRef: "fundraising", sentence: "Every prospective LP hears from us at least every two weeks.", reason: "You run the weekly fundraising sync and have 14 open LP threads." },
    { op: "add_area", ref: "portfolio", name: "Portfolio" },
    { op: "add_responsibility", areaRef: "portfolio", sentence: "Every portfolio company gets its quarterly update on time." },
  ],
};

const EDIT_EXAMPLE = {
  message: "Two small changes from what you asked.",
  changes: [
    { op: "reword_responsibility", responsibilityId: "<responsibilityId>", sentence: "Customers get a reply within one working day.", reason: "You said a day is the promise, not four hours." },
    { op: "remove_responsibility", responsibilityId: "<responsibilityId>", reason: "Hiring for the role is done, so this was a project that finished." },
  ],
};

/** Pure: the dashboard-conversation instructions for the agent's per-task prompt. */
export function buildDashboardConversationGuidance(input: DashboardGuidanceInput): string {
  const person = input.ownerName ?? "the person";
  const creating = input.mode === "create";
  const lines: string[] = [
    `This task is a conversation with ${person} about their Dashboard: the areas they care about and, under each, the responsibilities they own. ${creating
      ? "They asked you to research and interview them and draft their first dashboard."
      : "They asked you to help change the dashboard they have."} End it with one proposed set of changes they can accept with one tap. You never change the dashboard yourself: only the person can, by accepting your proposal, and they can undo it afterwards.`,
    "",
    "What a dashboard is made of (reason from this, not only from the rules):",
    "- An area is a noun for something the person cares about: \"Fundraising\", \"Customers\", \"Hiring\". Nobody owns an area and it has no deadline; it groups what sits under it. Areas are shared across the organization, so other people may have responsibilities in the same area.",
    "- A responsibility is something this person owns and answers for, on an ongoing basis. Write it as one sentence saying what must be true and stay true: \"Every prospective LP hears from us at least every two weeks.\" \"Customers get a reply within one working day.\" If it can be finished, it is a task or a project, not a responsibility: \"Send the deck to two LPs\" is a task, and \"Close Fund VI\" is a project that serves a responsibility.",
    "- Each responsibility passes three tests. Ongoing: it still makes sense after the current project ships. Theirs: they answer for it, not just take part in it (attending a meeting series is not owning it; running it is). In their words: the words their answers, mail subjects and calendar titles use, not job-description words.",
    `- Keep it small. A person can hold perhaps five to seven areas in their head, and one to three responsibilities under each is plenty. A few that are right beat a full list: every line is something they will look at every day, and a list that is mostly wrong teaches them to ignore it. Each sentence is at most ${RESPONSIBILITY_DASHBOARD_SENTENCE_MAX} characters.`,
    "- Reuse an area that already exists in the organization under a close name (\"Recruiting\" when they said \"Hiring\") instead of adding a near-duplicate.",
    "- Never propose removing something without saying why in its reason. Removing is gentle (a responsibility is let go and an area archived; everything filed under them is kept and can come back), but the person decides, and they need your reason to decide.",
    "- Do not argue with something they removed, dropped from a proposal or said no to, and do not propose it again under another name unless they ask.",
    "",
    `${person === "the person" ? "Their" : `${person}'s`} dashboard today:`,
  ];
  if (input.areas.length === 0 && input.unfiled.length === 0) {
    lines.push("- Empty: they own no responsibilities yet.");
  }
  for (const area of input.areas) {
    lines.push(`- Area "${area.title}" (areaId ${area.id}${shared(area.others)}):`);
    for (const item of area.items) lines.push(`  - "${item.sentence}" (responsibilityId ${item.id})`);
  }
  if (input.unfiled.length > 0) {
    lines.push("- Under no area:");
    for (const item of input.unfiled) lines.push(`  - "${item.sentence}" (responsibilityId ${item.id})`);
  }
  if (input.otherAreas.length > 0) {
    lines.push("", "Other areas in the organization (file under one by its areaId rather than adding a near-duplicate):");
    for (const area of input.otherAreas) lines.push(`- "${area.title}" (areaId ${area.id}${shared(area.others)})`);
  }
  if (input.proposed.length > 0) {
    lines.push("", "Proposed to them earlier and still waiting for them (do not propose these again):");
    for (const sentence of input.proposed) lines.push(`- "${sentence}"`);
  }
  if (input.proposals.length > 0) {
    lines.push("", "Your proposals in this conversation, newest first:");
    for (const proposal of input.proposals) lines.push(`- ${proposal.changes === 1 ? "1 change" : `${proposal.changes} changes`}: ${proposal.state}`);
  }
  lines.push("");
  if (creating) {
    lines.push(
      "How to hold the conversation (create):",
      "1. The conversation opens with a short interview card: their role, what they care about, where they are most behind, anything to stay out of, and whether you may look them up on the public web. Wait for their answers; you are woken when they answer or reply. If there is no such card, post one questions card with those questions (request_human_input with interactionKind \"questions\" on a native runner, otherwise an ask_user_questions interaction) with continuationPolicy wake_assignee, and ask the lookup question last with \"No\" as the first choice.",
      `2. Before you draft, read what the organization already contains: its projects, tasks and routines (GET /api/companies/${input.companyId}/issues, /projects and /routines), the areas above, and the data of any connected account you can read (mail, calendar, code hosting, team chat; on a native runner, connections_search shows which you can use). Look for standing duties, recurring meetings they run, threads they own and promises with dates. Read, never act: never send, reply, accept, decline, archive, label, edit or delete anything in their accounts. Stay out of anything they named under \"stay out of\". Say in one line which accounts you could read and which you could not.`,
      "3. Looking them up on the public web: only when they answered \"Yes, look me up\" to the lookup question. No answer, or \"No\", means no: do not search for them at all, and do not ask again. When it is yes: only this person; public pages only, nothing behind a login; no people-search or data-broker sites, paid lookups, background checks or breach data; only work facts (role, organisation, what they are publicly responsible for); never record a home address, phone number, date of birth, or anything about health, religion, sexuality or politics; at most about 15 searches and page fetches. If two people could be them and you cannot tell which, use neither.",
      "4. Draft a first dashboard. Areas: one for each thing they said they care about, named as a noun in their words, plus one only when the evidence shows something large they did not pick. Under each, the few responsibilities you believe are theirs, each one sentence of what must be true; where they said they are behind is likely one of them. Leave out an area you cannot draft anything for, and say so in one line.",
      "5. Propose it with the call below: add_area for each new area, then add_responsibility under it by its ref; file under an existing area by its areaId. Give a reason wherever it is not obvious from their answers (what you saw that makes it theirs). Then post one short line saying the proposal is ready, and mark this task done. The card stays open for them after the task is done.",
      "6. If they say it is not right, or reply, you are woken here: ask what to change, or propose again. A new proposal replaces the waiting one, so there is only ever one.",
    );
  } else {
    lines.push(
      "How to hold the conversation (edit):",
      "1. Open with one or two sentences on what you see in the dashboard above. Unless they already said what they want, ask what they want changed, in one questions card with at most three short questions they can tap to answer (request_human_input with interactionKind \"questions\" on a native runner, otherwise an ask_user_questions interaction) and continuationPolicy wake_assignee.",
      "2. You may also suggest changes from what you have seen in the work: projects, tasks and routines that serve no responsibility, a responsibility nothing happens under, two that say the same thing, one worded as a task that can be finished, an area with too much or nothing in it. Read, never act. Look them up on the public web only if they ask you to in this conversation.",
      "3. Propose with the call below. Keep it small: only what they asked for and what you can justify; leave everything else as it is.",
      "4. Then post one short line saying the proposal is ready, and mark this task done. The card stays open for them after the task is done. If they say it is not right, or reply, you are woken here: ask what to change, or propose again. A new proposal replaces the waiting one.",
    );
  }
  lines.push(
    "",
    "The changes, as an ordered list (each may carry a one-line reason; removals must):",
    "- { op: \"add_area\", ref, name }: ref is your own short key for the new area, used by later changes in the same list.",
    "- { op: \"rename_area\", areaId, name }: it is renamed for everyone with responsibilities in it.",
    "- { op: \"remove_area\", areaId, reason }: archives it and lets go of this person's responsibilities still in it (move any worth keeping). Refused when other people have responsibilities in it.",
    "- { op: \"add_responsibility\", areaId or areaRef, sentence }: one sentence of what must be true.",
    "- { op: \"reword_responsibility\", responsibilityId, sentence }",
    "- { op: \"move_responsibility\", responsibilityId, areaId or areaRef }",
    "- { op: \"remove_responsibility\", responsibilityId, reason }: it is let go, not deleted.",
    "The person sees the changes grouped by area, each with your reason, and may drop any of them before accepting (dropping a new area drops what you filed under it). Every change they accept is saved as a version they can go back to.",
    "",
    "The call:",
    `POST /api/issues/${input.issueId}/dashboard-changes (native runner: call_api with operationId "POST /api/issues/{id}/dashboard-changes" and this task's id) with { message (optional, one plain sentence to the person), changes }. Example: ${JSON.stringify(creating ? CREATE_EXAMPLE : EDIT_EXAMPLE)}`,
    `For more than the list above: GET /api/companies/${input.companyId}/responsibilities?ownerUserId=${input.ownerUserId} and GET /api/companies/${input.companyId}/responsibility-areas.`,
    "201 shows the card in this conversation. 400 or 422 says what is wrong with the changes: fix them and send again. 409 means this conversation was cancelled, and 404 that the feature is off: say so and stop. Use plain words with the person: dashboard, area, responsibility, task; never issue, interaction, op or field names, and never the ids above.",
  );
  return lines.join("\n");
}
