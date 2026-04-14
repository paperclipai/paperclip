/**
 * heartbeat-context.ts
 *
 * Context assembly for agent runs: morning briefing, channel messages,
 * pending mentions/deliberations, web research, quality examples,
 * task type classification, deadline urgency, goal context, etc.
 *
 * All functions here accept the mutable `context` Record and enrich it
 * in-place, returning nothing (or returning boolean for gating). All
 * operations are best-effort; failures are caught and logged as debug/warn.
 */

import { desc, and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import {
  agents,
  channelMessages,
  heartbeatRuns,
  issues,
  issueLabels,
  knowledgePages,
  labels,
  goals,
} from "@ironworksai/db";
import { logger } from "../middleware/logger.js";
import { buildMorningBriefing, detectContextDrift, getLatestSessionState } from "./session-state.js";
import {
  agentCognitiveLoad,
  channelHealth,
  ensureProjectChannel,
  findAgentDepartmentChannel,
  findCompanyChannel,
  generateOnboardingReplay,
  getHighSignalMessages,
  getPendingDeliberations,
  getPendingMentions,
} from "./channels.js";
import { webSearch, isResearchTask, extractSearchQuery } from "./web-search.js";
import { getQualityExamples } from "./quality-gate.js";
import { sanitizeForPrompt, PROMPT_MAX_LENGTHS } from "../lib/prompt-security.js";
import { lookupPlaybook } from "./playbook-rag.js";
import { CONFIDENCE_TAGGING_PROMPT } from "./confidence-tags.js";
import {
  classifyContextTier,
  classifyTaskType,
  PROMPT_TEMPLATES,
  readNonEmptyString,
} from "./heartbeat-types.js";
import { buildPlatformAwareness } from "./heartbeat-awareness.js";

// ── Session state + morning briefing ──────────────────────────────────────

export async function injectSessionContext(
  db: Db,
  context: Record<string, unknown>,
  agentId: string,
): Promise<void> {
  const contextTier = classifyContextTier(context);
  context.ironworksContextTier = contextTier;
  try {
    if (contextTier === "minimal") {
      const sessionState = await getLatestSessionState(db, agentId);
      if (sessionState) {
        context.ironworksSessionState = {
          lastAction: sessionState.lastAction,
          pendingWork: sessionState.pendingWork,
        };
      }
    } else if (contextTier === "standard" || contextTier === "full") {
      const agent = await db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (agent) {
        const briefing = await buildMorningBriefing(db, agentId, agent.companyId);
        if (briefing) {
          context.ironworksMorningBriefing = briefing;
        }
      }
    }
  } catch (err) {
    logger.warn({ err, agentId }, "failed to build session context for run");
  }
}

// ── Channel messages ───────────────────────────────────────────────────────

export async function injectChannelMessages(
  db: Db,
  context: Record<string, unknown>,
  agent: { id: string; companyId: string; role: string | null; department: string | null },
): Promise<void> {
  try {
    const CHANNEL_TOKEN_BUDGET = 2000;
    const agentRoleLower = (agent.role ?? "").toLowerCase();
    const isCeo = /\b(ceo|chief executive)\b/.test(agentRoleLower);
    const isCsuite = /\b(ceo|cto|cfo|cmo|coo|chief|vp|director)\b/.test(agentRoleLower);

    // CEO reads #company; all C-suite/directors also read #leadership
    const channelsToRead: Array<{ channel: Awaited<ReturnType<typeof findCompanyChannel>>; contextKey: string }> = [];

    if (isCeo) {
      const companyChannel = await findCompanyChannel(db, agent.companyId);
      if (companyChannel) channelsToRead.push({ channel: companyChannel, contextKey: "ironworksCompanyChannelUpdates" });
    }

    // C-suite and directors also read #leadership channel
    if (isCsuite) {
      const leadershipChannel = await findAgentDepartmentChannel(db, agent.companyId, "leadership");
      if (leadershipChannel) channelsToRead.push({ channel: leadershipChannel, contextKey: "ironworksLeadershipChannelUpdates" });
    }

    // Everyone reads their own department channel
    if (!isCeo) {
      const deptChannel = await findAgentDepartmentChannel(db, agent.companyId, agent.department ?? null);
      if (deptChannel) channelsToRead.push({ channel: deptChannel, contextKey: "ironworksTeamChannelUpdates" });
    }

    // Fetch messages from all relevant channels in parallel
    const budgetPerChannel = Math.floor(CHANNEL_TOKEN_BUDGET / Math.max(1, channelsToRead.length));
    const results = await Promise.all(
      channelsToRead.map(async ({ channel, contextKey }) => {
        if (!channel) return null;
        const msgs = await getHighSignalMessages(db, channel.id, agent.id, budgetPerChannel);
        return msgs.length > 0 ? { contextKey, msgs } : null;
      }),
    );

    for (const result of results) {
      if (!result) continue;
      context[result.contextKey] = result.msgs.map((m) => ({
        author: m.authorAgentId ?? m.authorUserId ?? "system",
        body: m.body,
        type: m.messageType,
        at: m.createdAt,
      }));
    }
  } catch (err) {
    logger.debug({ err, agentId: agent.id }, "channel context injection failed, skipping");
  }
}

// ── Channel posting instruction ────────────────────────────────────────────

export function injectChannelPostingInstruction(context: Record<string, unknown>): void {
  context.ironworksChannelPosting = `You can post messages to team channels by including this format in your response:

[CHANNEL #company] Your message here
[CHANNEL #engineering] Your message here
[CHANNEL #operations] Your message here

Use channels to:
- Share status updates on your current work
- Respond to @mentions from teammates
- Coordinate with other agents on cross-functional tasks
- Report blockers or request help
- Announce completed deliverables

Keep messages concise and substantive. Do not post empty status updates. If you have nothing new to report, do not post.`;
}

// ── Confidence tagging ─────────────────────────────────────────────────────

export function injectConfidenceTagging(context: Record<string, unknown>): void {
  context.ironworksConfidenceTagging = CONFIDENCE_TAGGING_PROMPT;
}

// ── Quality examples ───────────────────────────────────────────────────────

export async function injectQualityExamples(
  db: Db,
  context: Record<string, unknown>,
  agentId: string,
): Promise<void> {
  try {
    const qualityExamples = await getQualityExamples(db, agentId);
    if (qualityExamples.good.length > 0 || qualityExamples.bad.length > 0) {
      const sections: string[] = ["## Quality Reference Examples"];
      if (qualityExamples.good.length > 0) {
        sections.push("### Good Examples (emulate these):");
        for (const ex of qualityExamples.good) {
          sections.push(`- ${ex}`);
        }
      }
      if (qualityExamples.bad.length > 0) {
        sections.push("### Bad Examples (avoid these patterns):");
        for (const ex of qualityExamples.bad) {
          sections.push(`- ${ex}`);
        }
      }
      context.ironworksQualityExamples = sections.join("\n");
    }
  } catch (err) {
    logger.debug({ err, agentId }, "quality examples injection failed, skipping");
  }
}

// ── Onboarding replay ──────────────────────────────────────────────────────

export async function injectOnboardingReplay(
  db: Db,
  context: Record<string, unknown>,
  agent: { id: string; companyId: string; role: string | null; department: string | null },
): Promise<void> {
  try {
    const [agentPostCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(channelMessages)
      .where(eq(channelMessages.authorAgentId, agent.id));
    const isNewToChannels = Number(agentPostCount?.count ?? 0) === 0;

    if (isNewToChannels) {
      const agentRoleLower = (agent.role ?? "").toLowerCase();
      const isCeo = /\b(ceo|chief executive)\b/.test(agentRoleLower);
      const targetChannel = isCeo
        ? await findCompanyChannel(db, agent.companyId)
        : await findAgentDepartmentChannel(db, agent.companyId, agent.department ?? null);

      if (targetChannel) {
        const replay = await generateOnboardingReplay(db, targetChannel.id);
        if (replay.length > 0) {
          context.ironworksOnboardingReplay = replay;
        }
      }
    }
  } catch (err) {
    logger.debug({ err, agentId: agent.id }, "onboarding replay injection failed, skipping");
  }
}

// ── Pending mentions ───────────────────────────────────────────────────────

export async function injectPendingMentions(
  db: Db,
  context: Record<string, unknown>,
  agent: { id: string; companyId: string },
): Promise<void> {
  try {
    const mentions = await getPendingMentions(db, agent.id, agent.companyId);
    if (mentions.length > 0) {
      context.ironworksPendingMentions = mentions.map((m) => {
        const safeBody = sanitizeForPrompt(m.body ?? "", PROMPT_MAX_LENGTHS.comment);
        return {
          channel: `#${m.channelName}`,
          from: m.mentionedByName,
          body: safeBody,
          at: m.createdAt,
          instruction: `You were mentioned in #${m.channelName} by ${m.mentionedByName}: "${safeBody}". Please respond in that channel.`,
        };
      });
    }
  } catch (err) {
    logger.debug({ err, agentId: agent.id }, "pending mentions injection failed, skipping");
  }
}

// ── Pending deliberations ──────────────────────────────────────────────────

export async function injectPendingDeliberations(
  db: Db,
  context: Record<string, unknown>,
  agent: { id: string; companyId: string },
): Promise<void> {
  try {
    const pendingDeliberations = await getPendingDeliberations(db, agent.id, agent.companyId);
    if (pendingDeliberations.length > 0) {
      context.ironworksPendingDeliberations = pendingDeliberations.map((d) => ({
        deliberationId: d.deliberationId,
        channel: `#${d.channelName}`,
        topic: d.topic,
        instruction: `You are invited to a deliberation on "${d.topic}". Post your position as a reply in #${d.channelName}.`,
      }));
    }
  } catch (err) {
    logger.debug({ err, agentId: agent.id }, "pending deliberations injection failed, skipping");
  }
}

// ── Channel health ─────────────────────────────────────────────────────────

export async function injectChannelHealth(
  db: Db,
  context: Record<string, unknown>,
  agent: { id: string; companyId: string; role: string | null; department: string | null },
): Promise<void> {
  try {
    const agentRoleLower = (agent.role ?? "").toLowerCase();
    const isDeptHead = /\b(head|director|vp|lead|chief|manager)\b/.test(agentRoleLower);
    if (isDeptHead && agent.department) {
      const deptChannel = await findAgentDepartmentChannel(db, agent.companyId, agent.department);
      if (deptChannel) {
        const health = await channelHealth(db, deptChannel.id);
        if (health.status !== "healthy") {
          context.ironworksChannelHealth = {
            channel: `#${agent.department}`,
            status: health.status,
            messagesLast48h: health.messagesLast48h,
            decisionsLast7d: health.decisionsLast7d,
            circularTopicScore: health.circularTopicScore,
            advisory:
              health.status === "quiet"
                ? `Your #${agent.department} channel has been quiet. Consider posting a status update.`
                : health.status === "noisy"
                  ? `Your #${agent.department} channel is very active but has few decisions. Consider driving toward a resolution.`
                  : `Your #${agent.department} channel appears stalled on the same topics. Consider making a decision to move forward.`,
          };
        }
      }
    }
  } catch (err) {
    logger.debug({ err, agentId: agent.id }, "channel health injection failed, skipping");
  }
}

// ── Cognitive load ─────────────────────────────────────────────────────────

export async function injectCognitiveLoadReport(
  db: Db,
  context: Record<string, unknown>,
  agent: { id: string; companyId: string; role: string | null },
): Promise<void> {
  try {
    const isVpHr =
      /\b(vp|vice president|head|director)\b.*\b(hr|human resources|people)\b|\b(hr|human resources|people)\b.*\b(vp|vice president|head|director)\b/i.test(
        agent.role ?? "",
      );
    if (isVpHr) {
      const allAgents = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, agent.companyId), eq(agents.status, "active")));

      const loadResults = await Promise.all(
        allAgents.map(async (a) => {
          const load = await agentCognitiveLoad(db, a.id);
          return { name: a.name, ...load };
        }),
      );

      const overloaded = loadResults.filter((r) => r.loadScore > 80);
      const underutilized = loadResults.filter((r) => r.loadScore < 20);

      if (overloaded.length > 0 || underutilized.length > 0) {
        context.ironworksCognitiveLoadReport = {
          overloaded: overloaded.map((r) => ({
            name: r.name,
            score: r.loadScore,
            openIssues: r.openIssues,
          })),
          underutilized: underutilized.map((r) => ({
            name: r.name,
            score: r.loadScore,
            openIssues: r.openIssues,
          })),
          advisory:
            overloaded.length > 0
              ? `${overloaded.map((r) => r.name).join(", ")} appear overloaded. Consider redistributing tasks.`
              : `${underutilized.map((r) => r.name).join(", ")} have capacity for more work.`,
        };
      }
    }
  } catch (err) {
    logger.debug({ err, agentId: agent.id }, "cognitive load report injection failed, skipping");
  }
}

