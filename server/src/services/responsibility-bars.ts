import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  issueThreadInteractions,
  issues,
  responsibilities,
} from "@paperclipai/db";
import {
  RESPONSIBILITY_BAR_ORIGIN_KIND,
  RESPONSIBILITY_BAR_TEMPLATES,
  createResponsibilityBarProposalSchema,
  formatResponsibilityReading,
  getAgentWorkEligibility,
  normalizeResponsibilityBar,
  normalizeResponsibilityMetricDefinition,
  normalizeResponsibilityReading,
  responsibilityAttainment,
  responsibilityBarMetricFromProposal,
  responsibilityHealthFromAttainment,
  responsibilityStatusRule,
  responsibilityStatusSentence,
  responsibilityTargetLabel,
  type CreateResponsibilityBarProposal,
  type ProposeResponsibilityBarInteraction,
  type ProposeResponsibilityBarPayload,
  type ResponsibilityBarConversation,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { responsibilitiesDisabledError } from "./responsibilities-disabled.js";
import type { AuthorizationActor } from "./authorization.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { issueService } from "./issues.js";
import { responsibilityService } from "./responsibilities.js";
import { responsibilityMetricService } from "./responsibility-metrics.js";

type ResponsibilityRow = typeof responsibilities.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

const OPEN_RESPONSIBILITY_STATUSES = new Set(["proposed", "active"]);
/** Agents that can hold a conversation: assignable, and not paused. */
const SILENT_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

function isClosed(status: string) {
  return status === "done" || status === "cancelled";
}

function hasCompleteBar(row: ResponsibilityRow) {
  return Boolean(row.standard?.trim() && row.metricName?.trim());
}

/**
 * The agent a helper conversation is held with: `preferredAgentId` when it can
 * take work, else the top of the org chart, else the oldest agent that can.
 * Null when no agent in the company can hold a conversation. One query.
 */
export async function defaultConversationAgentId(db: Db, companyId: string, preferredAgentId: string | null = null): Promise<string | null> {
  const companyAgents = await db.select({
    id: agents.id,
    companyId: agents.companyId,
    name: agents.name,
    role: agents.role,
    status: agents.status,
    reportsTo: agents.reportsTo,
    createdAt: agents.createdAt,
  }).from(agents).where(eq(agents.companyId, companyId)).orderBy(asc(agents.createdAt), asc(agents.id));
  const usable = companyAgents.filter((agent) => !SILENT_AGENT_STATUSES.has(agent.status)
    && getAgentWorkEligibility({ agent, agents: companyAgents }).assignable);
  if (usable.length === 0) return null;
  const preferred = preferredAgentId ? usable.find((agent) => agent.id === preferredAgentId) : undefined;
  if (preferred) return preferred.id;
  return (usable.find((agent) => agent.role === "ceo" && !agent.reportsTo)
    ?? usable.find((agent) => !agent.reportsTo)
    ?? usable[0]!).id;
}

/** Agents that cannot hold a conversation right now. */
export function agentCannotTalk(status: string) {
  return SILENT_AGENT_STATUSES.has(status);
}

/**
 * Bar conversations: from a responsibility's page a person talks with an
 * agent about how success should be measured, and the conversation ends in a
 * bar the person accepts with one tap. The conversation is an ordinary task
 * (origin `responsibility_bar`, origin id = the responsibility) assigned to
 * the agent. This module owns the guardrails, the proposal's derived words
 * and the accept path; the card row belongs to the interactions service and
 * the responsibility row to the responsibilities service.
 */
export function responsibilityBarService(db: Db) {
  const settings = instanceSettingsService(db);
  const interactions = issueThreadInteractionService(db);
  const responsibilitiesSvc = responsibilityService(db);
  const metricsSvc = responsibilityMetricService(db);
  const issuesSvc = issueService(db);

  async function assertEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableResponsibilities !== true) throw responsibilitiesDisabledError();
  }

  /** The agent a new conversation is held with: the agent that runs it, else the top of the org chart, else the oldest. */
  async function defaultAgentId(row: ResponsibilityRow): Promise<string | null> {
    return defaultConversationAgentId(db, row.companyId, row.runByAgentId);
  }

  async function latestConversation(row: Pick<ResponsibilityRow, "id" | "companyId">): Promise<IssueRow | null> {
    const [issue] = await db.select().from(issues).where(and(
      eq(issues.companyId, row.companyId),
      eq(issues.originKind, RESPONSIBILITY_BAR_ORIGIN_KIND),
      eq(issues.originId, row.id),
      ne(issues.status, "cancelled"),
    )).orderBy(desc(issues.createdAt), desc(issues.id)).limit(1);
    return issue ?? null;
  }

  async function pendingProposal(issue: Pick<IssueRow, "id" | "companyId">) {
    const [row] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, issue.companyId),
      eq(issueThreadInteractions.issueId, issue.id),
      eq(issueThreadInteractions.kind, "propose_responsibility_bar"),
      eq(issueThreadInteractions.status, "pending"),
    )).orderBy(desc(issueThreadInteractions.createdAt)).limit(1);
    if (!row) return null;
    return (await interactions.getById(row.id)) as ProposeResponsibilityBarInteraction | null;
  }

  /** True when the conversation's latest proposal was accepted: its job is done even if the task is still open. */
  async function latestProposalAccepted(issue: Pick<IssueRow, "id" | "companyId">) {
    const [row] = await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, issue.companyId),
      eq(issueThreadInteractions.issueId, issue.id),
      eq(issueThreadInteractions.kind, "propose_responsibility_bar"),
    )).orderBy(desc(issueThreadInteractions.createdAt)).limit(1);
    return row?.status === "accepted";
  }

  async function loadConversationIssue(issueRef: { id: string; companyId: string }) {
    const [issue] = await db.select().from(issues)
      .where(and(eq(issues.id, issueRef.id), eq(issues.companyId, issueRef.companyId)));
    if (!issue) throw notFound("Issue not found");
    if (issue.originKind !== RESPONSIBILITY_BAR_ORIGIN_KIND || !issue.originId) {
      throw unprocessable("A bar can only be proposed in a responsibility's bar conversation", {
        code: "responsibility_bar_not_bar_conversation",
      });
    }
    return issue;
  }

  async function loadResponsibility(companyId: string, responsibilityId: string) {
    const [row] = await db.select().from(responsibilities)
      .where(and(eq(responsibilities.id, responsibilityId), eq(responsibilities.companyId, companyId)));
    if (!row) throw notFound("Responsibility not found");
    return row;
  }

  function assertOpenResponsibility(row: ResponsibilityRow) {
    if (!OPEN_RESPONSIBILITY_STATUSES.has(row.status)) {
      throw conflict("This responsibility is no longer proposed or active, so its bar cannot change", {
        code: "responsibility_bar_responsibility_closed",
      });
    }
  }

  /** The card's plain words, derived from the bar so they always match what accepting applies. */
  function buildPayload(row: ResponsibilityRow, data: CreateResponsibilityBarProposal): ProposeResponsibilityBarPayload {
    const bar = normalizeResponsibilityBar(data);
    const metric = responsibilityBarMetricFromProposal(bar);
    const reading = data.metricCurrent === undefined || data.metricCurrent === null
      ? null
      : normalizeResponsibilityReading(data.metricCurrent);
    const attainment = responsibilityAttainment(metric, reading);
    const statusRule = responsibilityStatusRule(metric);
    const targetLabel = responsibilityTargetLabel(metric);
    if (!statusRule || !targetLabel) throw unprocessable("The proposed bar is incomplete for its template");
    return {
      version: 1,
      responsibilityId: row.id,
      responsibilityTitle: row.title,
      bar,
      metricCurrent: reading,
      currentEvidence: reading === null ? null : data.currentEvidence ?? null,
      message: data.message ?? null,
      templateLabel: RESPONSIBILITY_BAR_TEMPLATES[bar.metricKind].label,
      targetLabel,
      readingLabel: reading === null ? null : formatResponsibilityReading(metric, reading),
      statusRule,
      preview: reading === null ? null : {
        health: responsibilityHealthFromAttainment(attainment),
        statusSentence: responsibilityStatusSentence(metric, reading, attainment),
      },
      // The metric set rides along: absent keeps the responsibility's set as it is.
      primaryDisplay: data.primaryDisplay ?? null,
      metrics: data.metrics === undefined ? null : data.metrics.map(normalizeResponsibilityMetricDefinition),
    };
  }

  return {
    assertEnabled,
    defaultAgentId,

    /** Where the responsibility's bar conversation stands, for its page. */
    async conversation(row: ResponsibilityRow): Promise<ResponsibilityBarConversation> {
      await assertEnabled();
      const [issue, agentId] = await Promise.all([latestConversation(row), defaultAgentId(row)]);
      const proposal = issue ? await pendingProposal(issue) : null;
      const state: ResponsibilityBarConversation["state"] = !issue ? "none"
        : proposal ? "proposal_waiting"
          : !isClosed(issue.status) && !(await latestProposalAccepted(issue)) ? "discussing"
            : "settled";
      return {
        responsibilityId: row.id,
        state,
        defaultAgentId: agentId,
        conversation: issue ? {
          issueId: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          agentId: issue.assigneeAgentId,
          createdAt: issue.createdAt,
        } : null,
        proposal,
      };
    },

    /**
     * Open the bar conversation: the open one (or the latest one with a
     * proposal waiting) when there is one, otherwise a new task assigned to
     * the agent. The route wakes the agent and writes activity after commit.
     */
    async startConversation(
      row: ResponsibilityRow,
      input: { agentId?: string },
      actor: { userId: string; runId: string | null; identityContextId: string | null; authorizationActor: AuthorizationActor },
    ): Promise<{ issue: IssueRow; created: boolean }> {
      await assertEnabled();
      assertOpenResponsibility(row);
      const existing = await latestConversation(row);
      if (existing && (!isClosed(existing.status) || (await pendingProposal(existing)))) {
        return { issue: existing, created: false };
      }
      const agentId = input.agentId ?? await defaultAgentId(row);
      if (!agentId) {
        throw unprocessable("No agent in this company can talk this through; edit the bar by hand", {
          code: "responsibility_bar_no_agent",
        });
      }
      const [agent] = await db.select({ id: agents.id, status: agents.status }).from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, row.companyId)));
      if (!agent) throw notFound("Agent not found");
      if (SILENT_AGENT_STATUSES.has(agent.status)) {
        throw unprocessable("That agent is not taking work right now; choose another or edit the bar by hand", {
          code: "responsibility_bar_agent_unavailable",
        });
      }
      const [company] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies)
        .where(eq(companies.id, row.companyId));
      const setting = !hasCompleteBar(row);
      const backLink = company ? `[Back to ${row.title}](/${company.issuePrefix}/responsibilities/${row.id})` : null;
      const description = [
        setting
          ? `Let's agree how success is measured for **${row.title}**. Ask me what you need, then propose a bar I can accept with one tap.`
          : `Let's look again at how success is measured for **${row.title}**. Ask me what you need, then propose a new bar I can accept with one tap.`,
        ...(backLink ? ["", backLink] : []),
      ].join("\n");
      const issue = await issuesSvc.create(row.companyId, {
        title: `${setting ? "Set" : "Edit"} the bar for ${row.title}`,
        description,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        visibility: "private",
        responsibleUserId: row.ownerUserId,
        originKind: RESPONSIBILITY_BAR_ORIGIN_KIND,
        originId: row.id,
        createdByUserId: actor.userId,
        createdByAgentId: null,
        trustExplicitResponsibleUserId: true,
        workspaceSelectionActor: actor.authorizationActor,
        originRunId: actor.runId,
        originIdentityContextId: actor.identityContextId,
        actorRunId: actor.runId,
      });
      return { issue: issue as unknown as IssueRow, created: true };
    },

    /** The agent in a bar conversation proposes a bar. Nothing is written to the responsibility. */
    async propose(
      issueRef: { id: string; companyId: string },
      input: CreateResponsibilityBarProposal,
      actor: { agentId: string; runId: string | null },
    ) {
      await assertEnabled();
      const data = createResponsibilityBarProposalSchema.parse(input);
      const issue = await loadConversationIssue(issueRef);
      if (issue.status === "cancelled") {
        throw conflict("This bar conversation was cancelled", { code: "responsibility_bar_conversation_cancelled" });
      }
      if (issue.assigneeAgentId !== actor.agentId) {
        throw forbidden("Only the agent in this bar conversation can propose a bar");
      }
      const row = await loadResponsibility(issue.companyId, issue.originId!);
      assertOpenResponsibility(row);
      const payload = buildPayload(row, data);
      return interactions.createBarProposal(issue, {
        payload,
        title: "Proposed bar",
        summary: payload.bar.standard,
        createdByAgentId: actor.agentId,
        sourceRunId: actor.runId,
      });
    },

    /** The responsibility a conversation is about, for the route's writer check. */
    async responsibilityForConversation(issueRef: { id: string; companyId: string }) {
      const issue = await loadConversationIssue(issueRef);
      return { issue, responsibility: await loadResponsibility(issue.companyId, issue.originId!) };
    },

    /**
     * Apply the proposed bar, and the metric set it carries (its supporting
     * metrics replace the ones there), and settle the card, in one
     * transaction. `keepMetrics` (indexes into the proposal's supporting
     * metrics) applies only those; the rest are dropped, and the card records
     * which. The bar's own metric is always applied. The route checks the
     * writer rule first.
     */
    async accept(
      issueRef: { id: string; companyId: string },
      interactionId: string,
      actor: { userId: string },
      options: { keepMetrics?: readonly number[] } = {},
    ) {
      await assertEnabled();
      const issue = await loadConversationIssue(issueRef);
      const kept = (payload: ProposeResponsibilityBarPayload) => {
        const proposed = payload.metrics ?? null;
        if (options.keepMetrics === undefined) return { metrics: proposed, dropped: [] as string[] };
        if (proposed === null) {
          if (options.keepMetrics.length === 0) return { metrics: proposed, dropped: [] as string[] };
          throw unprocessable("This proposal carries no supporting metrics to keep", { code: "responsibility_bar_keep_metrics_invalid" });
        }
        const keep = new Set(options.keepMetrics);
        if ([...keep].some((index) => index >= proposed.length)) {
          throw unprocessable("keepMetrics names a supporting metric the proposal does not have", { code: "responsibility_bar_keep_metrics_invalid" });
        }
        return {
          metrics: proposed.filter((_, index) => keep.has(index)),
          dropped: proposed.filter((_, index) => !keep.has(index)).map((metric) => metric.title),
        };
      };
      const { interaction, applied } = await interactions.resolveBarProposal(
        issue,
        interactionId,
        "accepted",
        { userId: actor.userId },
        async (tx, current) => {
          if (current.payload.responsibilityId !== issue.originId) throw notFound("Interaction not found");
          const proposedBy = { agentId: current.createdByAgentId ?? null };
          const { metrics: keptMetrics } = kept(current.payload);
          const bar = await responsibilitiesSvc.applyBarInTx(
            tx,
            { id: current.payload.responsibilityId, companyId: issue.companyId },
            current.payload.bar,
            current.payload.metricCurrent,
            proposedBy,
          );
          const metrics = await metricsSvc.applyProposalInTx(tx, bar.after, { ...current.payload, metrics: keptMetrics }, proposedBy);
          return { ...bar, metrics: { ...metrics, kept: keptMetrics } };
        },
        (current) => {
          const { dropped } = kept(current.payload);
          return dropped.length > 0 ? { droppedMetrics: dropped } : {};
        },
      );
      return { interaction, before: applied!.before, after: applied!.after, metrics: applied!.metrics };
    },

    /** "Not right": the card closes and the conversation continues. */
    async decline(issueRef: { id: string; companyId: string }, interactionId: string, actor: { userId: string }) {
      await assertEnabled();
      const issue = await loadConversationIssue(issueRef);
      const { interaction } = await interactions.resolveBarProposal(issue, interactionId, "declined", { userId: actor.userId });
      return interaction;
    },

  };
}
