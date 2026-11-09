import { FixtureRegistry } from "./fixture-registry.js";
import { prepareLegacyContinuationSkill } from "./continuation-fixtures.js";
import type { RunnerApi } from "./api.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export async function setupBlockerFixtures(input: {
  api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; workspacePath: string; nonce: string;
}) {
  const { api, fixtures, execution } = input;
  if (execution.profile.id === "legacy-claude") {
    await mkdir(path.join(input.workspacePath, ".blocker-provider-home", ".claude"), { recursive: true });
  }
  const registry = new FixtureRegistry();
  registry.register<{ id: string }>({ id: "manager", async setup() {
    const payload = execution.profile.buildAgent({ environmentId: fixtures.environment.id, environmentFixtureId: "local",
      workspacePath: input.workspacePath, secretRefs: fixtures.secretRefs, executionId: input.nonce });
    return api.post(`/api/companies/${fixtures.company.id}/agents`, { ...payload,
      name: "Morgan Manager", role: "general", title: "Operations Manager",
      capabilities: "Coordinates staffing and operational work. Has no external administrator access or hiring permission." });
  } });
  registry.register({ id: "worker-policy", dependencies: ["manager"], async setup(resolved) {
    const manager = resolved.get("manager") as { id: string };
    for (const agentId of [manager.id, fixtures.agent.id]) {
      await api.patch(`/api/agents/${agentId}/permissions`, { canCreateAgents: false, canAssignTasks: true });
      await prepareLegacyContinuationSkill(api, fixtures.company.id, agentId);
    }
    await api.patch(`/api/agents/${fixtures.agent.id}`, { reportsTo: manager.id });
    return true;
  } });
  // All agents/runs live in the parent registry's isolated company. The harness
  // cancels every company run and removes the instance after evidence capture.
  const setup = await registry.setupAll();
  return { manager: setup.values.get("manager") as { id: string } };
}