// ── Context drift ──────────────────────────────────────────────────────────

export async function injectContextDriftWarning(
  db: Db,
  context: Record<string, unknown>,
  agentId: string,
  companyId: string,
): Promise<void> {
  try {
    const [runCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.companyId, companyId)),
      );
    const totalRuns = Number(runCountRow?.count ?? 0);
    if (totalRuns % 5 === 0 && totalRuns > 0) {
      const currentObjective =
        typeof context.issueTitle === "string"
          ? context.issueTitle
          : typeof context.taskKey === "string"
            ? context.taskKey
            : typeof context.wakeReason === "string"
              ? context.wakeReason
              : "";
      if (currentObjective) {
        const driftResult = await detectContextDrift(db, agentId, currentObjective);
        if (driftResult.driftDetected && driftResult.recommendation) {
          context.ironworksDriftWarning = driftResult.recommendation;
        }
      }
    }
  } catch (err) {
    logger.debug({ err, agentId }, "context drift check failed, skipping");
  }
}

// ── Context utilization ────────────────────────────────────────────────────

export async function injectContextUtilizationNote(
  db: Db,
  context: Record<string, unknown>,
  agentId: string,
  companyId: string,
  totalInputTokens: number,
): Promise<void> {
  try {
    const runHistory = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "succeeded"),
        ),
      );
    const completedRuns = Number(runHistory[0]?.count ?? 1);
    const avgInputPerRun = completedRuns > 0 ? Math.round(totalInputTokens / completedRuns) : 0;

    const MODEL_DEFAULT_CONTEXT = 200_000;
    const utilizationPct =
      MODEL_DEFAULT_CONTEXT > 0
        ? Math.round((avgInputPerRun / MODEL_DEFAULT_CONTEXT) * 100)
        : 0;

    if (utilizationPct > 70) {
      context.ironworksContextNote = `Note: Your context window is ${utilizationPct}% full. Be concise in your responses. Focus on the most important information.`;
    }
  } catch (err) {
    logger.debug({ err, agentId }, "context utilization check failed, skipping");
  }
}

