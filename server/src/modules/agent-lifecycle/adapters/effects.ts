import type { LifecycleFailure } from "../application/ports.js";
import type { Db } from "@paperclipai/db";
import type { budgetPolicies } from "@paperclipai/db";
import type { CreateAgentData, CreateAgentOptions, AgentConfigurationPatch, AgentConfigurationRecord, AgentHireRecord, UpdateAgentOptions } from "../../../lib/agent-records.js";
import type { ActivityPublication } from "../../../types/activity-publication.js";

/** Services supply integrations; lifecycle owns the transaction and state writes. */
export interface LifecycleEffects {
  reportFailure(context: LifecycleFailure, error: unknown): void;
  deleteDependencies(db: Db, companyId: string, agentId: string): Promise<void>;
  prepareConfiguration(db: Db, current: AgentConfigurationRecord, data: AgentConfigurationPatch, options?: UpdateAgentOptions): Promise<AgentConfigurationPatch>;
  completeConfiguration(db: Db, before: AgentConfigurationRecord, after: AgentConfigurationRecord, patch: AgentConfigurationPatch, options: UpdateAgentOptions | undefined, publications: ActivityPublication[]): Promise<void>;
  transaction<T>(db: Db, companyId: string, work: (tx: Db, publications: ActivityPublication[]) => Promise<T>): Promise<T>;
  policyBlocks(db: Db, policy: typeof budgetPolicies.$inferSelect): Promise<boolean>;
  setAgentBudget(db: Db, publications: ActivityPublication[], companyId: string, agentId: string, amount: number, userId: string | null, isActive?: boolean): Promise<unknown>;
  enforceBudget(db: Db, companyId: string, agentId: string): Promise<void>;
  recordCreation(db: Db, companyId: string, agentId: string): Promise<void>;
  recordStatus(db: Db, companyId: string, agentId: string, before: string, after: string): Promise<void>;
  clearPrimary(db: Db, companyId: string, agentId: string): Promise<unknown>;
  prepareHire(db: Db, companyId: string, data: CreateAgentData, options?: CreateAgentOptions): Promise<CreateAgentData>;
  initializeHire(db: Db, agent: AgentHireRecord, options?: CreateAgentOptions): Promise<void>;
  prepareHireApproval(db: Db, agent: AgentHireRecord, payload?: Record<string, unknown> | null): Promise<AgentConfigurationPatch>;
  completeHireApproval(db: Db, agent: AgentHireRecord, previous: AgentHireRecord): Promise<void>;
}
