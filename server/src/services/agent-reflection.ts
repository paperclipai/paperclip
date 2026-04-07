import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agentMemoryEntries, agents, approvals, heartbeatRuns, issueApprovals, issueLabels, issues, labels } from "@ironworksai/db";
import { logger } from "../middleware/logger.js";
import { createDecisionRecord, updateTechDebtRegister } from "./agent-workspace.js";

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
  const reflectionContent = opts.outcome === "completed"
    ? `Task completed: ${opts.issueTitle}. Runs: ${runCount}. ${runCount > 5 ? "This was a complex task requiring multiple iterations." : "Completed efficiently."}`
    : `Task cancelled: ${opts.issueTitle}. Runs: ${runCount}. Review what went wrong.`;

  await db.insert(agentMemoryEntries).values({
    agentId: opts.agentId,
    companyId: opts.companyId,
    memoryType: "episodic",
    category: "task_reflection",
    content: reflectionContent,
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

  // Auto-create Architecture Decision Records for technical roles on completed issues
  if (opts.outcome === "completed") {
    try {
      // Resolve agent role
      const [agentRow] = await db
        .select({ role: agents.role })
        .from(agents)
        .where(eq(agents.id, opts.agentId))
        .limit(1);

      const role = (agentRow?.role ?? "").toLowerCase().replace(/[\s_-]+/g, "");
      const isTechnicalRole =
        role.includes("cto") ||
        role.includes("seniorengineer") ||
        role.includes("engineer") ||
        role.includes("devops") ||
        role.includes("developer") ||
        role.includes("architect");

      if (isTechnicalRole) {
        const TECHNICAL_KEYWORDS = [
          "architecture", "design", "infrastructure", "migration",
          "database", "api", "schema", "deploy", "refactor",
          "integration", "service", "protocol", "specification",
        ];
        const haystack = `${opts.issueTitle}`.toLowerCase();
        const hasTechnicalContent = TECHNICAL_KEYWORDS.some((kw) => haystack.includes(kw));

        if (hasTechnicalContent) {
          // Fetch full issue description for richer context
          const [issueRow] = await db
            .select({ description: issues.description })
            .from(issues)
            .where(eq(issues.id, opts.issueId))
            .limit(1);

          const context = issueRow?.description
            ? `Issue: ${opts.issueTitle}\n\n${issueRow.description.slice(0, 800)}`
            : `Issue: ${opts.issueTitle}`;

          await createDecisionRecord(db, {
            companyId: opts.companyId,
            agentId: opts.agentId,
            title: opts.issueTitle,
            context,
            decision: `This decision was recorded automatically upon completion of the issue: "${opts.issueTitle}".`,
            consequences: "Review this ADR and update with detailed context, alternatives considered, and long-term implications.",
            status: "accepted",
          });

          logger.info(
            { agentId: opts.agentId, issueId: opts.issueId, role },
            "auto-created architecture decision record",
          );
        }
      }
    } catch (err) {
      // ADR creation is best-effort; don't fail the reflection
      logger.warn({ err, agentId: opts.agentId, issueId: opts.issueId }, "failed to auto-create ADR");
    }
  }

  // Tech Debt Register: if any label is "tech_debt", append an entry
  if (opts.outcome === "completed" && issueSkills.some((s) => s.labelName === "tech_debt")) {
    try {
      const [issueDetail] = await db
        .select({ description: issues.description })
        .from(issues)
        .where(eq(issues.id, opts.issueId))
        .limit(1);

      const [agentRow] = await db
        .select({ role: agents.role })
        .from(agents)
        .where(eq(agents.id, opts.agentId))
        .limit(1);

      const description = issueDetail?.description
        ? issueDetail.description.replace(/\n+/g, " ").slice(0, 200)
        : `Completed by ${agentRow?.role ?? "agent"}.`;

      await updateTechDebtRegister(db, opts.companyId, {
        title: opts.issueTitle,
        severity: "medium",
        description,
      });
    } catch (err) {
      logger.warn({ err, agentId: opts.agentId, issueId: opts.issueId }, "failed to update tech debt register");
    }
  }

  // Quality review: assess whether the agent's completed output meets quality bar.
  // Runs on completed issues only - uses the issue description as content proxy.
  if (opts.outcome === "completed") {
    try {
      const [issueForQuality] = await db
        .select({ description: issues.description })
        .from(issues)
        .where(eq(issues.id, opts.issueId))
        .limit(1);

      const contentToReview = issueForQuality?.description
        ? `${opts.issueTitle}\n\n${issueForQuality.description}`
        : opts.issueTitle;

      const qualityResult = reviewOutputQuality(contentToReview);

      if (!qualityResult.isAcceptable) {
        const now = new Date();
        await db.insert(agentMemoryEntries).values({
          agentId: opts.agentId,
          companyId: opts.companyId,
          memoryType: "episodic",
          category: "quality_flag",
          content: `Output quality below threshold (score: ${qualityResult.score}/100) for task "${opts.issueTitle}". Issues: ${qualityResult.issues.join(" ")} - Flagged for human review.`,
          sourceIssueId: opts.issueId,
          confidence: 60,
          lastAccessedAt: now,
        });

        logger.warn(
          { agentId: opts.agentId, issueId: opts.issueId, score: qualityResult.score, qualityIssues: qualityResult.issues },
          "agent output flagged for quality review",
        );
      }
    } catch (err) {
      // Quality review is best-effort; don't fail the reflection
      logger.debug({ err, agentId: opts.agentId, issueId: opts.issueId }, "quality review failed");
    }
  }

  // ── Quality gate lesson (REQ-11) ──
  // If the issue had a quality gate approval, include the quality score
  // and feedback in a "lesson" memory entry for the agent learning system.
  if (opts.outcome === "completed") {
    try {
      const qualityApprovals = await db
        .select({
          status: approvals.status,
          payload: approvals.payload,
          decisionNote: approvals.decisionNote,
        })
        .from(approvals)
        .innerJoin(issueApprovals, eq(approvals.id, issueApprovals.approvalId))
        .where(
          and(
            eq(issueApprovals.issueId, opts.issueId),
            eq(approvals.type, "quality_gate"),
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .limit(1);

      if (qualityApprovals.length > 0) {
        const qa = qualityApprovals[0]!;
        const payload = qa.payload as Record<string, unknown>;
        const score = typeof payload.score === "number" ? payload.score : null;
        const wasRejected = qa.status === "rejected";
        const feedback = qa.decisionNote ?? (wasRejected ? "Rejected by quality gate" : null);

        const lessonContent = JSON.stringify({
          type: "lesson",
          source: "quality_gate",
          issueId: opts.issueId,
          issueTitle: opts.issueTitle,
          score,
          feedback,
          whatToImprove: wasRejected
            ? `Quality gate rejected this task. ${feedback ?? "Review the feedback and adjust approach."}`
            : score !== null && score < 7
              ? `Quality score was ${score}/10. Focus on improving output quality.`
              : null,
        });

        await db.insert(agentMemoryEntries).values({
          agentId: opts.agentId,
          companyId: opts.companyId,
          memoryType: "episodic",
          category: "lesson",
          content: lessonContent,
          sourceIssueId: opts.issueId,
          confidence: wasRejected ? 90 : 75,
          lastAccessedAt: now,
        });

        logger.info(
          { agentId: opts.agentId, issueId: opts.issueId, score, wasRejected },
          "created quality gate lesson from post-task reflection",
        );
      }
    } catch (err) {
      logger.debug({ err, agentId: opts.agentId, issueId: opts.issueId }, "quality gate lesson creation failed");
    }
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

// ── Agent Output Quality Review ───────────────────────────────────────────

export interface OutputQualityResult {
  score: number;       // 0-100
  isAcceptable: boolean; // score >= 60
  issues: string[];
}

// Common filler phrases used for boilerplate detection
const FILLER_PHRASES = [
  "i hope this helps",
  "please let me know",
  "feel free to",
  "as mentioned",
  "as noted above",
  "in conclusion",
  "in summary",
  "to summarize",
  "thank you for",
  "thanks for",
  "i'd be happy to",
  "i would be happy to",
  "don't hesitate to",
  "do not hesitate to",
  "looking forward to",
  "best regards",
  "kind regards",
  "sincerely",
  "hope that helps",
  "let me know if you need",
];

/**
 * Heuristic quality review of agent output content.
 * Does NOT call an LLM - uses rule-based checks.
 *
 * Scoring:
 *   - Starts at 100 and deducts for each failing check
 *   - Length < 50 chars: -40 (likely empty/stub response)
 *   - Single line with no structure: -20
 *   - No headings for long content (>300 chars): -10
 *   - Ends mid-sentence: -20
 *   - High boilerplate ratio (>60%): -30
 */
export function reviewOutputQuality(content: string): OutputQualityResult {
  const qualityIssues: string[] = [];
  let score = 100;

  const trimmed = content.trim();
  const charCount = trimmed.length;
  const lineCount = trimmed.split("\n").filter((l) => l.trim().length > 0).length;

  // Check 1: Length
  if (charCount < 50) {
    score -= 40;
    qualityIssues.push(`Content too short (${charCount} chars). Minimum is 50 chars for a meaningful response.`);
  }

  // Check 2: Structure - single line with no paragraphs for longer content
  if (charCount > 100 && lineCount <= 1) {
    score -= 20;
    qualityIssues.push("Response is a single line with no structure. Consider using paragraphs or headings.");
  }

  // Check 3: Headings for longer reports
  if (charCount > 300) {
    const hasHeadings = /^#{1,6}\s+\S/m.test(trimmed) || /^[A-Z][^\n]{5,50}\n[-=]{3,}/m.test(trimmed);
    if (!hasHeadings) {
      score -= 10;
      qualityIssues.push("Long response lacks headings or clear sections.");
    }
  }

  // Check 4: Ends mid-sentence (no terminal punctuation on last non-empty line)
  const lastLine = trimmed.split("\n").filter((l) => l.trim().length > 0).pop() ?? "";
  const lastChar = lastLine.trimEnd().slice(-1);
  const validTerminators = new Set([".", "!", "?", ":", ";", ")", "]", "`", '"', "'"]);
  // Markdown code blocks or list items ending with content are acceptable
  const isCodeBlock = lastLine.trim().startsWith("```") || lastLine.trim().startsWith("~~~");
  const isListItem = /^[-*+\d.]\s/.test(lastLine.trim());
  if (charCount > 100 && !validTerminators.has(lastChar) && !isCodeBlock && !isListItem) {
    score -= 20;
    qualityIssues.push("Response appears to end mid-sentence (no terminal punctuation on last line).");
  }

  // Check 5: Boilerplate ratio
  const lowerContent = trimmed.toLowerCase();
  const wordCount = lowerContent.split(/\s+/).length;
  if (wordCount > 10) {
    let fillerWordCount = 0;
    for (const phrase of FILLER_PHRASES) {
      const phraseWords = phrase.split(/\s+/).length;
      let searchFrom = 0;
      while (true) {
        const idx = lowerContent.indexOf(phrase, searchFrom);
        if (idx === -1) break;
        fillerWordCount += phraseWords;
        searchFrom = idx + phrase.length;
      }
    }
    const fillerRatio = fillerWordCount / wordCount;
    if (fillerRatio > 0.6) {
      score -= 30;
      qualityIssues.push(
        `High boilerplate ratio (${(fillerRatio * 100).toFixed(0)}% filler phrases). Response may lack substantive content.`,
      );
    }
  }

  const finalScore = Math.max(0, Math.min(100, score));
  return {
    score: finalScore,
    isAcceptable: finalScore >= 60,
    issues: qualityIssues,
  };
}

// ── Karpathy Self-Optimization Loop ──────────────────────────────────────

export interface PromptOptimizationResult {
  currentPromptHash: string;
  suggestedChange: string | null;
  reasoning: string;
}

/**
 * Analyze recent agent performance and suggest prompt improvements.
 * Heuristic-based, no AI calls. Results are saved as a "prompt_suggestion"
 * memory entry for human review.
 *
 * Analyzes:
 *   1. Success rate on last 20 completed/cancelled issues
 *   2. Average run count per issue (from heartbeat runs)
 *   3. Recurring mistake_learning memory entries (suggests prompt gaps)
 */
export async function generatePromptOptimizationSuggestion(
  db: Db,
  agentId: string,
): Promise<PromptOptimizationResult> {
  // Resolve current agent for prompt hash
  const [agentRow] = await db
    .select({ role: agents.role, name: agents.name, companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agentRow) {
    return {
      currentPromptHash: "unknown",
      suggestedChange: null,
      reasoning: "Agent not found.",
    };
  }

  // Derive a stable hash from role + name (no crypto import needed)
  const promptSeed = `${agentRow.role ?? "unknown"}:${agentRow.name ?? "unknown"}`;
  const currentPromptHash = simpleHash(promptSeed);

  // Fetch last 20 resolved issues for this agent
  const recentIssues = await db
    .select({
      id: issues.id,
      status: issues.status,
    })
    .from(issues)
    .where(
      and(
        eq(issues.assigneeAgentId, agentId),
        sql`${issues.status} IN ('done', 'cancelled')`,
      ),
    )
    .orderBy(desc(issues.completedAt))
    .limit(20);

  const total = recentIssues.length;
  const completed = recentIssues.filter((i) => i.status === "done").length;
  const successRate = total > 0 ? completed / total : 1;

  // Average run count per issue (count heartbeat runs per issue)
  let avgRunCount = 0;
  if (total > 0) {
    const issueIds = recentIssues.map((i) => i.id);
    const runCounts = await db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ANY(ARRAY[${sql.join(issueIds.map((id) => sql`${id}`), sql`, `)}])`,
        ),
      );
    const totalRuns = Number(runCounts[0]?.count ?? 0);
    avgRunCount = totalRuns / total;
  }

  // Recurring mistake_learning entries suggest specific prompt gaps
  const mistakeEntries = await db
    .select({ content: agentMemoryEntries.content })
    .from(agentMemoryEntries)
    .where(
      and(
        eq(agentMemoryEntries.agentId, agentId),
        eq(agentMemoryEntries.category, "mistake_learning"),
        isNull(agentMemoryEntries.archivedAt),
      ),
    )
    .orderBy(desc(agentMemoryEntries.createdAt))
    .limit(10);

  // Build suggestion
  const suggestions: string[] = [];

  if (successRate < 0.7 && total >= 3) {
    suggestions.push(
      `Add more specific instructions for the most common failing task types. ` +
      `Success rate is ${(successRate * 100).toFixed(0)}% (${completed}/${total} tasks).`,
    );
  }

  if (avgRunCount > 8) {
    suggestions.push(
      `Consider breaking complex tasks into sub-tasks. ` +
      `Average run count is ${avgRunCount.toFixed(1)} per task (threshold: 8).`,
    );
  }

  if (mistakeEntries.length >= 3) {
    // Extract keywords from mistake entries to identify patterns
    const mistakeTexts = mistakeEntries.map((e) => e.content).join(" ");
    const keywords = extractTopKeywords(mistakeTexts, 5);
    if (keywords.length > 0) {
      suggestions.push(
        `Add explicit "DO NOT" instructions for recurring issues. ` +
        `Recurring patterns in mistake log: ${keywords.join(", ")}.`,
      );
    }
  }

  const suggestedChange = suggestions.length > 0 ? suggestions.join(" ") : null;
  const reasoning = total < 3
    ? `Insufficient task history (${total} resolved tasks). Rerun after more tasks complete.`
    : [
        `Analyzed ${total} recent tasks.`,
        `Success rate: ${(successRate * 100).toFixed(0)}%.`,
        `Avg runs/task: ${avgRunCount.toFixed(1)}.`,
        `Mistake entries: ${mistakeEntries.length}.`,
      ].join(" ");

  // Save as prompt_suggestion memory entry for human review
  if (suggestedChange) {
    const now = new Date();
    await db.insert(agentMemoryEntries).values({
      agentId,
      companyId: agentRow.companyId,
      memoryType: "semantic",
      category: "prompt_suggestion",
      content: `Prompt optimization suggestion (hash: ${currentPromptHash}): ${suggestedChange} Reasoning: ${reasoning}`,
      confidence: 65,
      lastAccessedAt: now,
    });

    logger.info(
      { agentId, successRate, avgRunCount, mistakeCount: mistakeEntries.length },
      "generated prompt optimization suggestion",
    );
  }

  return { currentPromptHash, suggestedChange, reasoning };
}

// ── Reflection helpers ─────────────────────────────────────────────────────

/** Simple non-crypto hash for stable agent prompt fingerprinting. */
function simpleHash(input: string): string {
  let hash = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // FNV prime, keep as 32-bit unsigned
  }
  return hash.toString(16).padStart(8, "0");
}

const KEYWORD_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "was", "are", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "not", "this",
  "that", "these", "those", "it", "its", "as", "if", "so", "up", "out",
  "task", "issue", "work", "agent", "completed", "cancelled", "attempted",
]);

/** Extract top N keywords by frequency from a text blob. */
function extractTopKeywords(text: string, n: number): string[] {
  const freq = new Map<string, number>();
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !KEYWORD_STOP_WORDS.has(w));

  for (const word of words) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([word]) => word);
}