// ── Task type classification ───────────────────────────────────────────────

export async function injectTaskTypeClassification(
  db: Db,
  context: Record<string, unknown>,
  issueId: string | null,
  issueContext: { title: string } | null,
): Promise<void> {
  try {
    if (issueId && issueContext) {
      const issueLabelRows = await db
        .select({ name: labels.name })
        .from(issueLabels)
        .innerJoin(labels, eq(issueLabels.labelId, labels.id))
        .where(eq(issueLabels.issueId, issueId));
      const labelNames = issueLabelRows.map((r) => r.name);
      const taskType = classifyTaskType(issueContext.title ?? "", labelNames);
      context.ironworksTaskType = taskType;
      context.ironworksPromptTemplate = PROMPT_TEMPLATES[taskType];
    } else if (!issueId) {
      context.ironworksTaskType = "routine_check";
      context.ironworksPromptTemplate = PROMPT_TEMPLATES.routine_check;
    }
  } catch (err) {
    logger.debug({ err }, "task type classification failed, skipping");
  }
}

// ── Agent recent documents ─────────────────────────────────────────────────

export async function injectRecentDocuments(
  db: Db,
  context: Record<string, unknown>,
  agentId: string,
  companyId: string,
): Promise<void> {
  try {
    const taskType =
      typeof context.ironworksTaskType === "string" ? context.ironworksTaskType : "routine_check";
    if (taskType !== "routine_check") {
      const recentDocs = await db
        .select({
          title: knowledgePages.title,
          body: knowledgePages.body,
        })
        .from(knowledgePages)
        .where(
          and(
            eq(knowledgePages.agentId, agentId),
            eq(knowledgePages.companyId, companyId),
            sql`${knowledgePages.updatedAt} IS NOT NULL`,
          ),
        )
        .orderBy(desc(knowledgePages.updatedAt))
        .limit(5);

      if (recentDocs.length > 0) {
        const docLines = recentDocs.map(
          (doc) =>
            `- **${doc.title}**: ${doc.body.slice(0, 200)}${doc.body.length > 200 ? "..." : ""}`,
        );
        context.ironworksRecentDocuments = `## Your Recent Documents\n${docLines.join("\n")}`;
      }
    }
  } catch (err) {
    logger.debug({ err, agentId }, "agent recent documents injection failed, skipping");
  }
}

