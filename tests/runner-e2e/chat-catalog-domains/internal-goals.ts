import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { project, task, goal, putDocument, entity, observation, checks, hasLink, sameTask, internalResultLink, type Entity, type InternalObservation } from "./internal-support.js";
import { makeDefinition, retryDefinition, fixtureWorker } from "./internal-definition.js";

export function grade_goals(value: unknown) {
  const c = checks(); const o = observation(value);
  c.add("complete-independent-observation", !!o, "Missing API, document, audit or rendered-link evidence cannot pass.");
  if (!o) return c.result();
  const before = o.state.task ? entity(o.state, "task") : undefined;
  const current = before && o.tasks.find(row => row.id === before.id);
  const savedProject = o.state.project ? entity(o.state, "project") : undefined;
  const projectNow = savedProject && o.projects.find(row => row.id === savedProject.id);
  const authored = (action: string, id: string) => o.activity.some(row => row.action === action && row.entityId === id && row.agentId === o.leadId);
  const linkedTask = () => !!current && hasLink(o, "issues", current);
  switch (o.scenarioId) {
    case "goals.create-goal-tree": {
      const companyGoals = o.goals.filter(isSignupCompanyGoal);
      const teamGoals = o.goals.filter(isWebsiteTeamGoal);
      c.add("one-requested-tree", o.goals.length === 2 && companyGoals.length === 1 && teamGoals.length === 1
        && teamGoals[0]?.parentId === companyGoals[0]?.id && companyGoals[0]?.parentId == null
        && o.goals.every(row => row.companyId === o.companyId), "The two saved goals have exact levels, a valid parent and company scope.");
      c.add("attributed-goal-creation", o.goals.length === 2 && o.goals.every(row => authored("goal.created", row.id)), "Both requested goals were created by the CEO through the production path.");
      c.add("optional-goal-owner-valid", validGoalOwners(o), "Unrequested ownership may remain unassigned; every assigned owner must be an independently listed same-company agent.");
      const inspection = o.state.hierarchyInspection as GoalHierarchyInspection | undefined;
      const root = o.goals.find(row => row.level === "company"), child = o.goals.find(row => row.level === "team");
      c.add("saved-hierarchy-inspectable", o.goals.length === 2 && inspection?.companyId === o.companyId
        && inspection.rootId === root?.id && inspection.childId === child?.id && inspection.readbackMatched === true
        && inspection.rootVisible === true && inspection.childVisible === true,
        "Independent public readback and the ordinary Goals list, parent and child pages expose the actual saved hierarchy; a particular chat-link format is not required.");
      c.add("retry-reuses-first-tree", initialGoalTreeCreation(observation(o.state.firstCreation)) && Array.isArray(o.state.firstIds) && o.state.firstIds.length === 2
        && o.goals.every(row => (o.state.firstIds as string[]).includes(row.id))
        && o.humanQueries.filter(query => query === o.state.retryQuery).length === 2, "An explicit unchanged request reuses the initial goal tree.");
      c.add("no-invented-progress", !claimsInventedProgress(o.reply), "New goals do not claim fabricated progress metrics.");
      break;
    }
    case "goals.align-existing-work": {
      const growth = entity(o.state, "growth");
      c.add("saved-associations", !!current && current.goalId === growth.id && !!projectNow
        && (projectNow.goalId === growth.id || projectNow.goalIds?.includes(growth.id) === true), "The intended Launch and website task both reference the saved growth goal.");
      const finalReply = finalPhaseReply(o);
      c.add("cross-company-request-denied", !!o.state.authorizedAlignment
        && typeof o.state.foreignRequest === "string" && o.humanQueries.includes(o.state.foreignRequest)
        && /\b(?:cannot|can't|unable|not authorized|not accessible|different company|another company|cross-company|switch compan)\b/i.test(finalReply)
        && !o.reply.includes(String(o.state.protectedText))
        && !o.tasks.some(row => row.goalId === entity(o.state, "foreignGoal").id)
        && !o.projects.some(row => row.goalId === entity(o.state, "foreignGoal").id || row.goalIds?.includes(entity(o.state, "foreignGoal").id)),
        "The explicit foreign-goal request is denied with no foreign contents or cross-company association.");
      c.add("context-only", !!before && sameTask(before, current, ["goalId"]) && o.tasks.length === 1 && o.goals.length === 1,
        "Alignment does not alter priority, ownership, execution state or duplicate records.");
      c.add("attributed-alignment", !!current && authored("issue.updated", current.id) && !!projectNow && authored("project.updated", projectNow.id), "Both association writes are independently attributed.");
      const initialReply = (o.state.authorizedAlignment as { reply?: string } | undefined)?.reply;
      c.add("phase-bound-strategic-context-explanation", typeof initialReply === "string" && explainsAlignmentOnly(initialReply),
        "The initial authorized reply explains goal alignment as a context-only change, without claiming priority, reassignment or execution changes.");
      break;
    }
    case "goals.explain-purpose": {
      const growth = entity(o.state, "growth"); const team = entity(o.state, "team");
      const initial = observation(o.state.initialPurpose);
      c.add("initial-purpose-chain-and-rationale", !!initial && initialPurposeValid(initial),
        "The first phase itself follows the saved task/project/team/company chain, grounds its rationale, and links the source records.");
      const finalReply = finalPhaseReply(o);
      const missing = o.state.missingTask && typeof o.state.missingTask === "object" ? o.state.missingTask as Entity : undefined;
      c.add("missing-association-is-explicit", !!missing?.id && !!o.tasks.find(row => row.id === missing.id && row.goalId == null)
        && typeof o.state.missingReply === "string"
        && /(?:no|missing|not|unlinked|hasn't|doesn't|without)[^.!?]*?(?:goal|strateg|purpose|associat)|cannot[^.!?]*?determine/i.test(o.state.missingReply)
        && !(o.state.missingReply as string).includes(String(o.state.rationale)),
        "The unaligned-task phase describes the actual missing relationship instead of importing the first task's rationale.");
      c.add("inaccessible-rationale-not-leaked", typeof o.state.foreignRequest === "string" && o.humanQueries.includes(o.state.foreignRequest)
        && /\b(?:cannot|can't|unable|not authorized|not accessible|different company|another company|cross-company)\b/i.test(finalReply)
        && !o.reply.includes(String(o.state.protectedText)) && !o.links.some(link => link.includes(entity(o.state, "foreignTask").id)),
        "A separate inaccessible task/goal produces a scoped limitation without the foreign rationale or resource links.");
      c.add("read-only-explanation", !!before && sameTask(before, current) && linkedTask() && [growth, team].every(row => hasLink(o, "goals", row)) && !o.activity.some(row => row.entityId !== o.state.sourceId && [before.id, growth.id, team.id, savedProject?.id].includes(row.entityId) && row.agentId === o.leadId && /(?:updated|created|deleted)$/.test(row.action ?? "")),
        "An explanation does not rewrite the work's strategic context.");
      break;
    }
    default: c.add("implemented-scenario", false, "No independent oracle is implemented for this scenario.");
  }
  return c.result();
}

const define = (id: string, setup: ChatCatalogCase["setup"]) => ({ ...makeDefinition(id, setup, grade_goals), observe: observeGoalPhases });
export const goalsCases: readonly ChatCatalogCase[] = [
  createGoalTree(),
  crossCompanyAlignment(),
  purposeVariants(),

];

/** The requested cross-company condition is a real second human request, with no imported foreign content. */
function crossCompanyAlignment(): ChatCatalogCase {
  const base = define("goals.align-existing-work", async ctx => {
    const growth = await goal(ctx, "Growth: reach 1,000 signups");
    const p = await project(ctx); const t = await task(ctx, "Website task", p.id);
    const foreignCompany = await ctx.input.api.post<Entity>("/api/companies", { name: `Other company ${ctx.input.nonce}` });
    const protectedText = `Protected foreign strategy ${ctx.input.nonce}`;
    const foreignGoal = await ctx.input.api.post<Entity>(`/api/companies/${foreignCompany.id}/goals`, {
      title: "Other company growth", description: protectedText, level: "company",
    });
    return { growth, project: p, task: t, foreignCompany, foreignGoal, protectedText,
      foreignRequest: `Use the growth goal ${foreignGoal.id} from our other company instead.` };
  });
  return { ...base, coverageGaps: [], expectedRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 420_000,
    async act(ctx, state) {
      const first = await pollUntil({ label: "Initial authorized goal alignment", deadlineAt: Date.now() + 150_000,
        load: () => observeInternal(ctx, state),
        accept: o => {
          const g = entity(state, "growth"); const p = o.projects.find(row => row.id === entity(state, "project").id);
          return o.tasks.find(row => row.id === entity(state, "task").id)?.goalId === g.id
            && (p?.goalId === g.id || p?.goalIds?.includes(g.id) === true)
            && o.runs.length === 1 && o.runs.every(row => row.status === "succeeded") && ctx.issue()?.conversationState === "waiting";
        },
      });
      state.authorizedAlignment = { reply: first.reply, runIds: first.runs.map(row => row.id), taskGoalId: first.tasks.find(row => row.id === entity(state, "task").id)?.goalId,
        projectGoalIds: first.projects.find(row => row.id === entity(state, "project").id)?.goalIds };
      await ctx.input.evidence("chat-catalog-before-cross-company-request.json", { authorizedAlignment: state.authorizedAlignment });
      const { sendChatMessage } = await import("../chat-flow.js");
      state.foreignBaselineCommentIds = (await sourceReplies(ctx)).map(row => row.id);
      await sendChatMessage(ctx.input.page, String(state.foreignRequest));
    },
    async verifyResult(ctx, state, value) {
      const o = observation(value); if (!o) throw new Error("Missing independently read-back alignment");
      const sourceUrl = ctx.input.page.url(); const growth = entity(state, "growth");
      for (const [kind, row] of [["issues", entity(state, "task")], ["projects", entity(state, "project")]] as const) {
        const saved = (kind === "issues" ? o.tasks : o.projects).find(item => item.id === row.id);
        if (!saved) throw new Error("Aligned result is missing from public readback");
        const href = o.links.find(link => hasLink({ ...o, links: [link] }, kind, saved));
        if (href) await internalResultLink(ctx, o, href).first().click();
        else await ctx.input.page.goto(new URL(`/${ctx.input.fixtures.company.issuePrefix}/${kind}/${saved.identifier ?? saved.urlKey ?? saved.id}`, o.origin).href, { waitUntil: "domcontentloaded" });
        await expect(ctx.input.page.getByRole("heading", { name: saved.title ?? saved.name!, exact: true }).first()).toBeVisible();
        await ctx.input.evidence(`chat-catalog-alignment-opened-${kind}.json`, { id: saved.id, goalId: growth.id, url: ctx.input.page.url(), viaReturnedLink: !!href });
        await ctx.input.page.goto(sourceUrl, { waitUntil: "domcontentloaded" });
        await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
      }
    },
    async cleanup(ctx, state) { if (state.foreignCompany) await ctx.input.api.delete(`/api/companies/${entity(state, "foreignCompany").id}`, { allowNotFound: true }); },
  };
}

function explainsAlignmentOnly(reply: string): boolean {
  if (!/\b(?:goal|growth|strategic|alignment)\b/i.test(reply)) return false;
  const unchangedAll = /\b(?:no other (?:fields?|properties|changes)|only[^.\n]*(?:goal|strategic|alignment)|(?:goal|strategic|alignment)[^.\n]*only)\b/i.test(reply);
  const unchanged = (category: RegExp) => reply.split(/[.\n;]/).some(part => category.test(part)
    && /\b(?:unchanged|not changed|did not|didn't|without|no change|same|preserved|remain)\b/i.test(part));
  if (!unchangedAll && !(unchanged(/\bpriority\b/i) && unchanged(/\b(?:owner|ownership|assignee|assignment)\b/i)
    && unchanged(/\b(?:execution|status|running|started|work state)\b/i))) return false;
  return !reply.split(/[.\n;]/).some(part => !/\b(?:not|no|without|unchanged|didn't|hasn't)\b/i.test(part)
    && /\b(?:raised|lowered|increased|decreased|changed|set)\b[^.\n]*\bpriority\b|\b(?:assigned|reassigned)\b|\b(?:started|launched|began|resumed)\b[^.\n]*\b(?:work|execution|task|run)\b/i.test(part));
}

import { observeInternal } from "./internal-support.js";
import { pollUntil } from "../api.js";

function purposeVariants(): ChatCatalogCase {
  const base = define("goals.explain-purpose", async ctx => {
    const rationale = "quiet research teams";
    const growth = await goal(ctx, "Growth: reach 1,000 signups", { description: `We need a thousand signups to support ${rationale}.` });
    const team = await goal(ctx, "Launch the website", { level: "team", parentId: growth.id });
    const p = await project(ctx, "Launch", { goalIds: [team.id] });
    const t = await task(ctx, "Website task", p.id, { goalId: team.id });
    const foreignCompany = await ctx.input.api.post<Entity>("/api/companies", { name: `Inaccessible company ${ctx.input.nonce}` });
    const protectedText = `Protected purpose ${ctx.input.nonce}`;
    const foreignGoal = await ctx.input.api.post<Entity>(`/api/companies/${foreignCompany.id}/goals`, {
      title: "Private strategic rationale", description: protectedText, level: "company",
    });
    const foreignTask = await ctx.input.api.post<Entity>(`/api/companies/${foreignCompany.id}/issues`, {
      title: "Inaccessible website work", goalId: foreignGoal.id, status: "backlog",
    });
    return { growth, team, project: p, task: t, rationale, foreignTask, foreignCompany, protectedText,
      foreignRequest: `Why are we doing the website task ${foreignTask.identifier ?? foreignTask.id} in our other company?` };
  });
  return { ...base, coverageGaps: [], expectedRunCount: 3, expectedHumanMessageCount: 3, attemptTimeoutMs: 600_000,
    async act(ctx, state) {
      const first = await waitForPurposePhase(ctx, state, 1);
      if (!initialPurposeValid(first)) throw new Error("Initial purpose explanation does not match its saved chain and rationale");
      state.initialPurpose = { ...first, state: structuredClone(state) };
      // This is a later conditional context, not a second website task competing
      // with the canonical first-turn reference.
      const missingProject = await project(ctx, "Exploration");
      const missingTask = await task(ctx, "Unaligned website work", missingProject.id);
      state.missingProject = missingProject; state.missingTask = missingTask;
      state.missingRequest = `Why are we doing Unaligned website work (${missingTask.identifier ?? missingTask.id})?`;
      await ctx.input.evidence("chat-catalog-purpose-missing-context-created.json", { afterInitialRunIds: first.runs.map(row => row.id),
        initialTaskIds: first.tasks.map(row => row.id), initialProjectIds: first.projects.map(row => row.id), missingTask, missingProject });
      const previous = await sourceReplies(ctx);
      const { sendChatMessage } = await import("../chat-flow.js");
      await sendChatMessage(ctx.input.page, String(state.missingRequest));
      await waitForPurposePhase(ctx, state, 2);
      const missing = (await sourceReplies(ctx)).filter(row => !previous.some(before => before.id === row.id));
      state.missingReply = missing.map(row => row.body ?? "").join("\n");
      await ctx.input.evidence("chat-catalog-purpose-conditional-phases.json", { initialPurpose: state.initialPurpose, missingReplies: missing });
      state.foreignBaselineCommentIds = (await sourceReplies(ctx)).map(row => row.id);
      await sendChatMessage(ctx.input.page, String(state.foreignRequest));
    },
    async cleanup(ctx, state) { if (state.foreignCompany) await ctx.input.api.delete(`/api/companies/${entity(state, "foreignCompany").id}`, { allowNotFound: true }); },
  };
}
async function waitForPurposePhase(ctx: ChatCatalogContext, state: Record<string, unknown>, count: number) {
  return pollUntil({ label: `Purpose explanation phase ${count}`, deadlineAt: Date.now() + 150_000,
    load: () => observeInternal(ctx, state), accept: o => o.runs.length === count && o.runs.every(row => row.status === "succeeded")
      && ctx.issue()?.conversationState === "waiting" });
}
async function sourceReplies(ctx: ChatCatalogContext) {
  const source = ctx.issue(); if (!source) throw new Error("Purpose phase lost its source conversation");
  const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`);
  const runs = await ctx.allRuns();
  return comments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && runs.some(run => run.id === row.createdByRunId));
}
import type { ChatCatalogContext } from "../chat-catalog-contract.js";

function initialGoalTreeCreation(o: InternalObservation | undefined): boolean {
  if (!o || o.goals.length !== 2 || o.goals.some(row => row.companyId !== o.companyId) || !validGoalOwners(o)) return false;
  const root = o.goals.find(isSignupCompanyGoal);
  const team = o.goals.find(isWebsiteTeamGoal);
  return !!root && !!team && root.parentId == null && team.parentId === root.id
    && o.goals.every(goal => o.activity.some(row => row.action === "goal.created" && row.entityId === goal.id && row.agentId === o.leadId))
    && !claimsInventedProgress(o.reply);
}

// The saved goals are identified by their level and parent; their model-chosen
// wording only has to carry the requested subject, never a particular phrasing.
const goalText = (row: Entity) => `${row.title ?? ""} ${row.description ?? ""}`;
function isSignupCompanyGoal(row: Entity): boolean {
  const text = goalText(row);
  return row.level === "company" && /\b(?:1[,.]?000|1\s?k|thousand)\b/i.test(text) && /\bsign(?:[- ]?ups?|ed[- ]up|ing[- ]up)\b|\bregist/i.test(text);
}
function isWebsiteTeamGoal(row: Entity): boolean {
  return row.level === "team" && /\bweb\s?site\b|\bsite\b/i.test(goalText(row));
}
/** A positive progress figure for goals created moments ago is fabricated; 0% is truthful. */
function claimsInventedProgress(reply: string): boolean {
  return /(?<![\d.,])[1-9]\d*(?:[.,]\d+)?\s*%\s*(?:complete|done|progress|of the way)|\balready\s+(?:at\s+|reached\s+|have\s+)?[1-9][\d,]*\s+(?:sign[- ]?ups?|users|customers)/i.test(reply);
}

function validGoalOwners(o: InternalObservation): boolean {
  return Array.isArray(o.agents) && o.goals.every(goal => goal.ownerAgentId == null
    || typeof goal.ownerAgentId === "string" && o.agents!.some(agent => agent.id === goal.ownerAgentId && agent.companyId === o.companyId));
}
interface GoalHierarchyInspection {
  companyId: string; rootId: string; childId: string; readbackMatched: true; rootVisible: true; childVisible: true;
}
/** Inspect the actual persisted tree through normal company Goals navigation. */
export async function inspectGoalHierarchy(ctx: ChatCatalogContext, state: Record<string, unknown>, o: InternalObservation): Promise<void> {
  const remaining = () => {
    const deadline = ctx.observationDeadlineAt, now = Date.now();
    if (!Number.isFinite(deadline) || deadline! <= now) throw new Error("Original goal inspection budget exhausted or missing");
    return deadline! - now;
  };
  remaining();
  if (!initialGoalTreeCreation(o)) throw new Error("No valid saved goal hierarchy is available to inspect");
  const root = o.goals.find(row => row.level === "company")!, child = o.goals.find(row => row.level === "team")!;
  const rootNow = await ctx.input.api.get<Entity>(`/api/goals/${encodeURIComponent(root.id)}`, { timeout: remaining() });
  const childNow = await ctx.input.api.get<Entity>(`/api/goals/${encodeURIComponent(child.id)}`, { timeout: remaining() });
  if (rootNow.id !== root.id || childNow.id !== child.id || rootNow.companyId !== o.companyId || childNow.companyId !== o.companyId
    || rootNow.level !== "company" || rootNow.parentId != null || childNow.level !== "team" || childNow.parentId !== rootNow.id
    || rootNow.title !== root.title || childNow.title !== child.title || !validGoalOwners({ ...o, goals: [rootNow, childNow] }))
    throw new Error("Goal hierarchy public readback does not match the saved requested tree");
  const sourceUrl = ctx.input.page.url();
  await ctx.input.page.goto(new URL(`/${ctx.input.fixtures.company.issuePrefix}/goals`, ctx.input.api.baseURL).href, { waitUntil: "domcontentloaded", timeout: remaining() });
  await ctx.input.page.locator(`a[href*=${JSON.stringify(`/goals/${root.id}`)}]`).first().click({ timeout: remaining() });
  await expect(ctx.input.page.getByRole("heading", { name: root.title!, exact: true }).first()).toBeVisible({ timeout: remaining() });
  await ctx.input.page.locator(`a[href*=${JSON.stringify(`/goals/${child.id}`)}]`).first().click({ timeout: remaining() });
  await expect(ctx.input.page.getByRole("heading", { name: child.title!, exact: true }).first()).toBeVisible({ timeout: remaining() });
  remaining();
  state.hierarchyInspection = { companyId: o.companyId, rootId: root.id, childId: child.id,
    readbackMatched: true, rootVisible: true, childVisible: true } satisfies GoalHierarchyInspection;
  await ctx.input.evidence("chat-catalog-goal-hierarchy-opened.json", state.hierarchyInspection);
  await ctx.input.page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: remaining() });
  await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible({ timeout: remaining() });
  remaining();
}
function createGoalTree(): ChatCatalogCase {
  const base = retryDefinition("goals.create-goal-tree", grade_goals, initialGoalTreeCreation, observeGoalPhases);
  return { ...base, oracleVersion: "paperclip.chat-catalog.goal-hierarchy.v3", observe: observeGoalPhases, async setup(ctx) {
    await ctx.input.api.patch(`/api/companies/${ctx.input.fixtures.company.id}`, { description: "Our mission is to grow product adoption and help new teams sign up." });
    return base.setup(ctx);
  }, async act(ctx, state) {
    await base.act!(ctx, state);
    await inspectGoalHierarchy(ctx, state, await observeGoalPhases(ctx, state));
  }, async verifyResult(ctx, state, value) {
    const o = observation(value); if (!o) throw new Error("No saved goal hierarchy result is accessible");
    await inspectGoalHierarchy(ctx, state, o);
  } };
}
import { expect } from "@playwright/test";

interface GoalPhaseObservation extends InternalObservation { finalPhaseReplies?: Entity[] }
function finalPhaseReply(o: InternalObservation): string {
  return ((o as GoalPhaseObservation).finalPhaseReplies ?? []).map(row => row.body ?? "").join("\n");
}
async function observeGoalPhases(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<GoalPhaseObservation> {
  const o = await observeInternal(ctx, state); const source = ctx.issue();
  if (ctx.scenario.id === "goals.create-goal-tree") return { ...o,
    agents: (await ctx.input.api.get<Entity[]>(`/api/companies/${ctx.input.fixtures.company.id}/agents`)).map(agent => ({ id: agent.id, companyId: agent.companyId })), finalPhaseReplies: [] };
  if (!source || !Array.isArray(state.foreignBaselineCommentIds)) return { ...o, finalPhaseReplies: [] };
  const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`);
  const foreignHuman = comments.find(row => !row.authorAgentId && row.body === state.foreignRequest);
  const finalPhaseReplies = foreignHuman ? comments.filter(row => row.authorAgentId === o.leadId
    && !(state.foreignBaselineCommentIds as string[]).includes(row.id)
    && o.runs.some(run => run.id === row.createdByRunId)
    && Date.parse(row.createdAt ?? "") >= Date.parse(foreignHuman.createdAt ?? "")) : [];
  return { ...o, finalPhaseReplies };
}
function initialPurposeValid(o: InternalObservation): boolean {
  const before = entity(o.state, "task"); const growth = entity(o.state, "growth"); const team = entity(o.state, "team");
  const current = o.tasks.find(row => row.id === before.id); const p = o.projects.find(row => row.id === entity(o.state, "project").id);
  return o.tasks.length === 1 && o.projects.length === 1 && current?.goalId === team.id && team.parentId === growth.id && !!p && (p.goalId === team.id || p.goalIds?.includes(team.id) === true)
    && groundedPurpose(o.reply) && /\bwebsite\b/i.test(o.reply)
    && [growth, team].every(row => hasLink(o, "goals", row)) && hasLink(o, "issues", before)
    && sameTask(before, current) && !o.activity.some(row => [before.id, p.id, growth.id, team.id].includes(row.entityId ?? "")
      && row.agentId === o.leadId && /(?:updated|created|deleted)$/.test(row.action ?? ""));
}
function groundedPurpose(reply: string): boolean {
  // The saved business fact is support for research teams. A fixture nonce is
  // never business meaning and faithful paraphrases need not repeat it.
  return reply.split(/[.\n;]|\bbut\b/i).some(part => /\bresearch(?:ers)?\b/i.test(part) && /\b(?:teams?|groups?)\b/i.test(part)
    && /\b(?:support|supports|help|helps|serve|serves|benefit|enable|for)\b/i.test(part)
    && !/\b(?:(?:does|do|will|would|can|could|is|are)\s+not|doesn't|don't|won't|can't|cannot|never)\s+(?:\w+\s+){0,2}(?:support|help|serve|benefit|enable)\b|\bnot\s+(?:(?:intended|meant)\s+to\s+(?:support|help)|for\s+(?:research|researchers))\b/i.test(part))
    && !reply.split(/[.\n;]/).some(part => !/\b(?:no|not|without|isn't|doesn't)\b/i.test(part)
      && /\b(?:sell(?:ing)?\s+(?:ads?|advertising|data)|ad revenue|advertising revenue)\b/i.test(part));
}
