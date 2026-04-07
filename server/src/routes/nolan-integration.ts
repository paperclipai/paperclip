import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import {
  agents,
  agentMemoryEntries,
  approvals,
  issueApprovals,
  workflowMaturity,
} from "@ironworksai/db";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logger } from "../middleware/logger.js";
import { checkAllAgentDrift, detectQualityDrift } from "../services/quality-drift.js";
import { getAgentLessons } from "../services/agent-learning.js";

// ── Nolan Integration Points (REQ-12) ─────────────────────────────────────
//
// Structured endpoints optimized for Nolan's consumption:
//   - Quality summary: per-agent scores, pass rates, maturity, drifting agents
//   - Pending reviews: quality gate approvals awaiting decision
//   - Feedback: structured feedback passthrough (delegates to REQ-10 logic)
//   - Agent health: per-agent quality trend, memory count, lesson count, maturity

export function nolanIntegrationRoutes(db: Db) {
  const router = Router();

  // ── GET /companies/:companyId/nolan/quality-summary ──
  router.get("/companies/:companyId/nolan/quality-summary", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    try {
      // Per-agent quality stats from quality_gate approvals
      const agentStats = await db
        .select({
          agentId: sql<string>`issues.assignee_agent_id`,
          agentName: agents.name,
          avgScore: sql<number>`avg((${approvals.payload}->>'score')::numeric)`,
          totalReviews: sql<number>`count(*)::int`,
          passCount: sql<number>`count(*) filter (where (${approvals.payload}->>'score')::numeric >= 6)::int`,
        })
        .from(approvals)
        .innerJoin(issueApprovals, eq(approvals.id, issueApprovals.approvalId))
        .innerJoin(
          sql`issues`,
          sql`issues.id = ${issueApprovals.issueId}`,
        )
        .innerJoin(agents, sql`agents.id = issues.assignee_agent_id`)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "quality_gate"),
            eq(approvals.status, "approved"),
          ),
        )
        .groupBy(sql`issues.assignee_agent_id`, agents.name);

      const perAgent = agentStats.map((a) => ({
        agentId: a.agentId,
        agentName: a.agentName,
        averageScore: Math.round((Number(a.avgScore) || 0) * 100) / 100,
        totalReviews: a.totalReviews,
        passRate: a.totalReviews > 0
          ? Math.round((a.passCount / a.totalReviews) * 100)
          : 0,
      }));

      // Workflow maturity levels
      const maturityRows = await db
        .select()
        .from(workflowMaturity)
        .where(eq(workflowMaturity.companyId, companyId));

      // Drifting agents
      const drifting = await checkAllAgentDrift(db, companyId);

      res.json({
        perAgent,
        workflowMaturity: maturityRows.map((m) => ({
          workflowType: m.workflowType,
          maturityLevel: m.maturityLevel,
          totalCompleted: m.totalCompleted,
          consecutivePasses: m.consecutivePasses,
          rejectionsLast20: m.rejectionsLast20,
        })),
        driftingAgents: drifting.map((d) => ({
          agentId: d.agentId,
          agentName: d.agentName,
          averageScore: d.drift.averageScore,
          trend: d.drift.trend,
        })),
      });
    } catch (err) {
      logger.error({ err, companyId }, "failed to build quality summary for Nolan");
      res.status(500).json({ error: "Failed to build quality summary" });
    }
  });

  // ── GET /companies/:companyId/nolan/pending-reviews ──
  router.get("/companies/:companyId/nolan/pending-reviews", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    try {
      const pending = await db
        .select({
          approvalId: approvals.id,
          type: approvals.type,
          status: approvals.status,
          payload: approvals.payload,
          requestedByAgentId: approvals.requestedByAgentId,
          createdAt: approvals.createdAt,
        })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "quality_gate"),
            eq(approvals.status, "pending"),
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .limit(50);

      res.json({ pendingReviews: pending });
    } catch (err) {
      logger.error({ err, companyId }, "failed to fetch pending reviews for Nolan");
      res.status(500).json({ error: "Failed to fetch pending reviews" });
    }
  });

  // ── POST /companies/:companyId/nolan/feedback ──
  router.post("/companies/:companyId/nolan/feedback", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const { agentId, issueId, feedbackType, content } = req.body as {
      agentId?: string;
      issueId?: string;
      feedbackType?: "positive" | "negative" | "correction";
      content?: string;
    };

    if (!agentId || !feedbackType || !content) {
      res.status(422).json({ error: "agentId, feedbackType, and content are required" });
      return;
    }

    try {
      const now = new Date();

      // Create feedback memory entry
      await db.insert(agentMemoryEntries).values({
        agentId,
        companyId,
        memoryType: "episodic",
        category: "feedback",
        content: `[${feedbackType}] ${content}`,
        sourceIssueId: issueId ?? null,
        confidence: feedbackType === "negative" ? 90 : 80,
        lastAccessedAt: now,
      });

      // If negative feedback, also create a quality example entry
      if (feedbackType === "negative") {
        await db.insert(agentMemoryEntries).values({
          agentId,
          companyId,
          memoryType: "procedural",
          category: "quality_flag",
          content: `Bad quality example: ${content}`,
          sourceIssueId: issueId ?? null,
          confidence: 85,
          lastAccessedAt: now,
        });
      }

      res.json({ ok: true });
    } catch (err) {
      logger.error({ err, companyId, agentId }, "failed to process Nolan feedback");
      res.status(500).json({ error: "Failed to process feedback" });
    }
  });

  // ── GET /companies/:companyId/nolan/agent-health ──
  router.get("/companies/:companyId/nolan/agent-health", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    try {
      const allAgents = await db
        .select({ id: agents.id, name: agents.name, role: agents.role })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            sql`${agents.status} != 'terminated'`,
          ),
        );

      const healthData = await Promise.all(
        allAgents.map(async (agent) => {
          // Quality drift
          const drift = await detectQualityDrift(db, companyId, agent.id);

          // Memory count (active, non-archived)
          const [memRow] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(agentMemoryEntries)
            .where(
              and(
                eq(agentMemoryEntries.agentId, agent.id),
                sql`${agentMemoryEntries.archivedAt} IS NULL`,
              ),
            );

          // Lesson count
          const lessons = await getAgentLessons(db, agent.id, 100);

          // Workflow maturity for this agent's workflow types
          // (agents don't directly own workflow types, so we return company-level)
          // This is at the company level, but included for context

          return {
            agentId: agent.id,
            agentName: agent.name,
            role: agent.role,
            qualityScore: {
              averageScore: drift.averageScore,
              trend: drift.trend,
              isDrifting: drift.isDrifting,
              recentScores: drift.recentScores.slice(0, 5),
            },
            memoryCount: Number(memRow?.count ?? 0),
            lessonCount: lessons.length,
          };
        }),
      );

      // Company-level maturity
      const maturityRows = await db
        .select()
        .from(workflowMaturity)
        .where(eq(workflowMaturity.companyId, companyId));

      res.json({
        agents: healthData,
        workflowMaturity: maturityRows.map((m) => ({
          workflowType: m.workflowType,
          maturityLevel: m.maturityLevel,
        })),
      });
    } catch (err) {
      logger.error({ err, companyId }, "failed to build agent health for Nolan");
      res.status(500).json({ error: "Failed to build agent health" });
    }
  });

  return router;
}
