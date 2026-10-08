import { agentHarnessType, agentRunner } from "../../packages/shared/src/agent-runner.js";
import type { RunnerApi } from "./api.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { CredentialName, MatrixExecution } from "./types.js";

export const FIRST_TASK_BUDGET_CENTS = 500;

/** Bound paid onboarding work without changing the wizard's execution choice. */
export async function boundFirstTaskBudget(input: {
  api: Pick<RunnerApi, "patch">;
  companyId: string;
  agentId: string;
}) {
  const paths = [
    `/api/companies/${input.companyId}/budgets`,
    `/api/agents/${input.agentId}/budgets`,
  ];
  const saved = await Promise.all(paths.map(path => input.api.patch<{ budgetMonthlyCents: number }>(
    path,
    { budgetMonthlyCents: FIRST_TASK_BUDGET_CENTS },
  )));
  if (saved.some(record => record.budgetMonthlyCents !== FIRST_TASK_BUDGET_CENTS)) {
    throw new Error("Onboarding fixture budget hard stop was not saved");
  }
}

/** Provision only credentials for the UI-created company. The production wizard
 * remains the sole creator/configurer of its first agent and onboarding task. */
export async function provisionFirstTaskFixtures(input: {
  api: Pick<RunnerApi, "get" | "postSensitive">;
  execution: MatrixExecution;
  nonce: string;
  company: LiveFixtureValues["company"];
  credentials: Partial<Record<CredentialName, string>>;
}): Promise<LiveFixtureValues> {
  const { api, execution, nonce, company, credentials } = input;
  if (
    !["first-task", "completion-updates", "confirmation-replies"].includes(execution.suite.id) || execution.task.flow !== "first_task" ||
    execution.environment.id !== "local" ||
    ![
      "legacy-codex",
      "legacy-claude",
      "runner-codex",
      "runner-acpx-claude",
    ].includes(execution.profile.id)
  ) {
    throw new Error(
      "First-task fixtures require a supported local onboarding profile",
    );
  }
  const credential = execution.profile.credential;
  const value = credentials[credential];
  if (!value) throw new Error(`Missing credential ${credential}`);
  const environments = await api.get<Array<LiveFixtureValues["environment"]>>(
    `/api/companies/${company.id}/environments?driver=local`,
  );
  const environment = environments.find((e) => e.driver === "local");
  if (!environment)
    throw new Error("Onboarding fixture local environment missing");
  const secret = await api.postSensitive<{ id: string }>(
    `/api/companies/${company.id}/secrets`,
    {
      name: `First task ${credential}`,
      key: credential,
      value,
    },
  );
  return {
    company,
    environment,
    secretRefs: {
      [credential]: {
        type: "secret_ref",
        secretId: secret.id,
        version: "latest",
      },
    },
    agent: { id: "", name: `Garden lead ${nonce}`, companyId: company.id },
    teardown: async () => {}, // Existing launcher removes the complete isolated instance.
  };
}

/** Validate what the production wizard saved. Never repair its runtime in a fixture. */
export function assertFirstTaskRuntime(
  execution: MatrixExecution,
  agent: Record<string, any>,
) {
  const harness = execution.profile.credential === "OPENAI_API_KEY" ? "codex_local" : "claude_local";
  const expectedRunner = execution.profile.generation === "native" ? "paperclip" : "legacy";
  if (agentRunner(agent.adapterType) !== expectedRunner || agentHarnessType(agent.adapterType, agent.adapterConfig ?? {}) !== harness) {
    throw new Error("Onboarding saved an unexpected harness or runner");
  }
  return {
    mode: "production-wizard" as const,
    runnerChoice: expectedRunner === "paperclip" ? "auto" as const : "legacy" as const,
    originalAdapterType: agent.adapterType as string,
    testedAdapterType: agent.adapterType as string,
    originalModel: agent.adapterConfig?.model ?? null,
  };
}
