import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, issues, issueLabels, labels } from "@ironworksai/db";
import { logger } from "../middleware/logger.js";

export interface AgentSkillEntry {
  labelId: string;
  labelName: string;
  labelColor: string;
  completed: number;
  total: number;
  blocked: number;
  completionRate: number;
  avgCompletionHours: number;
  effectivenessScore: number;
}

export interface AgentExpertiseProfile {
  agentId: string;
  agentName: string;
  agentRole: string;
  topSkills: AgentSkillEntry[];
  skillGaps: AgentSkillEntry[];
}

export interface ExpertiseMapResult {
  agents: AgentExpertiseProfile[];
}

/**
 * Compute an expertise map for all agents in a company based on their
 * issue completion history across label categories.
 */
export async function computeExpertiseMap(
  db: Db,
  companyId: string,
): Promise<ExpertiseMapResult> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // Get all active agents
  const companyAgents = await db
    .select({ id: agents.id, name: agents.name, role: agents.role })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

  if (companyAgents.length === 0) {
    return { agents: [] };
  }

  // Get per-agent, per-label stats
  const statsRows = await db
    .select({
      agentId: issues.assigneeAgentId,
      labelId: issueLabels.labelId,
      labelName: labels.name,
      labelColor: labels.color,
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${issues.status} = 'done')::int`,
      blocked: sql<number>`count(*) filter (where ${issues.status} in ('blocked', 'cancelled'))::int`,
      avgHours: sql<number>`coalesce(avg(
        case when ${issues.status} = 'done' and ${issues.completedAt} is not null
          then extract(epoch from (${issues.completedAt} - ${issues.createdAt})) / 3600
          else null end
      ), 0)::float`,
    })
    .from(issues)
    .innerJoin(issueLabels, eq(issues.id, issueLabels.issueId))
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(
      and(
        eq(issues.companyId, companyId),
        sql`${issues.assigneeAgentId} is not null`,
        gte(issues.createdAt, ninetyDaysAgo),
      ),
    )
    .groupBy(issues.assigneeAgentId, issueLabels.labelId, labels.name, labels.color)
    .orderBy(sql`count(*) desc`);

  // Build per-agent expertise profiles
  const agentMap = new Map(companyAgents.map((a) => [a.id, a]));
  const agentSkillsMap = new Map<string, AgentSkillEntry[]>();

  for (const row of statsRows) {
    if (!row.agentId) continue;
    const total = Number(row.total);
    const completed = Number(row.completed);
    const blocked = Number(row.blocked);
    const avgHours = Number(row.avgHours);
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    // Effectiveness = completionRate * speed factor
    // Speed factor: normalized inverse of avg completion hours (faster = higher)
    // Cap speed factor between 0.5 and 1.5
    const speedFactor = avgHours > 0 ? Math.min(1.5, Math.max(0.5, 48 / avgHours)) : 1;
    const effectivenessScore = Math.round(completionRate * speedFactor);

    const entry: AgentSkillEntry = {
      labelId: row.labelId,
      labelName: row.labelName,
      labelColor: row.labelColor,
      completed,
      total,
      blocked,
      completionRate,
      avgCompletionHours: Math.round(avgHours * 10) / 10,
      effectivenessScore: Math.min(100, effectivenessScore),
    };

    const existing = agentSkillsMap.get(row.agentId) ?? [];
    existing.push(entry);
    agentSkillsMap.set(row.agentId, existing);
  }

  const result: AgentExpertiseProfile[] = [];

  for (const agent of companyAgents) {
    const allSkills = agentSkillsMap.get(agent.id) ?? [];

    // Sort by effectiveness for top skills
    const sorted = [...allSkills].sort((a, b) => b.effectivenessScore - a.effectivenessScore);
    const topSkills = sorted.slice(0, 5);

    // Skill gaps: categories where blocked/cancelled rate is high (>40%) or completion rate < 50%
    const gaps = allSkills
      .filter((s) => s.total >= 2 && (s.completionRate < 50 || (s.blocked / s.total) > 0.4))
      .sort((a, b) => a.completionRate - b.completionRate)
      .slice(0, 3);

    result.push({
      agentId: agent.id,
      agentName: agent.name,
      agentRole: agent.role,
      topSkills,
      skillGaps: gaps,
    });
  }

  // Sort agents by total effectiveness (sum of top skill scores)
  result.sort((a, b) => {
    const sumA = a.topSkills.reduce((s, sk) => s + sk.effectivenessScore, 0);
    const sumB = b.topSkills.reduce((s, sk) => s + sk.effectivenessScore, 0);
    return sumB - sumA;
  });

  logger.info({ companyId, agentCount: result.length }, "computed expertise map");
  return { agents: result };
}

/**
 * Given a set of label names, suggest the best agent to assign.
 */
export async function suggestAssignee(
  db: Db,
  companyId: string,
  labelNames: string[],
): Promise<{ agentId: string; agentName: string; score: number } | null> {
  if (labelNames.length === 0) return null;

  const map = await computeExpertiseMap(db, companyId);
  const normalizedLabels = new Set(labelNames.map((l) => l.toLowerCase()));

  let bestAgent: { agentId: string; agentName: string; score: number } | null = null;

  for (const agent of map.agents) {
    let score = 0;
    for (const skill of agent.topSkills) {
      if (normalizedLabels.has(skill.labelName.toLowerCase())) {
        score += skill.effectivenessScore;
      }
    }
    if (score > 0 && (!bestAgent || score > bestAgent.score)) {
      bestAgent = { agentId: agent.agentId, agentName: agent.agentName, score };
    }
  }

  return bestAgent;
}
