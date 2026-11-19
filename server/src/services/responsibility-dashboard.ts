import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  issueThreadInteractions,
  issues,
  responsibilities,
  responsibilityAreas,
} from "@paperclipai/db";
import {
  RESPONSIBILITY_DASHBOARD_ORIGIN_KIND,
  createDashboardChangeSetSchema,
  dashboardChangesMissingDependencies,
  responsibilityDashboardSentence,
  type CreateDashboardChangeSet,
  type ProposeDashboardChangesInteraction,
  type ProposeDashboardChangesPayload,
  type ResponsibilityDashboardChange,
  type ResponsibilityDashboardMode,
  type ResponsibilityDashboardState,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { responsibilitiesDisabledError } from "./responsibilities-disabled.js";
import type { AuthorizationActor } from "./authorization.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { issueService } from "./issues.js";
import { agentCannotTalk, defaultConversationAgentId } from "./responsibility-bars.js";
import { buildDashboardInterviewQuestions } from "./responsibility-dashboard-interview.js";
import {
  lockDashboard,
  responsibilityDashboardVersionService,
  type DashboardActivityEvent,
  type DashboardTransaction,
} from "./responsibility-dashboard-versions.js";

type IssueRow = typeof issues.$inferSelect;
type AreaRow = typeof responsibilityAreas.$inferSelect;

const LIVE = ["proposed", "active"] as const;
const NO_AREA = "No area";

function isClosed(status: string) {
  return status === "done" || status === "cancelled";
}

export function dashboardConversationMode(issue: Pick<IssueRow, "originFingerprint">): ResponsibilityDashboardMode {
  return issue.originFingerprint === "edit" ? "edit" : "create";
}

function lower(value: string) {
  return value.trim().toLowerCase();
}

/**
 * Dashboard conversations (experimental `enableResponsibilities`): a person
 * asks an agent to research and interview them and draft their Dashboard
 * (Create), or to change it (Edit). The conversation is an ordinary task
 * (origin `responsibility_dashboard`, origin id = the person, fingerprint =
 * the mode) assigned to the agent; one is open per person at a time. The
 * agent proposes a change set; nothing is applied until a person who may edit
 * that person's responsibilities accepts it, and applying never deletes
 * anything (removed responsibilities are let go, removed areas archived).
 * This module owns the guardrails, the change set's words and the apply path;
 * the card row belongs to the interactions service and versions to
 * responsibility-dashboard-versions.ts.
 */
export function responsibilityDashboardService(db: Db) {
  const settings = instanceSettingsService(db);
  const interactions = issueThreadInteractionService(db);
  const issuesSvc = issueService(db);
  const versions = responsibilityDashboardVersionService(db);

  async function assertEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableResponsibilities !== true) throw responsibilitiesDisabledError();
  }

  /** Empty: no active responsibility and none proposed. One query. */
  async function isEmpty(companyId: string, ownerUserId: string) {
    const [row] = await db.select({ id: responsibilities.id }).from(responsibilities).where(and(
      eq(responsibilities.companyId, companyId),
      eq(responsibilities.ownerUserId, ownerUserId),
      inArray(responsibilities.status, [...LIVE]),
    )).limit(1);
    return !row;
  }

  async function latestConversation(companyId: string, ownerUserId: string): Promise<IssueRow | null> {
    const [issue] = await db.select().from(issues).where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, RESPONSIBILITY_DASHBOARD_ORIGIN_KIND),
      eq(issues.originId, ownerUserId),
      ne(issues.status, "cancelled"),
    )).orderBy(desc(issues.createdAt), desc(issues.id)).limit(1);
    return issue ?? null;
  }

  /** The pending proposal and whether the latest one was accepted, in one query. */
  async function proposals(issue: Pick<IssueRow, "id" | "companyId">) {
    const rows = await db.select({ id: issueThreadInteractions.id, status: issueThreadInteractions.status })
      .from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, issue.companyId),
        eq(issueThreadInteractions.issueId, issue.id),
        eq(issueThreadInteractions.kind, "propose_dashboard_changes"),
      )).orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id)).limit(1);
    const latest = rows[0] ?? null;
    return { pendingId: latest?.status === "pending" ? latest.id : null, latestAccepted: latest?.status === "accepted" };
  }

  async function loadConversationIssue(issueRef: { id: string; companyId: string }) {
    const [issue] = await db.select().from(issues)
      .where(and(eq(issues.id, issueRef.id), eq(issues.companyId, issueRef.companyId)));
    if (!issue) throw notFound("Issue not found");
    if (issue.originKind !== RESPONSIBILITY_DASHBOARD_ORIGIN_KIND || !issue.originId) {
      throw unprocessable("Dashboard changes can only be proposed in a person's dashboard conversation", {
        code: "responsibility_dashboard_not_dashboard_conversation",
      });
    }
    return issue;
  }

  /**
   * Check a change set against the person's dashboard as it is and resolve
   * the words the card shows. Three queries.
   */
  async function buildPayload(
    companyId: string,
    ownerUserId: string,
    mode: ResponsibilityDashboardMode,
    data: CreateDashboardChangeSet,
  ): Promise<ProposeDashboardChangesPayload> {
    const namedAreaIds = [...new Set(data.changes.flatMap((change) => ("areaId" in change && change.areaId ? [change.areaId] : [])))];
    const [own, areaRows, others] = await Promise.all([
      db.select({
        id: responsibilities.id,
        title: responsibilities.title,
        standard: responsibilities.standard,
        areaId: responsibilities.areaId,
      }).from(responsibilities).where(and(
        eq(responsibilities.companyId, companyId),
        eq(responsibilities.ownerUserId, ownerUserId),
        eq(responsibilities.status, "active"),
      )),
      db.select().from(responsibilityAreas).where(and(
        eq(responsibilityAreas.companyId, companyId),
        namedAreaIds.length > 0
          ? or(ne(responsibilityAreas.status, "archived"), inArray(responsibilityAreas.id, namedAreaIds))
          : ne(responsibilityAreas.status, "archived"),
      )),
      db.select({ areaId: responsibilities.areaId, count: sql<number>`count(distinct ${responsibilities.ownerUserId})::int` })
        .from(responsibilities).where(and(
          eq(responsibilities.companyId, companyId),
          ne(responsibilities.ownerUserId, ownerUserId),
          inArray(responsibilities.status, [...LIVE]),
          sql`${responsibilities.areaId} is not null`,
        )).groupBy(responsibilities.areaId),
    ]);
    const ownById = new Map(own.map((row) => [row.id, row]));
    const areasById = new Map(areaRows.map((row) => [row.id, row]));
    const liveByTitle = new Map(areaRows.filter((row) => row.status !== "archived").map((row) => [lower(row.title), row]));
    const sharedWith = new Map(others.map((row) => [row.areaId!, row.count]));
    const refs = new Map<string, { index: number; name: string }>();
    const problems: string[] = [];
    const problem = (index: number, message: string) => problems.push(`changes[${index}]: ${message}`);
    const areaName = (areaId: string | null) => (areaId ? areasById.get(areaId)?.title ?? NO_AREA : NO_AREA);
    const usableArea = (index: number, areaId: string): AreaRow | null => {
      const area = areasById.get(areaId);
      if (!area) {
        problem(index, "No area with that areaId in this company");
        return null;
      }
      if (area.status === "archived") {
        problem(index, `"${area.title}" is archived; add it again with add_area or choose another area`);
        return null;
      }
      return area;
    };
    const ownItem = (index: number, responsibilityId: string) => {
      const row = ownById.get(responsibilityId);
      if (!row) problem(index, "That responsibilityId is not one of this person's active responsibilities");
      return row ?? null;
    };
    // Responsibilities a later change moves or removes, for what a removed area lets go of.
    const leaving = new Set(data.changes.flatMap((change) =>
      change.op === "move_responsibility" || change.op === "remove_responsibility" ? [change.responsibilityId] : []));

    const changes: ResponsibilityDashboardChange[] = data.changes.map((change, index) => {
      const base: ResponsibilityDashboardChange = {
        index,
        op: change.op,
        reason: change.reason?.trim() || null,
        dependsOn: [],
        groupAreaId: null,
        groupRef: null,
        groupName: NO_AREA,
        name: null,
        fromName: null,
        responsibilityId: null,
        sentence: null,
        fromSentence: null,
        fromAreaId: null,
        fromAreaName: null,
        lettingGo: [],
        sharedWith: 0,
      };
      const target = (areaId: string | undefined, ref: string | undefined) => {
        if (ref !== undefined) {
          const added = refs.get(ref);
          if (added) {
            base.groupRef = ref;
            base.groupName = added.name;
            base.dependsOn = [added.index];
          }
          return;
        }
        if (areaId && usableArea(index, areaId)) {
          base.groupAreaId = areaId;
          base.groupName = areaName(areaId);
        }
      };
      switch (change.op) {
        case "add_area": {
          const clash = liveByTitle.get(lower(change.name));
          if (clash) problem(index, `An area called "${clash.title}" already exists (areaId ${clash.id}); file under it instead of adding another`);
          refs.set(change.ref, { index, name: change.name.trim() });
          return { ...base, groupRef: change.ref, groupName: change.name.trim(), name: change.name.trim() };
        }
        case "rename_area": {
          const area = usableArea(index, change.areaId);
          if (!area) return base;
          const clash = liveByTitle.get(lower(change.name));
          if (lower(change.name) === lower(area.title) && change.name.trim() === area.title) problem(index, `"${area.title}" already has that name`);
          else if (clash && clash.id !== area.id) problem(index, `Another area is already called "${clash.title}"`);
          return {
            ...base,
            groupAreaId: area.id,
            groupName: area.title,
            name: change.name.trim(),
            fromName: area.title,
            sharedWith: sharedWith.get(area.id) ?? 0,
          };
        }
        case "remove_area": {
          const area = usableArea(index, change.areaId);
          if (!area) return base;
          const shared = sharedWith.get(area.id) ?? 0;
          if (shared > 0) {
            problem(index, `"${area.title}" holds responsibilities of ${shared === 1 ? "another person" : `${shared} other people`}, so it stays; move or remove this person's responsibilities in it instead`);
          }
          return {
            ...base,
            groupAreaId: area.id,
            groupName: area.title,
            lettingGo: own.filter((row) => row.areaId === area.id && !leaving.has(row.id))
              .map((row) => ({ id: row.id, sentence: responsibilityDashboardSentence(row) })),
          };
        }
        case "add_responsibility": {
          target(change.areaId, change.areaRef);
          const words = lower(change.sentence);
          if (own.some((row) => lower(responsibilityDashboardSentence(row)) === words || lower(row.title) === words)) {
            problem(index, "This person already owns a responsibility that reads exactly like this");
          }
          return { ...base, sentence: change.sentence.trim() };
        }
        case "reword_responsibility": {
          const row = ownItem(index, change.responsibilityId);
          if (!row) return base;
          const from = responsibilityDashboardSentence(row);
          if (from === change.sentence.trim()) problem(index, "The new sentence is the same as the one it has");
          return {
            ...base,
            groupAreaId: row.areaId,
            groupName: areaName(row.areaId),
            responsibilityId: row.id,
            sentence: change.sentence.trim(),
            fromSentence: from,
          };
        }
        case "move_responsibility": {
          const row = ownItem(index, change.responsibilityId);
          target(change.areaId, change.areaRef);
          if (!row) return base;
          if (change.areaId && change.areaId === row.areaId) problem(index, "It is already in that area");
          return {
            ...base,
            responsibilityId: row.id,
            fromSentence: responsibilityDashboardSentence(row),
            fromAreaId: row.areaId,
            fromAreaName: row.areaId ? areaName(row.areaId) : null,
          };
        }
        case "remove_responsibility": {
          const row = ownItem(index, change.responsibilityId);
          if (!row) return base;
          return {
            ...base,
            groupAreaId: row.areaId,
            groupName: areaName(row.areaId),
            responsibilityId: row.id,
            fromSentence: responsibilityDashboardSentence(row),
          };
        }
      }
    });
    if (problems.length > 0) {
      throw unprocessable(`The proposed changes do not fit this dashboard: ${problems.join("; ")}`, {
        code: "responsibility_dashboard_changes_invalid",
        problems,
      });
    }
    return { version: 1, ownerUserId, mode, message: data.message?.trim() || null, changes };
  }

  /**
   * Inside `tx`, holding the person's lock: apply the kept changes in a safe
   * order (new and renamed areas, then new, reworded and moved
   * responsibilities, then what is let go, then removed areas). Every change
   * is checked again against the rows as they are now; one that no longer
   * fits fails the whole apply with 409, and nothing is written.
   */
  async function applyInTx(
    tx: DashboardTransaction,
    companyId: string,
    payload: ProposeDashboardChangesPayload,
    keep: ReadonlySet<number>,
    proposedByAgentId: string | null,
    source: Record<string, unknown>,
  ): Promise<{ events: DashboardActivityEvent[]; createdAreaIds: string[] }> {
    const ownerUserId = payload.ownerUserId;
    const kept = payload.changes.filter((change) => keep.has(change.index));
    const now = new Date();
    const events: DashboardActivityEvent[] = [];
    const createdAreaIds: string[] = [];
    const refToArea = new Map<string, string>();
    const stale = (message: string) => conflict(`${message}. Ask for the proposal again.`, { code: "responsibility_dashboard_changes_stale" });
    const loadArea = async (areaId: string) => {
      const [row] = await tx.select().from(responsibilityAreas)
        .where(and(eq(responsibilityAreas.id, areaId), eq(responsibilityAreas.companyId, companyId))).for("update");
      return row ?? null;
    };
    const liveAreaNamed = async (title: string, except?: string) => {
      const [row] = await tx.select().from(responsibilityAreas).where(and(
        eq(responsibilityAreas.companyId, companyId),
        sql`lower(${responsibilityAreas.title}) = lower(${title})`,
        ne(responsibilityAreas.status, "archived"),
        except ? ne(responsibilityAreas.id, except) : undefined,
      )).limit(1);
      return row ?? null;
    };
    const loadOwn = async (responsibilityId: string) => {
      const [row] = await tx.select().from(responsibilities).where(and(
        eq(responsibilities.id, responsibilityId),
        eq(responsibilities.companyId, companyId),
        eq(responsibilities.ownerUserId, ownerUserId),
      )).for("update");
      return row ?? null;
    };
    /** The area a change files under, usable now; a proposed one becomes active. */
    const destination = async (change: ResponsibilityDashboardChange) => {
      const areaId = change.groupRef !== null ? refToArea.get(change.groupRef) : change.groupAreaId;
      if (!areaId) throw stale(`"${change.groupName}" is not on the dashboard any more`);
      const area = await loadArea(areaId);
      if (!area || area.status === "archived") throw stale(`"${change.groupName}" was removed since this was proposed`);
      if (area.status === "proposed") {
        await tx.update(responsibilityAreas).set({ status: "active", updatedAt: now }).where(eq(responsibilityAreas.id, area.id));
        events.push({ action: "responsibility_area.activated", entityType: "responsibility_area", entityId: area.id, details: { title: area.title, ...source } });
      }
      return area.id;
    };
    const byOp = (op: ResponsibilityDashboardChange["op"]) => kept.filter((change) => change.op === op);

    for (const change of byOp("add_area")) {
      const existing = await liveAreaNamed(change.name!);
      if (existing) {
        refToArea.set(change.groupRef!, existing.id);
        continue;
      }
      const [created] = await tx.insert(responsibilityAreas).values({ companyId, title: change.name!, status: "active", source: "manual" }).returning();
      refToArea.set(change.groupRef!, created!.id);
      createdAreaIds.push(created!.id);
      events.push({ action: "responsibility_area.created", entityType: "responsibility_area", entityId: created!.id, details: { title: created!.title, status: "active", source: "manual", ...source } });
    }
    for (const change of byOp("rename_area")) {
      const area = await loadArea(change.groupAreaId!);
      if (!area || area.status === "archived") throw stale(`"${change.fromName}" was removed since this was proposed`);
      if (await liveAreaNamed(change.name!, area.id)) throw stale(`Another area is now called "${change.name}"`);
      await tx.update(responsibilityAreas).set({ title: change.name!, updatedAt: now }).where(eq(responsibilityAreas.id, area.id));
      events.push({ action: "responsibility_area.updated", entityType: "responsibility_area", entityId: area.id, details: { fields: ["title"], fromTitle: area.title, toTitle: change.name, ...source } });
    }
    for (const change of byOp("add_responsibility")) {
      const areaId = await destination(change);
      const [created] = await tx.insert(responsibilities).values({
        companyId,
        ownerUserId,
        areaId,
        title: change.sentence!,
        status: "active",
        source: "manual",
        metricDirection: null,
        proposedByAgentId,
        confirmedAt: now,
      }).returning();
      events.push({ action: "responsibility.created", entityType: "responsibility", entityId: created!.id, details: { title: created!.title, ownerUserId, status: "active", source: "manual", areaId, ...source } });
    }
    for (const change of byOp("reword_responsibility")) {
      const row = await loadOwn(change.responsibilityId!);
      if (!row || row.status !== "active") throw stale(`"${change.fromSentence}" is no longer on the dashboard`);
      // The sentence the Dashboard shows: the bar's sentence when it has one, else the title.
      const field = row.standard?.trim() ? "standard" : "title";
      await tx.update(responsibilities).set({ [field]: change.sentence!, updatedAt: now }).where(eq(responsibilities.id, row.id));
      events.push({ action: "responsibility.updated", entityType: "responsibility", entityId: row.id, details: { fields: [field], ...source } });
    }
    for (const change of byOp("move_responsibility")) {
      const row = await loadOwn(change.responsibilityId!);
      if (!row || row.status !== "active") throw stale(`"${change.fromSentence}" is no longer on the dashboard`);
      const areaId = await destination(change);
      if (row.areaId === areaId) continue;
      await tx.update(responsibilities).set({ areaId, updatedAt: now }).where(eq(responsibilities.id, row.id));
      events.push({ action: "responsibility.updated", entityType: "responsibility", entityId: row.id, details: { fields: ["areaId"], fromAreaId: row.areaId, toAreaId: areaId, ...source } });
    }
    const letGo = async (responsibilityId: string) => {
      const [updated] = await tx.update(responsibilities).set({ status: "let_go", updatedAt: now }).where(and(
        eq(responsibilities.id, responsibilityId),
        eq(responsibilities.companyId, companyId),
        eq(responsibilities.ownerUserId, ownerUserId),
        eq(responsibilities.status, "active"),
      )).returning({ id: responsibilities.id });
      if (updated) events.push({ action: "responsibility.updated", entityType: "responsibility", entityId: responsibilityId, details: { fields: ["status"], fromStatus: "active", toStatus: "let_go", ...source } });
    };
    // Already let go or gone: nothing to do.
    for (const change of byOp("remove_responsibility")) await letGo(change.responsibilityId!);
    for (const change of byOp("remove_area")) {
      const area = await loadArea(change.groupAreaId!);
      if (!area || area.status === "archived") continue;
      const [others] = await tx.select({ id: responsibilities.id }).from(responsibilities).where(and(
        eq(responsibilities.companyId, companyId),
        eq(responsibilities.areaId, area.id),
        ne(responsibilities.ownerUserId, ownerUserId),
        inArray(responsibilities.status, [...LIVE]),
      )).limit(1);
      if (others) throw stale(`Someone else now has responsibilities in "${area.title}", so it stays`);
      const remaining = await tx.select({ id: responsibilities.id }).from(responsibilities).where(and(
        eq(responsibilities.companyId, companyId),
        eq(responsibilities.areaId, area.id),
        eq(responsibilities.ownerUserId, ownerUserId),
        eq(responsibilities.status, "active"),
      ));
      for (const row of remaining) await letGo(row.id);
      events.push(...await versions.archiveIfEmpty(tx, companyId, [area.id], source));
    }
    return { events, createdAreaIds };
  }

  return {
    assertEnabled,
    isEmpty,

    /** The agent a new conversation would be held with. One query. */
    defaultAgentId: (companyId: string) => defaultConversationAgentId(db, companyId),

    /** What the Dashboard's edit module shows for this person. A fixed number of queries. */
    async state(companyId: string, ownerUserId: string): Promise<ResponsibilityDashboardState> {
      const [empty, issue, agentId, latestChange] = await Promise.all([
        isEmpty(companyId, ownerUserId),
        latestConversation(companyId, ownerUserId),
        defaultConversationAgentId(db, companyId),
        versions.latestChange(companyId, ownerUserId),
      ]);
      const found = issue ? await proposals(issue) : { pendingId: null, latestAccepted: false };
      const proposal = found.pendingId
        ? (await interactions.getById(found.pendingId)) as ProposeDashboardChangesInteraction | null
        : null;
      const state: ResponsibilityDashboardState["state"] = !issue ? "none"
        : proposal ? "proposal_waiting"
          : !isClosed(issue.status) && !found.latestAccepted ? "discussing"
            : "settled";
      return {
        ownerUserId,
        empty,
        state,
        defaultAgentId: agentId,
        conversation: issue ? {
          issueId: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          agentId: issue.assigneeAgentId,
          mode: dashboardConversationMode(issue),
          createdAt: issue.createdAt,
        } : null,
        proposal,
        latestChange,
      };
    },

    /**
     * Open the person's dashboard conversation: the open one (or the latest
     * one with a proposal waiting) whatever its mode, otherwise a new task
     * assigned to the agent. A Create conversation opens with the interview
     * card, posted as the agent; the route wakes the agent only when the
     * person has something to answer for it (Edit), or the card could not be
     * posted. The route writes activity after commit.
     */
    async startConversation(
      companyId: string,
      ownerUserId: string,
      input: { mode: ResponsibilityDashboardMode; agentId?: string },
      actor: { userId: string; runId: string | null; identityContextId: string | null; authorizationActor: AuthorizationActor },
    ): Promise<{ issue: IssueRow; created: boolean; interviewPosted: boolean }> {
      await assertEnabled();
      const existing = await latestConversation(companyId, ownerUserId);
      if (existing && (!isClosed(existing.status) || (await proposals(existing)).pendingId)) {
        return { issue: existing, created: false, interviewPosted: false };
      }
      const agentId = input.agentId ?? await defaultConversationAgentId(db, companyId);
      if (!agentId) {
        throw unprocessable("No agent in this company can do this; add areas and responsibilities by hand", {
          code: "responsibility_dashboard_no_agent",
        });
      }
      const [agent] = await db.select({ id: agents.id, status: agents.status }).from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
      if (!agent) throw notFound("Agent not found");
      if (agentCannotTalk(agent.status)) {
        throw unprocessable("That agent is not taking work right now; choose another or edit the dashboard by hand", {
          code: "responsibility_dashboard_agent_unavailable",
        });
      }
      const [company] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId));
      const backLink = company ? `[Back to the Dashboard](/${company.issuePrefix}/responsibilities)` : null;
      const description = [
        input.mode === "create"
          ? "Get to know me and draft my dashboard: the areas I care about and, in each, the few things I own. Start with the questions below, then propose a first dashboard I can accept with one tap."
          : "Help me change my dashboard. Ask me what I want changed, or suggest changes from what you have seen in the work, then propose them so I can accept with one tap.",
        ...(backLink ? ["", backLink] : []),
      ].join("\n");
      const issue = await issuesSvc.create(companyId, {
        title: input.mode === "create" ? "Create my dashboard" : "Edit my dashboard",
        description,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: RESPONSIBILITY_DASHBOARD_ORIGIN_KIND,
        originId: ownerUserId,
        originFingerprint: input.mode,
        createdByUserId: actor.userId,
        createdByAgentId: null,
        trustExplicitResponsibleUserId: true,
        workspaceSelectionActor: actor.authorizationActor,
        originRunId: actor.runId,
        originIdentityContextId: actor.identityContextId,
        actorRunId: actor.runId,
      }) as unknown as IssueRow;
      let interviewPosted = false;
      if (input.mode === "create") {
        try {
          await interactions.create(issue, {
            kind: "ask_user_questions",
            idempotencyKey: `responsibility-dashboard:${issue.id}:interview`,
            continuationPolicy: "wake_assignee",
            payload: buildDashboardInterviewQuestions(),
          }, { agentId });
          interviewPosted = true;
        } catch {
          // The agent asks the questions itself when woken.
        }
      }
      return { issue, created: true, interviewPosted };
    },

    /** The agent in a dashboard conversation proposes changes. Nothing is applied. */
    async propose(issueRef: { id: string; companyId: string }, input: CreateDashboardChangeSet, actor: { agentId: string; runId: string | null }) {
      await assertEnabled();
      const data = createDashboardChangeSetSchema.parse(input);
      const issue = await loadConversationIssue(issueRef);
      if (issue.status === "cancelled") {
        throw conflict("This dashboard conversation was cancelled", { code: "responsibility_dashboard_conversation_cancelled" });
      }
      if (issue.assigneeAgentId !== actor.agentId) {
        throw forbidden("Only the agent in this dashboard conversation can propose changes");
      }
      const payload = await buildPayload(issue.companyId, issue.originId!, dashboardConversationMode(issue), data);
      return interactions.createDashboardChangesProposal(issue, {
        payload,
        title: "Proposed dashboard changes",
        summary: payload.message,
        createdByAgentId: actor.agentId,
        sourceRunId: actor.runId,
      });
    },

    /** The person a conversation is about, for the route's writer check. */
    async ownerForConversation(issueRef: { id: string; companyId: string }) {
      const issue = await loadConversationIssue(issueRef);
      return { issue, ownerUserId: issue.originId! };
    },

    /**
     * Apply the kept changes and settle the card in one transaction: the
     * dashboard as it is is saved as a version first (when it changed by hand
     * since the last one), the changes are applied, and the result is saved
     * as a `change_set` version, so Undo can always go back. The route checks
     * the writer rule first.
     */
    async accept(
      issueRef: { id: string; companyId: string },
      interactionId: string,
      actor: { userId: string },
      options: { keep?: readonly number[] } = {},
    ) {
      await assertEnabled();
      const issue = await loadConversationIssue(issueRef);
      const ownerUserId = issue.originId!;
      const { interaction, applied } = await interactions.resolveDashboardChangesProposal(
        issue,
        interactionId,
        "accepted",
        { userId: actor.userId },
        async (tx, current) => {
          if (current.payload.ownerUserId !== ownerUserId) throw notFound("Interaction not found");
          const all = current.payload.changes.map((change) => change.index);
          const keep = new Set(options.keep ?? all);
          const unknown = [...keep].filter((index) => !all.includes(index));
          if (unknown.length > 0) {
            throw unprocessable("keep names a change the proposal does not have", { code: "responsibility_dashboard_keep_invalid", unknown });
          }
          const missing = dashboardChangesMissingDependencies(current.payload.changes, keep);
          if (missing.length > 0) {
            const words = missing.map(({ index, needs }) =>
              `change ${index} needs change ${needs} ("${current.payload.changes[needs]?.groupName ?? ""}")`);
            throw unprocessable(`Keep the area these changes are filed under, or drop them too: ${words.join("; ")}`, {
              code: "responsibility_dashboard_keep_dependency",
              missing,
            });
          }
          await lockDashboard(tx, issue.companyId, ownerUserId);
          const touched = [...new Set(current.payload.changes
            .filter((change) => keep.has(change.index))
            .flatMap((change) => [change.groupAreaId, change.fromAreaId])
            .filter((areaId): areaId is string => areaId !== null))];
          const before = await versions.checkpoint(tx, issue.companyId, ownerUserId, actor.userId, touched);
          const source = { source: "dashboard_conversation", issueId: issue.id, interactionId };
          const result = await applyInTx(tx, issue.companyId, current.payload, keep, current.createdByAgentId ?? null, source);
          const snapshot = await versions.captureSnapshot(tx, issue.companyId, ownerUserId, result.createdAreaIds, touched);
          const after = await versions.save(tx, {
            companyId: issue.companyId,
            ownerUserId,
            cause: "change_set",
            snapshot,
            actorUserId: actor.userId,
            actorAgentId: current.createdByAgentId ?? null,
            issueId: issue.id,
            interactionId,
          });
          return {
            events: result.events,
            before: before.row,
            after: after.row,
            dropped: all.filter((index) => !keep.has(index)),
          };
        },
        (applied) => ({
          dropped: applied.dropped.length > 0 ? applied.dropped : null,
          versionId: applied.after.id,
          previousVersionId: applied.before.id,
          summary: applied.after.id === applied.before.id ? "No changes" : applied.after.summary,
        }),
      );
      return { interaction, ...applied! };
    },

    /** "Not right": the card closes and the conversation continues. */
    async decline(issueRef: { id: string; companyId: string }, interactionId: string, actor: { userId: string }) {
      await assertEnabled();
      const issue = await loadConversationIssue(issueRef);
      const { interaction } = await interactions.resolveDashboardChangesProposal(issue, interactionId, "declined", { userId: actor.userId });
      return interaction;
    },
  };
}
