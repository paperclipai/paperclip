export interface RunnerSessionGoalController {
  control(input: RunnerSessionGoalControlInput): Promise<void>;
}

export interface RunnerSessionGoalControlInput {
  requestId: string;
  action: "create" | "edit" | "replace" | "pause" | "resume" | "clear";
  objective?: string;
  tokenBudget?: number | null;
}

interface GoalControllerBinding {
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
}

interface RegisteredGoalController extends GoalControllerBinding {
  controller: RunnerSessionGoalController;
  generation: symbol;
}

const registrations = new Map<string, RegisteredGoalController>();

function bindingKey(input: Pick<GoalControllerBinding, "companyId" | "issueId" | "agentId">): string {
  return `${input.companyId}:${input.issueId}:${input.agentId}`;
}

export function registerLiveRunnerGoalController(
  binding: GoalControllerBinding,
  controller: RunnerSessionGoalController,
): () => void {
  const key = bindingKey(binding);
  const generation = Symbol(binding.runId);
  registrations.set(key, { ...binding, controller, generation });
  return () => {
    if (registrations.get(key)?.generation === generation) registrations.delete(key);
  };
}

export function dispatchLiveRunnerGoalControl(
  binding: Pick<GoalControllerBinding, "companyId" | "issueId" | "agentId">,
  control: RunnerSessionGoalControlInput,
): { runId: string; completion: Promise<void> } | null {
  const registered = registrations.get(bindingKey(binding));
  if (!registered) return null;
  return {
    runId: registered.runId,
    completion: Promise.resolve().then(() => registered.controller.control(control)),
  };
}

export const runnerGoalControlBrokerInternals = {
  resetForTests(): void {
    registrations.clear();
  },
};
