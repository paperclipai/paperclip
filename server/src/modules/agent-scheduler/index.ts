import type { Db } from "@paperclipai/db";
import { createPostgresAgentSchedulerAdapter } from "./adapters/postgres.js";
import type { AgentSchedulerHost, AgentSchedulerWriter } from "./application/ports.js";
import {
  createEvaluateAgentSchedulerAdmission,
  createPromoteAgentRunnableWork,
  readAgentParallelExecutionAllowed,
} from "./application/use-cases.js";

export {
  AGENT_SCHEDULER_DEQUEUE_REASON,
  AGENT_SCHEDULER_ENQUEUE_REASON,
  decideAgentRunMaterialization,
  resolveEffectiveAgentCapacity,
} from "./domain/policy.js";
export { readAgentParallelExecutionAllowed } from "./application/use-cases.js";
export { AGENT_RUNNABLE_STATUS } from "./adapters/postgres.js";

export type AgentSchedulerDeps = {
  adapter?: AgentSchedulerWriter;
};

export function createAgentScheduler(db: Db, host: AgentSchedulerHost, deps: AgentSchedulerDeps = {}) {
  const writer = deps.adapter ?? createPostgresAgentSchedulerAdapter(db);
  return {
    evaluateAdmission: createEvaluateAgentSchedulerAdmission({ host, writer }),
    promoteRunnableWork: createPromoteAgentRunnableWork({ host, writer }),
    readAgentParallelExecutionAllowed,
  };
}

export type AgentScheduler = ReturnType<typeof createAgentScheduler>;
