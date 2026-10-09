import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { activityLog, agents, companies, dotAgentBindings, type Db } from "@paperclipai/db";
import { agentService } from "./agents.js";
import { createAgentLifecycle, scheduleAgentLifecycle } from "../modules/agent-lifecycle/index.js";
import { withDedicatedDbConnection } from "@paperclipai/db";
import { approvalService } from "./approvals.js";
import { accessService } from "./access.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { loadDefaultAgentInstructionsBundle } from "./default-agent-instructions.js";
import { logActivity } from "./activity-log.js";
import { dotRunnerBroker } from "./dot-runner-broker.js";
import { notFound, unprocessable } from "../errors.js";

/** One unfinished invitation per operator/company. Only non-secret references are persisted. */
export function dotInvitationService(db: Db) {
  async function pending(database: Db, companyId: string, operatorId: string, recoverIncomplete = false) {
    const rows = await database.select({ agent: agents, binding: dotAgentBindings })
      .from(agents).leftJoin(dotAgentBindings, and(eq(dotAgentBindings.agentId, agents.id), isNull(dotAgentBindings.revokedAt)))
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated"),
        eq(agents.adapterType, "paperclip_runner"), sql`${agents.adapterConfig}->>'provider' = 'openai_dot'`,
        sql`((${recoverIncomplete} and ${agents.metadata}->'dotInvitation'->>'operatorId' = ${operatorId}
          and ${agents.lifecycleOperation}->>'responsibleUserId' = ${operatorId}) or exists (select 1 from ${activityLog} where ${activityLog.companyId} = ${agents.companyId}
          and ${activityLog.entityId} = ${agents.id}::text and ${activityLog.entityType} = 'agent'
          and ${activityLog.actorType} = 'user' and ${activityLog.actorId} = ${operatorId}
          and ${activityLog.action} = 'agent.hire_created' and ${activityLog.details}->>'source' = 'dot-invitation'))`)).orderBy(desc(agents.createdAt));
    return rows.find(row => row.binding?.status !== "ready")?.agent ?? null;
  }
  async function describe(agent: Pick<typeof agents.$inferSelect, "id" | "name" | "companyId" | "status">, database: Db = db) {
    const approval = await approvalService(database).findOpenHireApprovalForAgent(agent.companyId, agent.id);
    return { agent: { id: agent.id, name: agent.name, status: agent.status }, approvalId: approval?.id ?? null,
      binding: await dotRunnerBroker(database).bindingForAgent(agent.companyId, agent.id) };
  }
  return {
    async resume(companyId: string, operatorId: string) {
      const agent = await pending(db, companyId, operatorId);
      return agent ? describe(agent) : null;
    },
    async create(companyId: string, operatorId: string) {
      if (!await dotRunnerBroker(db).enabled()) throw unprocessable("Enable OpenAI Dot and Assistant connections (MCP) in experimental settings.");
      const database = db;
      const lockKey = `paperclip:dot-invitation:${companyId}:${operatorId}`;
      return withDedicatedDbConnection(db, lockDb => lockDb.transaction(async lock => {
        await lock.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        // SQL locking also serializes retries on different control-plane replicas.
        const [company] = await database.select().from(companies).where(eq(companies.id, companyId));
        if (!company) throw notFound("Company not found");
        if (company.status !== "active") throw unprocessable("Activate this company before inviting Dot.");
        const existing = await pending(database, companyId, operatorId, true);
        if (existing) {
          const [completed] = await database.select({ id: activityLog.id }).from(activityLog).where(and(
            eq(activityLog.companyId, companyId), eq(activityLog.entityId, existing.id),
            eq(activityLog.action, "agent.hire_created"), eq(activityLog.actorId, operatorId),
            sql`${activityLog.details}->>'source' = 'dot-invitation'`)).limit(1);
          if (completed) return describe(existing, database);
        }
        const svc = agentService(database);
        let created = existing ?? await createAgentLifecycle(database).requestHire(companyId, {
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
        await database.transaction(async tx => {
          const txDb = tx as unknown as Db;
          const access = accessService(txDb);
          await access.ensureMembership(companyId, "agent", created.id, "member", "active");
          await access.setPrincipalPermission(companyId, "agent", created.id, "tasks:assign", true, operatorId);
          const approval = await approvalService(txDb).findOpenHireApprovalForAgent(companyId, created.id) ?? (company.requireBoardApprovalForNewAgents ? await approvalService(txDb).create(companyId, {
            type: "hire_agent", status: "pending", requestedByUserId: operatorId,
            payload: { agentId: created.id, name: created.name, role: created.role, adapterType: created.adapterType,
              adapterConfig: created.adapterConfig, runtimeConfig: created.runtimeConfig, metadata: created.metadata,
              budgetMonthlyCents: created.budgetMonthlyCents, requestedConfigurationSnapshot: {
                adapterType: created.adapterType, runtimeConfig: created.runtimeConfig, adapterConfig: created.adapterConfig,
              } },
          }) : null);
          await logActivity(txDb, { companyId, actorType: "user", actorId: operatorId, action: "agent.hire_created",
            entityType: "agent", entityId: created.id, details: { name: created.name, role: created.role,
              requiresApproval: !!approval, approvalId: approval?.id ?? null, source: "dot-invitation" } });
          if (approval) await logActivity(txDb, { companyId, actorType: "user", actorId: operatorId, action: "approval.created",
            entityType: "approval", entityId: approval.id, details: { type: "hire_agent", agentId: created.id } });
        });
        scheduleAgentLifecycle(db, created.id);
        return describe(created, database);
      }));
    },
  };
}