// ── Batched tasks ──────────────────────────────────────────────────────────

export async function injectBatchedTasks(
  db: Db,
  context: Record<string, unknown>,
  agentId: string,
  companyId: string,
  issueId: string | null,
): Promise<void> {
  try {
    if (!issueId) {
      const taskType =
        typeof context.ironworksTaskType === "string" ? context.ironworksTaskType : null;
      if (taskType && taskType !== "routine_check") {
        const queuedIssues = await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.assigneeAgentId, agentId),
              sql`${issues.status} in ('todo', 'in_progress')`,
            ),
          )
          .orderBy(desc(issues.createdAt))
          .limit(5);

        if (queuedIssues.length > 1) {
          const taskList = queuedIssues
            .map((i, idx) => `${idx + 1}. [${i.identifier ?? i.id.slice(0, 8)}] ${i.title}`)
            .join("\n");
          context.ironworksBatchedTasks = [
            `You have ${queuedIssues.length} similar tasks to address:`,
            taskList,
            "Address each briefly and efficiently in this session.",
          ].join("\n");
          logger.info(
            { agentId, batchCount: queuedIssues.length, taskType },
            "[batch-tasks] Batching similar tasks into single run",
          );
        }
      }
    }
  } catch (err) {
    logger.debug({ err, agentId }, "batch tasks assembly failed, skipping");
  }
}

