import type { Agent } from "../../packages/shared/src/types/agent.js";
import { pollUntil, type RunnerApi } from "./api.js";
import { beginEvalAgentPhase } from "./attempt-phase.js";

type SetupState = Pick<Agent, "id" | "companyId" | "status" | "lifecycleState" | "lifecycleError"> & { lifecycleHolds?: string[] };
export type EvalSetupObservation = SetupState & { observedAt: string };

export async function finishBudgetedEvalSetup(input: {
  executionId: string;
  agentId: string;
  companyId: string;
  deadlineAt: number;
  api: Pick<RunnerApi, "get">;
  observe: (observations: EvalSetupObservation[]) => Promise<void>;
}, env: NodeJS.ProcessEnv = process.env) {
  if (env.PAPERCLIP_E2E_GATEWAY_BASE_URL) {
    const deadlineAt = Math.min(input.deadlineAt, Date.now() + 45_000);
    const observations: EvalSetupObservation[] = [];
    let previous: string | undefined;
    const scoped = (agent: SetupState) => agent.id === input.agentId && agent.companyId === input.companyId;
    await pollUntil({ label: "budgeted eval agent setup", deadlineAt, intervalMs: 500,
      load: async () => {
        const agent = await input.api.get<SetupState>(`/api/agents/${input.agentId}`, { timeout: Math.max(1, Math.min(5_000, deadlineAt - Date.now())) });
        const state: SetupState = { id: agent.id, companyId: agent.companyId, status: agent.status,
          lifecycleState: agent.lifecycleState, lifecycleError: agent.lifecycleError, lifecycleHolds: agent.lifecycleHolds };
        const current = JSON.stringify(state);
        if (current !== previous) {
          observations.push({ ...state, observedAt: new Date().toISOString() });
          await input.observe(observations);
          previous = current;
        }
        return state;
      },
      accept: agent => scoped(agent) && agent.lifecycleState === "ready" && ["idle", "active"].includes(agent.status)
        && !agent.lifecycleError && !agent.lifecycleHolds?.length,
      reject: agent => !scoped(agent) ? "Agent scope changed"
        : agent.lifecycleError ? `Agent setup failed: ${agent.lifecycleError}`
          : agent.lifecycleHolds?.length ? "Agent setup is held"
            : ["paused", "rejected", "terminated"].includes(agent.lifecycleState ?? "") ? `Agent setup stopped: ${agent.lifecycleState}` : undefined,
    });
    if (Date.now() >= deadlineAt) throw new Error("Timed out saving budgeted eval agent readiness");
  }
  await beginEvalAgentPhase(input.executionId, env);
}
