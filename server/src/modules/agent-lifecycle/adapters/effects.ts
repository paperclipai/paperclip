import type { Db } from "@paperclipai/db";
import type { agents, budgetPolicies } from "@paperclipai/db";
import type { ClaudeLoginContext, RevisionMetadata, UpdateAgentOptions } from "../../../lib/agent-records.js";
import type { ActivityPublication } from "../../../types/activity-publication.js";

/** Services supply integrations; lifecycle owns the transaction and state writes. */
export interface LifecycleEffects {
  deleteDependencies(db: Db, companyId: string, agentId: string): Promise<void>;
  updateConfiguration(db: Db, id: string, data: Partial<Omit<typeof agents.$inferInsert, "status" | "pauseReason" | "pausedAt" | "lifecycleState" | "lifecycleVersion" | "lifecycleError" | "lifecycleOperation" | "lifecycleRequiredPluginIds" | "lifecycleHolds">>, options: UpdateAgentOptions | undefined, publications: ActivityPublication[]): Promise<unknown>;
  transaction<T>(db: Db, companyId: string, work: (tx: Db, publications: ActivityPublication[]) => Promise<T>): Promise<T>;
  policyBlocks(db: Db, policy: typeof budgetPolicies.$inferSelect): Promise<boolean>;
  setAgentBudget(db: Db, publications: ActivityPublication[], companyId: string, agentId: string, amount: number, userId: string | null, isActive?: boolean): Promise<unknown>;
  enforceBudget(db: Db, companyId: string): Promise<void>;
  recordCreation(db: Db, companyId: string, agentId: string): Promise<void>;
  recordStatus(db: Db, companyId: string, agentId: string, before: string, after: string): Promise<void>;
  clearPrimary(db: Db, companyId: string, agentId: string): Promise<unknown>;
  initializePrimary(db: Db, companyId: string, userId: string, agentId: string): Promise<unknown>;
  ensureIdentity(db: Db, companyId: string, agentId: string): Promise<unknown>;
  normalizeAdapterConfig(db: Db, companyId: string, config: Record<string, unknown>, adapterType: string): Promise<Record<string, unknown>>;
  bindCredentials(db: Db, input: {
    companyId: string;
    adapterType: string;
    adapterConfig: unknown;
    previousAdapterConfig?: unknown;
    consume: boolean;
    environmentId?: string | null;
    claudeLogin?: ClaudeLoginContext;
  }): Promise<void>;
  syncSecrets(db: Db, agent: { id: string; companyId: string; adapterConfig: unknown }, previousConfig?: unknown, actor?: RevisionMetadata): Promise<void>;
}