// ── Web research ───────────────────────────────────────────────────────────

export async function injectWebResearch(
  db: Db,
  context: Record<string, unknown>,
  agentId: string,
  issueContext: { description?: string } | null,
): Promise<void> {
  try {
    const issueTitle = typeof context.issueTitle === "string" ? context.issueTitle : "";
    const issueDescription =
      issueContext && "description" in issueContext && typeof issueContext.description === "string"
        ? issueContext.description
        : "";
    const researchText = `${issueTitle} ${issueDescription}`.trim();
    if (researchText && isResearchTask(researchText)) {
      const searchQuery = extractSearchQuery(issueTitle || researchText);
      const searchResults = await webSearch(searchQuery, 3);
      if (searchResults.length > 0) {
        const resultLines = searchResults.map(
          (r, i) =>
            `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${sanitizeForPrompt(r.content.slice(0, 300), 300)}`,
        );
        context.ironworksWebResearch = [
          `## Web Research - ${searchQuery}`,
          "",
          ...resultLines,
        ].join("\n");
        logger.info(
          { agentId, query: searchQuery, resultCount: searchResults.length },
          "[web-search] injected web research into agent context",
        );
      }
    }
  } catch (err) {
    logger.debug({ err, agentId }, "web research injection failed, skipping");
  }
}

// ── Deadline urgency ───────────────────────────────────────────────────────

