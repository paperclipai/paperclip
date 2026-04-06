import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";

interface IssueForRouting {
  id: string;
  title: string;
  description?: string | null;
  priority?: string | null;
}

function computeCapabilityScore(
  agent: { capabilities: string | null },
  issue: IssueForRouting,
): number {
  if (!agent.capabilities) return 0;
  const issueText = `${issue.title} ${issue.description ?? ""}`.toLowerCase();
  const keywords = agent.capabilities
    .toLowerCase()
    .split(/[,;\s]+/)
    .filter((k) => k.length > 2);
  if (keywords.length === 0) return 0;
  const matches = keywords.filter((k) => issueText.includes(k)).length;
  return matches / keywords.length;
}

export function issueRouterService(db: Db) {
  return {
    async routeIssue(companyId: string, issue: IssueForRouting): Promise<string | null> {
      const allAgents = await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            ne(agents.status, "terminated"),
            ne(agents.status, "paused"),
          ),
        );

      if (allAgents.length === 0) return null;

      const scored: Array<{ agentId: string; score: number }> = [];
      for (const agent of allAgents) {
        const capScore = computeCapabilityScore(agent, issue);

        // Count active issues for load balancing
        const result = await db
          .select({ count: sql<number>`count(*)` })
          .from(issues)
          .where(
            and(
              eq(issues.assigneeAgentId, agent.id),
              ne(issues.status, "done"),
              ne(issues.status, "cancelled"),
            ),
          );
        const activeCount = result[0]?.count ?? 0;
        const loadScore = Math.max(0, 1 - activeCount * 0.15);

        const ceoBonus = agent.role === "ceo" ? 0.1 : 0;
        scored.push({
          agentId: agent.id,
          score: capScore * 0.6 + loadScore * 0.3 + ceoBonus,
        });
      }

      scored.sort((a, b) => b.score - a.score);

      if (scored[0]?.score === 0) {
        const ceo = allAgents.find((a) => a.role === "ceo");
        return ceo?.id ?? scored[0]?.agentId ?? null;
      }

      return scored[0]?.agentId ?? null;
    },

    async getCeoAgentId(companyId: string): Promise<string | null> {
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.role, "ceo"),
            ne(agents.status, "terminated"),
          ),
        )
        .limit(1);
      return rows[0]?.id ?? null;
    },
  };
}
