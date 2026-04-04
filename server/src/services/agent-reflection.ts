import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agentMemoryEntries, agents, heartbeatRuns, issueLabels, issues, labels } from "@ironworksai/db";
import { logger } from "../middleware/logger.js";

// ── Agent Reflection Services ──────────────────────────────────────────────
//
// Post-task self-improvement capabilities:
//   - performPostTaskReflection: creates reflection entries after issue completion/cancellation
//   - extractLessonFromRejection: stores lesson-learned entries when approvals are rejected
//   - identifySkillGaps: analyzes success/failure rates by label to find weak areas

/**
 * Called after an issue is completed or cancelled.
 *
 * Creates memory entries to help the agent learn from experience:
 *   - Cancelled tasks: records a mistake_learning entry
 *   - Difficult tasks (>5 runs): records a note about difficulty
 *   - Always: records a task_reflection summary
 *   - Tracks skill effectiveness via issue labels
 */
export async function performPostTaskReflection(
  db: Db,
  opts: {
    agentId: string;
    companyId: string;
    issueId: string;
    issueTitle: string;
    outcome: "completed" | "cancelled";
    runCount?: number;
  },
): Promise<void> {
  const now = new Date();

  // Compute runCount from heartbeat runs if not provided
  let runCount = opts.runCount ?? 0;
  if (runCount === 0) {
    const runResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, opts.agentId),
          eq(heartbeatRuns.companyId, opts.companyId),
          // Count runs that had this issue in their context
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${opts.issueId}`,
        ),
      );
    runCount = Number(runResult[0]?.count ?? 0);
  }

  // Cancelled: record mistake learning
  if (opts.outcome === "cancelled") {
    await db.insert(agentMemoryEntries).values({
      agentId: opts.agentId,
      companyId: opts.companyId,
      memoryType: "episodic",
      category: "mistake_learning",
      content: `Task cancelled: "${opts.issueTitle}". This task was attempted but ultimately cancelled. Review what blocked progress to avoid similar outcomes.`,
      sourceIssueId: opts.issueId,
      confidence: 75,
      lastAccessedAt: now,
    });
  }

  // Completed but took many iterations: record difficulty
  if (opts.outcome === "completed" && runCount > 5) {
    await db.insert(agentMemoryEntries).values({
      agentId: opts.agentId,
      companyId: opts.companyId,
      memoryType: "episodic",
      category: "task_reflection",
      content: `Difficult task completed: "${opts.issueTitle}". Required ${runCount} runs to finish. Consider breaking similar tasks into smaller pieces or requesting clarification earlier.`,
      sourceIssueId: opts.issueId,
      confidence: 70,
      lastAccessedAt: now,
    });
  }

  // Always: create a task reflection summary
  await db.insert(agentMemoryEntries).values({
    agentId: opts.agentId,
    companyId: opts.companyId,
    memoryType: "episodic",
    category: "task_reflection",
    content: `Task ${opts.outcome}: "${opts.issueTitle}" (${runCount} run${runCount === 1 ? "" : "s"}).`,
    sourceIssueId: opts.issueId,
    confidence: 80,
    lastAccessedAt: now,
  });

  // Track skill effectiveness: log which labels were on this issue
  const issueSkills = await db
    .select({ labelName: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(eq(issueLabels.issueId, opts.issueId));

  if (issueSkills.length > 0) {
    const skillNames = issueSkills.map((s) => s.labelName).join(", ");
    await db.insert(agentMemoryEntries).values({
      agentId: opts.agentId,
      companyId: opts.companyId,
      memoryType: "episodic",
      category: "skill_effectiveness",
      content: `Skills used on ${opts.outcome} task "${opts.issueTitle}": ${skillNames}`,
      sourceIssueId: opts.issueId,
      confidence: 75,
      lastAccessedAt: now,
    });
  }

  logger.info(
    { agentId: opts.agentId, issueId: opts.issueId, outcome: opts.outcome, runCount: runCount },
    "performed post-task reflection",
  );
}

/**
 * Extract a lesson from an approval rejection and store as procedural memory.
 *
 * When an approval is rejected, the rejection reason is stored so the agent
 * can reference it to avoid repeating similar mistakes.
 */
export async function extractLessonFromRejection(
  db: Db,
  opts: {
    agentId: string;
    companyId: string;
    issueId: string;
    rejectionReason: string;
  },
): Promise<void> {
  const now = new Date();

  await db.insert(agentMemoryEntries).values({
    agentId: opts.agentId,
    companyId: opts.companyId,
    memoryType: "procedural",
    category: "lesson_learned",
    content: `Approval rejected: ${opts.rejectionReason}. Adjust approach on similar future requests to address this feedback.`,
    sourceIssueId: opts.issueId,
    confidence: 85,
    lastAccessedAt: now,
  });

  logger.info(
    { agentId: opts.agentId, issueId: opts.issueId },
    "extracted lesson from approval rejection",
  );
}

/**
 * Identify skill gaps for an agent by analyzing success/failure rates per label.
 *
 * Queries all completed and cancelled issues assigned to this agent,
 * groups by label, and returns skills where success rate is below 70%.
 */
export async function identifySkillGaps(
  db: Db,
  agentId: string,
  companyId: string,
): Promise<Array<{ skill: string; successRate: number; totalTasks: number }>> {
  // Get all resolved issues (done or cancelled) for this agent, with their labels
  const resolvedWithLabels = await db
    .select({
      issueId: issues.id,
      status: issues.status,
      labelName: labels.name,
    })
    .from(issues)
    .innerJoin(issueLabels, eq(issues.id, issueLabels.issueId))
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        sql`${issues.status} in ('done', 'cancelled')`,
      ),
    );

  if (resolvedWithLabels.length === 0) return [];

  // Group by label
  const skillStats = new Map<string, { completed: number; total: number }>();
  for (const row of resolvedWithLabels) {
    const stats = skillStats.get(row.labelName) ?? { completed: 0, total: 0 };
    stats.total++;
    if (row.status === "done") stats.completed++;
    skillStats.set(row.labelName, stats);
  }

  // Find gaps (success rate below 70%)
  const gaps: Array<{ skill: string; successRate: number; totalTasks: number }> = [];
  for (const [skill, stats] of skillStats) {
    if (stats.total < 2) continue; // Need at least 2 tasks to evaluate
    const successRate = Math.round((stats.completed / stats.total) * 100);
    if (successRate < 70) {
      gaps.push({ skill, successRate, totalTasks: stats.total });
    }
  }

  // Store as periodic memory entry for VP HR reference
  if (gaps.length > 0) {
    const now = new Date();
    const gapSummary = gaps
      .map((g) => `${g.skill}: ${g.successRate}% success (${g.totalTasks} tasks)`)
      .join("; ");

    await db.insert(agentMemoryEntries).values({
      agentId,
      companyId,
      memoryType: "semantic",
      category: "skill_gap_analysis",
      content: `Skill gaps identified: ${gapSummary}`,
      confidence: 70,
      lastAccessedAt: now,
    });

    logger.info(
      { agentId, companyId, gapCount: gaps.length },
      "identified skill gaps for agent",
    );
  }

  return gaps;
}

// ── Structured Handoff Protocol ───────────────────────────────────────────
//
// When one agent completes an issue and the next assignee is different, this
// creates a structured handoff issue assigned to the receiving agent with full
// context from the source issue.

/**
 * Create a structured handoff issue for cross-agent task transitions.
 *
 * Generates a new issue assigned to the receiving agent with a formatted body
 * containing the summary, decisions, artifacts, and next steps from the source.
 */
export async function createHandoffIssue(
  db: Db,
  opts: {
    companyId: string;
    fromAgentId: string;
    toAgentId: string;
    sourceIssueId: string;
    summary: string;
    keyDecisions: string;
    artifacts: string;
    nextSteps?: string;
  },
): Promise<void> {
  // Resolve agent names
  const [fromAgent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, opts.fromAgentId))
    .limit(1);

  const [toAgent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, opts.toAgentId))
    .limit(1);

  // Resolve source issue
  const [sourceIssue] = await db
    .select({
      title: issues.title,
      identifier: issues.identifier,
      projectId: issues.projectId,
      goalId: issues.goalId,
    })
    .from(issues)
    .where(eq(issues.id, opts.sourceIssueId))
    .limit(1);

  const fromName = fromAgent?.name ?? opts.fromAgentId;
  const sourceRef = sourceIssue?.identifier ?? opts.sourceIssueId.slice(0, 8);
  const sourceTitle = sourceIssue?.title ?? "Unknown issue";

  const body = [
    `## Handoff from ${fromName}`,
    `**Source:** ${sourceRef} - ${sourceTitle}`,
    "",
    "### Summary",
    opts.summary,
    "",
    "### Key Decisions",
    opts.keyDecisions,
    "",
    "### Artifacts",
    opts.artifacts,
    "",
    "### Next Steps",
    opts.nextSteps ?? "Continue from where the previous agent left off. Review the source issue for full context.",
  ].join("\n");

  await db.insert(issues).values({
    companyId: opts.companyId,
    projectId: sourceIssue?.projectId ?? null,
    goalId: sourceIssue?.goalId ?? null,
    title: `Handoff: ${sourceTitle}`,
    description: body,
    status: "todo",
    priority: "medium",
    assigneeAgentId: opts.toAgentId,
    createdByAgentId: opts.fromAgentId,
    originKind: "handoff",
    originId: opts.sourceIssueId,
  });

  logger.info(
    {
      companyId: opts.companyId,
      fromAgentId: opts.fromAgentId,
      toAgentId: opts.toAgentId,
      sourceIssueId: opts.sourceIssueId,
    },
    "created structured handoff issue",
  );
}