export async function injectDeadlineUrgency(
  db: Db,
  context: Record<string, unknown>,
  agentId: string,
  companyId: string,
): Promise<void> {
  try {
    const nowForDeadlines = new Date();
    const urgentCutoff = new Date(nowForDeadlines.getTime() + 24 * 60 * 60 * 1000);
    const soonCutoff = new Date(nowForDeadlines.getTime() + 72 * 60 * 60 * 1000);

    const assignedWithDeadlines = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        targetDate: issues.targetDate,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.assigneeAgentId, agentId),
          sql`${issues.status} not in ('done', 'cancelled')`,
          isNotNull(issues.targetDate),
        ),
      )
      .orderBy(issues.targetDate);

    if (assignedWithDeadlines.length > 0) {
      const deadlineLines = assignedWithDeadlines.map((issue) => {
        const td = issue.targetDate!;
        const diffMs = td.getTime() - nowForDeadlines.getTime();
        const diffMins = Math.round(diffMs / 60000);
        const ref = issue.identifier ? `[${issue.identifier}]` : `[${issue.id.slice(0, 8)}]`;
        if (diffMs < 0) {
          return `OVERDUE: ${ref} ${issue.title} (was due ${Math.abs(Math.round(diffMs / 86400000))} day(s) ago)`;
        } else if (td <= urgentCutoff) {
          return `URGENT: ${ref} ${issue.title} (due in ${Math.round(diffMins / 60)}h)`;
        } else if (td <= soonCutoff) {
          return `SOON: ${ref} ${issue.title} (due in ${Math.round(diffMins / 1440)}d)`;
        } else {
          return `UPCOMING: ${ref} ${issue.title} (due ${td.toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" })})`;
        }
      });
      context.ironworksUpcomingDeadlines = `You have ${assignedWithDeadlines.length} issues with deadlines:\n${deadlineLines.join("\n")}`;
    }
  } catch (err) {
    logger.debug({ err, agentId }, "deadline context injection failed, skipping");
  }
}

// ── Dependency context ─────────────────────────────────────────────────────

export async function injectDependencyContext(
  db: Db,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    const contextIssueIdForDeps = readNonEmptyString(context.issueId);
    if (contextIssueIdForDeps) {
      const [currentIssueForDeps] = await db
        .select({
          id: issues.id,
          dependsOn: issues.dependsOn,
          identifier: issues.identifier,
          title: issues.title,
        })
        .from(issues)
        .where(eq(issues.id, contextIssueIdForDeps))
        .limit(1);

      if (
        currentIssueForDeps &&
        Array.isArray(currentIssueForDeps.dependsOn) &&
        currentIssueForDeps.dependsOn.length > 0
      ) {
        const blockingIssues = await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
          })
          .from(issues)
          .where(
            sql`${issues.id}::text = ANY(${JSON.stringify(currentIssueForDeps.dependsOn)}::text[])`,
          );

        const pendingBlockers = blockingIssues.filter((i) => i.status !== "done");
        if (pendingBlockers.length > 0) {
          const blockerList = pendingBlockers
            .map((i) => {
              const ref = i.identifier ? `[${i.identifier}]` : `[${i.id.slice(0, 8)}]`;
              return `${ref} ${i.title} (${i.status})`;
            })
            .join(", ");
          context.ironworksDependencyContext = `This issue is BLOCKED by: ${blockerList}. Do not start work on this issue until all blockers are done.`;
        } else {
          context.ironworksDependencyContext =
            "All dependencies for this issue are complete. You can proceed.";
        }
      }
    }
  } catch (err) {
    logger.debug({ err }, "dependency context injection failed, skipping");
  }
}

// ── Platform awareness ─────────────────────────────────────────────────────

/**
 * Injects a comprehensive platform awareness block into the agent context.
 * This runs for EVERY heartbeat regardless of whether an issue is assigned,
 * giving the agent a full mental model of their capabilities at all times.
 */
export function injectPlatformAwareness(
  context: Record<string, unknown>,
  agent: { name: string; role: string | null; department: string | null },
): void {
  context.ironworksPlatformAwareness = buildPlatformAwareness(agent);
}

// ── Goal context ───────────────────────────────────────────────────────────

