import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { activityLog, agents, companies, dotAgentBindings, type Db } from "@paperclipai/db";
import { agentRecords as agentService } from "./records.js";
import { approvalService } from "./approvals.js";
import { accessService } from "../../../services/access.js";
import { agentInstructionsService } from "../../../services/agent-instructions.js";
import { loadDefaultAgentInstructionsBundle } from "../../../services/default-agent-instructions.js";
import { logActivity } from "../../../services/activity-log.js";
import { dotRunnerBroker } from "../../../services/dot-runner-broker.js";
import { notFound, unprocessable } from "../../../errors.js";

/** One unfinished invitation per operator/company. Only non-secret references are persisted. */
export function dotInvitationService(db: Db) {
  async function pending(database: Db, companyId: string, operatorId: string) {
    const rows = await database.select({ agent: agents, binding: dotAgentBindings })
      .from(agents).leftJoin(dotAgentBindings, and(eq(dotAgentBindings.agentId, agents.id), isNull(dotAgentBindings.revokedAt)))
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated"),
        eq(agents.adapterType, "paperclip_runner"), sql`${agents.adapterConfig}->>'provider' = 'openai_dot'`,
        sql`exists (select 1 from ${activityLog} where ${activityLog.companyId} = ${agents.companyId}
          and ${activityLog.entityId} = ${agents.id}::text and ${activityLog.entityType} = 'agent'
          and ${activityLog.actorType} = 'user' and ${activityLog.actorId} = ${operatorId}
          and ${activityLog.action} = 'agent.hire_created' and ${activityLog.details}->>'source' = 'dot-invitation')`)).orderBy(desc(agents.createdAt));
    return rows.find(row => row.binding?.status !== "ready")?.agent ?? null;
  }
  async function describe(agent: Pick<typeof agents.$inferSelect, "id" | "name" | "companyId" | "status">) {
    const approval = await approvalService(db).findOpenHireApprovalForAgent(agent.companyId, agent.id);
    return { agent: { id: agent.id, name: agent.name, status: agent.status }, approvalId: approval?.id ?? null,
      binding: await dotRunnerBroker(db).bindingForAgent(agent.companyId, agent.id) };
  }
  return {
    async resume(companyId: string, operatorId: string) {
      const agent = await pending(db, companyId, operatorId);
      return agent ? describe(agent) : null;
    },
    async create(companyId: string, operatorId: string) {
      if (!await dotRunnerBroker(db).enabled()) throw unprocessable("Enable OpenAI Dot and Assistant connections (MCP) in experimental settings.");
      const agent = await db.transaction(async tx => {
        const database = tx as unknown as Db;
        // SQL locking also serializes retries on different control-plane replicas.
        const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).for("update");
        if (!company) throw notFound("Company not found");
        if (company.status !== "active") throw unprocessable("Activate this company before inviting Dot.");
        const existing = await pending(database, companyId, operatorId);
        if (existing) return existing;
        const svc = agentService(database);
        let created = await svc.create(companyId, {
          name: "Dot", role: "general", adapterType: "paperclip_runner",
          adapterConfig: { provider: "openai_dot", lifecycleMode: "per_turn", allowUnmeteredProvider: true,
            dotWorkspaceAccess: false, dotAttachmentAccess: false },
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
          status: company.requireBoardApprovalForNewAgents ? "pending_approval" : "idle",
          metadata: { dotInvitation: { operatorId } },
        }, { createdByUserId: operatorId });
        const bundle = await agentInstructionsService(database).materializeManagedBundle(created,
          await loadDefaultAgentInstructionsBundle("default"), { entryFile: "AGENTS.md", replaceExisting: false });
        created = (await svc.update(created.id, { adapterConfig: bundle.adapterConfig }, { allowPendingApprovalConfigUpdate: true }))!;
        const access = accessService(database);
        await access.ensureMembership(companyId, "agent", created.id, "member", "active");
        await access.setPrincipalPermission(companyId, "agent", created.id, "tasks:assign", true, operatorId);
        const approval = company.requireBoardApprovalForNewAgents ? await approvalService(database).create(companyId, {
          type: "hire_agent", status: "pending", requestedByUserId: operatorId,
          payload: { agentId: created.id, name: created.name, role: created.role, adapterType: created.adapterType,
            adapterConfig: created.adapterConfig, runtimeConfig: created.runtimeConfig, metadata: created.metadata,
            budgetMonthlyCents: created.budgetMonthlyCents, requestedConfigurationSnapshot: {
              adapterType: created.adapterType, runtimeConfig: created.runtimeConfig, adapterConfig: created.adapterConfig,
            } },
        }) : null;
        await logActivity(database, { companyId, actorType: "user", actorId: operatorId, action: "agent.hire_created",
          entityType: "agent", entityId: created.id, details: { name: created.name, role: created.role,
            requiresApproval: !!approval, approvalId: approval?.id ?? null, source: "dot-invitation" } });
        if (approval) await logActivity(database, { companyId, actorType: "user", actorId: operatorId, action: "approval.created",
          entityType: "approval", entityId: approval.id, details: { type: "hire_agent", agentId: created.id } });
        return created;
      });
      return describe(agent);
    },
  };
}
