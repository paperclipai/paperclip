import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { agentService } from "./agents.js";
import { heartbeatService } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";

type HeartbeatService = ReturnType<typeof heartbeatService>;

/**
 * Founding team agent definitions — always created for every new company.
 * CEO is created first, then all others report to the CEO.
 */
const FOUNDING_TEAM = [
  {
    name: "CEO",
    role: "ceo",
    title: "Chief Executive Officer",
    capabilities: "leadership, strategy, hiring, delegation, company management, org structure",
    permissions: { canCreateAgents: true },
    budgetMonthlyCents: 500,
  },
  {
    name: "Document Manager",
    role: "document_manager",
    title: "Document Management System Agent",
    capabilities: "documentation, deliverables tracking, task filing, knowledge base, reports, filing center, record keeping",
    permissions: {},
    budgetMonthlyCents: 300,
  },
  {
    name: "Cybersecurity Expert",
    role: "cybersecurity",
    title: "Cybersecurity Expert",
    capabilities: "security auditing, vulnerability assessment, access control, compliance, threat analysis, incident response",
    permissions: {},
    budgetMonthlyCents: 300,
  },
  {
    name: "Integration Expert",
    role: "integration",
    title: "Integration Expert",
    capabilities: "MCP servers, n8n workflows, API integrations, webhooks, platform connectors, data sync, automation",
    permissions: {},
    budgetMonthlyCents: 300,
  },
  {
    name: "Quality Control Expert",
    role: "quality_control",
    title: "Quality Control Expert",
    capabilities: "quality assurance, testing, code review, standards enforcement, process improvement, bug tracking",
    permissions: {},
    budgetMonthlyCents: 300,
  },
  {
    name: "Finance Expert",
    role: "finance",
    title: "Finance Expert",
    capabilities: "budgeting, cost tracking, financial reporting, spending analysis, resource allocation, ROI analysis",
    permissions: {},
    budgetMonthlyCents: 300,
  },
] as const;

export function companyBootstrapService(db: Db, heartbeat: HeartbeatService) {
  const agentSvc = agentService(db);

  return {
    /**
     * Bootstrap the full founding team for a newly created company.
     * Creates CEO + 5 core agents (Document Manager, Cybersecurity, Integration, QC, Finance).
     * All non-CEO agents report to the CEO.
     */
    async bootstrapCompany(companyId: string, options?: {
      ceoModel?: string;
      actorUserId?: string;
    }): Promise<{ ceoId: string; agentIds: string[] } | null> {
      const [company] = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);

      if (!company) return null;

      // Check if CEO already exists — skip if company already bootstrapped
      const allAgents = await agentSvc.list(companyId);
      const existingCeo = allAgents.find((a: any) => a.role === "ceo" && a.status !== "terminated");
      if (existingCeo) {
        return { ceoId: existingCeo.id, agentIds: allAgents.map((a: any) => a.id) };
      }

      const model = options?.ceoModel ?? (company as any).defaultCeoModel ?? "sonnet";
      const createdIds: string[] = [];
      let ceoId: string | null = null;

      for (const def of FOUNDING_TEAM) {
        const agent = await agentSvc.create(companyId, {
          name: def.name,
          role: def.role,
          title: def.title,
          status: "idle",
          adapterType: "claude_local",
          adapterConfig: { model },
          runtimeConfig: {},
          budgetMonthlyCents: def.budgetMonthlyCents,
          spentMonthlyCents: 0,
          capabilities: def.capabilities,
          permissions: def.permissions as Record<string, unknown>,
          lastHeartbeatAt: null,
          // All non-CEO agents report to the CEO
          reportsTo: def.role === "ceo" ? null : ceoId,
        });

        if (def.role === "ceo") {
          ceoId = agent.id;
        }
        createdIds.push(agent.id);

        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "auto-bootstrap",
          action: "agent.created",
          entityType: "agent",
          entityId: agent.id,
          details: { name: def.name, role: def.role, reason: "auto-bootstrap" },
        });
      }

      // Wake the CEO to start onboarding — CEO will coordinate the team
      if (ceoId) {
        await heartbeat.wakeup(ceoId, {
          source: "automation",
          triggerDetail: "system",
          reason: "Company bootstrap — CEO and founding team created, ready for onboarding",
          payload: {
            companyId,
            companyName: company.name,
            bootstrapAction: "onboard",
            foundingTeam: createdIds,
          },
          requestedByActorType: "system",
          requestedByActorId: "auto-bootstrap",
        });
      }

      return { ceoId: ceoId!, agentIds: createdIds };
    },
  };
}