export async function injectGoalContext(
  db: Db,
  context: Record<string, unknown>,
  issueGoalId: string | null,
): Promise<void> {
  try {
    if (issueGoalId) {
      const [goalRow] = await db
        .select({
          title: goals.title,
          healthStatus: goals.healthStatus,
          healthScore: goals.healthScore,
          confidence: goals.confidence,
          targetDate: goals.targetDate,
        })
        .from(goals)
        .where(eq(goals.id, issueGoalId))
        .limit(1);

      if (goalRow) {
        const targetDateStr = goalRow.targetDate
          ? new Date(goalRow.targetDate).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })
          : "Not set";
        const healthLabel = (goalRow.healthStatus ?? "no_data").replace(/_/g, " ");
        const progressNote = goalRow.healthScore != null ? `${goalRow.healthScore}%` : "unknown";
        context.ironworksGoalContext =
          `You are working on an issue that advances the goal "${goalRow.title}" ` +
          `which is currently ${progressNote} complete with health status ${healthLabel}. ` +
          `Target date: ${targetDateStr}. Confidence: ${goalRow.confidence ?? 50}%.`;
      }
    }
  } catch (err) {
    logger.debug({ err }, "goal context injection failed, skipping");
  }
}

// ── Playbook RAG: inject top-K relevant chunks based on task context ──────

/**
 * Auto-retrieve relevant playbook chunks via RAG and inject them into the
 * agent's system context. Transparent to the agent — it just sees the
 * relevant guidance in its prompt instead of the full 50k-token playbook.
 *
 * Query strategy:
 *   - If there's an active issue: use "<issue title>. <description>"
 *   - If there's a latest channel message: use that
 *   - If routine check-in: skip (no meaningful query, agent already has
 *     playbook overview in its instructions)
 *
 * Filters: department (from agent), owner_role (agent's role), documentType=playbook.
 * topK=3 keeps the injection ~2-4k tokens (well within budget).
 *
 * Per-agent session cache (1hr TTL) means subsequent heartbeats with the
 * same task don't re-embed or re-query.
 *
 * Feature flag: IRONWORKS_PLAYBOOK_RAG=false disables (default is on).
 */
export async function injectPlaybookGuidance(
  db: Db,
  context: Record<string, unknown>,
  agent: { id: string; companyId: string; role: string; department: string | null },
  issueTitle: string | null,
  issueDescription: string | null,
): Promise<void> {
  if (process.env.IRONWORKS_PLAYBOOK_RAG === "false") return;

  try {
    // Build query from the most specific context available
    let query = "";
    if (issueTitle) {
      query = issueTitle;
      if (issueDescription) {
        query += ". " + issueDescription.slice(0, 500);
      }
    } else {
      // Fall back to latest comment if present
      const latestComment = typeof context.latestComment === "string" ? context.latestComment : "";
      if (latestComment.length >= 20) {
        query = latestComment.slice(0, 500);
      }
    }

    // No meaningful query -> don't run lookup (spam prevention).
    // Agent still has playbook section overview via instructions + scanning KB.
    if (!query || query.trim().length < 10) return;

    const chunks = await lookupPlaybook(db, {
      companyId: agent.companyId,
      query,
      department: agent.department ?? undefined,
      ownerRole: agent.role,
      documentType: "playbook",
      topK: 3,
      agentId: agent.id,
    });

    if (chunks.length === 0) return;

    // Format chunks as a compact system message. Each chunk stays ≤ 1200 chars
    // so the total stays under ~4k tokens even with 3 chunks.
    const lines: string[] = [];
    lines.push("## Relevant Playbook Guidance");
    lines.push("");
    lines.push(
      `The following sections from your playbook library best match the current task. ` +
        `Apply their discipline; they are retrieval-augmented context, not suggestions.`,
    );
    lines.push("");

    for (const chunk of chunks) {
      const body = chunk.body.length > 1200 ? chunk.body.slice(0, 1200) + "..." : chunk.body;
      lines.push(`### ${chunk.headingPath}`);
      lines.push("");
      lines.push(body);
      lines.push("");
    }

    context.ironworksPlaybookGuidance = lines.join("\n");
    logger.info(
      {
        agentId: agent.id,
        chunks: chunks.length,
        mode: chunks[0].mode,
        queryPrefix: query.slice(0, 60),
      },
      "playbook RAG: injected guidance chunks",
    );
  } catch (err) {
    // Never break the heartbeat run because of a lookup failure
    logger.debug({ err: (err as Error).message, agentId: agent.id }, "playbook RAG injection failed, skipping");
  }
}
