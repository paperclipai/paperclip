import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentSkillRequests, companySkills } from "@paperclipai/db";

const ROLE_SKILL_MAP: Record<string, string[]> = {
  ceo: ["company-management", "hiring", "strategy", "delegation"],
  developer: ["coding", "debugging", "code-review", "git"],
  designer: ["ui-design", "ux-research", "prototyping"],
  document_manager: ["documentation", "filing", "reports"],
  cybersecurity: ["security-audit", "vulnerability-assessment", "compliance"],
  integration: ["api-integration", "mcp-servers", "n8n-workflows"],
  quality_control: ["testing", "code-review", "standards"],
  finance: ["budgeting", "cost-tracking", "financial-reporting"],
  qa: ["testing", "bug-reporting", "automation"],
  devops: ["deployment", "monitoring", "ci-cd"],
  general: [],
};

const AUTO_APPROVE_SKILLS = new Set([
  "coding", "debugging", "code-review", "git",
  "content-writing", "analytics",
  "testing", "bug-reporting",
  "documentation", "filing", "reports",
]);

export function skillDiscoveryService(db: Db) {
  return {
    getSkillsForRole(role: string): string[] {
      return ROLE_SKILL_MAP[role] ?? ROLE_SKILL_MAP.general ?? [];
    },

    async autoAssignSkillsForAgent(companyId: string, agentId: string, role: string): Promise<string[]> {
      const recommended = this.getSkillsForRole(role);
      if (recommended.length === 0) return [];

      const available = await db
        .select()
        .from(companySkills)
        .where(eq(companySkills.companyId, companyId));

      const availableSlugs = new Set(available.map((s) => s.slug));
      return recommended.filter((s) => availableSlugs.has(s));
    },

    async requestSkill(input: {
      companyId: string;
      agentId: string;
      skillName: string;
      reason: string;
    }) {
      const autoApprove = AUTO_APPROVE_SKILLS.has(input.skillName);

      const [request] = await db
        .insert(agentSkillRequests)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          skillName: input.skillName,
          reason: input.reason,
          status: autoApprove ? "auto_approved" : "pending",
          resolvedAt: autoApprove ? new Date() : null,
        })
        .returning();

      return request;
    },

    async resolveRequest(requestId: string, status: "approved" | "denied", userId: string) {
      const [updated] = await db
        .update(agentSkillRequests)
        .set({
          status,
          resolvedAt: new Date(),
          resolvedByUserId: userId,
          updatedAt: new Date(),
        })
        .where(eq(agentSkillRequests.id, requestId))
        .returning();
      return updated;
    },

    async listPending(companyId: string) {
      return db
        .select()
        .from(agentSkillRequests)
        .where(
          and(
            eq(agentSkillRequests.companyId, companyId),
            eq(agentSkillRequests.status, "pending"),
          ),
        );
    },
  };
}
