import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, companies, issues, knowledgePages, projects } from "@ironworksai/db";
import { sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

// ── Contractor Onboarding Packet ────────────────────────────────────────────
//
// Assembles the context packet given to a contractor agent at hire time.
// Includes company brief, project scope, KB page excerpts, team contacts,
// and contract terms.

export interface OnboardingPacket {
  companyBrief: string;
  projectScope: string | null;
  kbPageSummaries: Array<{ slug: string; title: string; excerpt: string }>;
  teamContacts: Array<{ name: string; role: string; agentId: string }>;
  contractTerms: {
    endCondition: string | null;
    deadline: string | null;
    budgetCents: number | null;
  };
}

/**
 * Build the onboarding context packet for a contractor agent.
 *
 * This packet is stored in the agent's onboardingContextIds and used to
 * bootstrap the contractor's knowledge when they start working.
 */
export async function buildOnboardingPacket(
  db: Db,
  companyId: string,
  projectId: string | null,
  kbPageIds: string[],
  reportsToAgentId: string | null,
): Promise<OnboardingPacket> {
  // 1. Company brief
  const company = await db
    .select({
      name: companies.name,
      description: companies.description,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);

  const companyBrief = company
    ? `${company.name}${company.description ? ` - ${company.description}` : ""}`
    : "Unknown company";

  // 2. Project scope (if a project is specified)
  let projectScope: string | null = null;
  if (projectId) {
    const project = await db
      .select({
        name: projects.name,
        description: projects.description,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);

    if (project) {
      // Count active issues in the project
      const issueCountResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(eq(issues.projectId, projectId));

      const issueCount = Number(issueCountResult[0]?.count ?? 0);

      projectScope = `${project.name}${project.description ? ` - ${project.description}` : ""}. Active issues: ${issueCount}`;
    }
  }

  // 3. KB page summaries
  const kbPageSummaries: OnboardingPacket["kbPageSummaries"] = [];
  if (kbPageIds.length > 0) {
    const pages = await db
      .select({
        slug: knowledgePages.slug,
        title: knowledgePages.title,
        body: knowledgePages.body,
      })
      .from(knowledgePages)
      .where(and(inArray(knowledgePages.id, kbPageIds), eq(knowledgePages.companyId, companyId)));

    for (const page of pages) {
      kbPageSummaries.push({
        slug: page.slug,
        title: page.title,
        excerpt: page.body.length > 500 ? page.body.slice(0, 500) + "..." : page.body,
      });
    }
  }

  // 4. Team contacts
  const teamContacts: OnboardingPacket["teamContacts"] = [];

  // Primary contact: the agent this contractor reports to
  if (reportsToAgentId) {
    const supervisor = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
      })
      .from(agents)
      .where(and(eq(agents.id, reportsToAgentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (supervisor) {
      teamContacts.push({
        name: supervisor.name,
        role: supervisor.role,
        agentId: supervisor.id,
      });
    }
  }

  // Secondary contact: CEO agent for the company
  const ceoAgent = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
    })
    .from(agents)
    .where(
      eq(agents.companyId, companyId),
    )
    .then((rows) => rows.find((a) => a.role === "ceo") ?? null);

  if (ceoAgent && !teamContacts.some((c) => c.agentId === ceoAgent.id)) {
    teamContacts.push({
      name: ceoAgent.name,
      role: ceoAgent.role,
      agentId: ceoAgent.id,
    });
  }

  // 5. Contract terms are not populated here - they come from the agent record.
  //    The caller should fill these in from the agent's contract fields.
  const contractTerms: OnboardingPacket["contractTerms"] = {
    endCondition: null,
    deadline: null,
    budgetCents: null,
  };

  logger.info(
    {
      companyId,
      projectId,
      kbPageCount: kbPageSummaries.length,
      contactCount: teamContacts.length,
    },
    "built contractor onboarding packet",
  );

  return {
    companyBrief,
    projectScope,
    kbPageSummaries,
    teamContacts,
    contractTerms,
  };
}
