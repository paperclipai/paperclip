import { normalizePaperclipOperationalSkillPreference } from "../../packages/adapter-utils/src/server-utils.js";
import type { RunnerApi } from "./api.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { CredentialName, MatrixExecution } from "./types.js";

/** Provision credentials and a bounded budget for the UI-created company. The production wizard
 * remains the sole creator/configurer of its first agent and onboarding task. */
export async function provisionFirstTaskFixtures(input: {
  api: Pick<RunnerApi, "get" | "patch" | "postSensitive">;
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
  await api.patch(`/api/companies/${company.id}`, { budgetMonthlyCents: 500 });
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

/** Reuse the qualified runtime configuration for explicit regression switches,
 * never the QA persona from buildAgent. Codex default qualification does not
 * call this helper; its wizard must persist the native selection directly. */
export function firstTaskNativeRuntimePatch(
  execution: MatrixExecution,
  fixtures: LiveFixtureValues,
  agent: Record<string, any>,
) {
  if (!["runner-codex", "runner-acpx-claude"].includes(execution.profile.id))
    throw new Error("Unsupported native first-task profile");
  const built = execution.profile.buildAgent({
    environmentId: fixtures.environment.id,
    environmentFixtureId: "local",
    workspacePath: agent.adapterConfig?.cwd ?? "",
    secretRefs: fixtures.secretRefs,
    executionId: execution.id,
  });
  const config = {
    ...agent.adapterConfig,
    ...(built.adapterConfig as Record<string, unknown>),
  };
  // Preserve the wizard's model choice (including its unset provider default).
  if (agent.adapterConfig?.model == null) delete config.model;
  else config.model = agent.adapterConfig.model;
  return {
    adapterType: "paperclip_runner",
    adapterConfig: normalizePaperclipOperationalSkillPreference(
      "paperclip_runner",
      config,
    ),
  };
}
