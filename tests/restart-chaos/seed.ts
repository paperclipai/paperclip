import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runnerProfiles } from "../runner-e2e/catalog.js";
import type { SecretReference, SecretReferenceMap } from "../runner-e2e/types.js";
import type { ChaosApi } from "./api.js";
import { CREDENTIAL_FOR_ADAPTER, PROFILE_FOR_ADAPTER } from "./config.js";
import type { Timeline } from "./timeline.js";
import type { AdapterId, EnvironmentKind } from "./types.js";
import { fixtureRepositoryFiles } from "./workloads.js";

export interface ChaosLab {
  companyId: string;
  environmentId: string;
  projectId: string;
  fixtureRepositoryPath: string;
  agents: Record<AdapterId, { id: string; name: string }>;
}

/** Create the `chaos-sandbox` git repository: python CLI, one failing test, bench.sh. */
export async function createFixtureRepository(directory: string, benchSeconds?: number): Promise<string> {
  await mkdir(directory, { recursive: true });
  for (const [relative, file] of Object.entries(fixtureRepositoryFiles(benchSeconds))) {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
    if (file.mode) await chmod(target, file.mode);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "Chaos Lab", GIT_AUTHOR_EMAIL: "chaos@example.invalid",
      GIT_COMMITTER_NAME: "Chaos Lab", GIT_COMMITTER_EMAIL: "chaos@example.invalid" } });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "chaos-sandbox fixture");
  return directory;
}

/**
 * Seeds the isolated instance. Credentials cross into the server only as
 * encrypted company secrets, as in tests/runner-e2e/live-fixtures.ts, and the
 * agent payloads come from the shared runner-e2e catalog profiles.
 */
export async function seedChaosLab(input: {
  api: ChaosApi;
  env: EnvironmentKind;
  adapters: readonly AdapterId[];
  concurrency: number;
  budgetCents: number;
  fixtureRoot: string;
  waveId: string;
  timeline: Timeline;
}): Promise<ChaosLab> {
  const { api, timeline } = input;
  if (input.env === "daytona") {
    // TODO(restart-chaos phase 1b): create the Daytona sandbox environment from
    // the prepared image (see tests/runner-e2e/catalog.ts runnerEnvironments
    // and live-fixtures.ts installFixtureDaytonaProvider) and add the R6
    // sandbox sweep. The image and env are being prepared separately.
    throw new Error("--env daytona is not wired yet; use --env local");
  }
  const fixtureRepositoryPath = await createFixtureRepository(path.join(input.fixtureRoot, "chaos-sandbox"));
  const company = await api.post<{ id: string }>("/api/companies", {
    name: "Chaos Lab",
    description: `Restart chaos harness wave ${input.waveId}`,
    budgetMonthlyCents: input.budgetCents,
  });
  timeline.add("seed_company", { companyId: company.id });

  const secretRefs: SecretReferenceMap = {};
  for (const adapter of input.adapters) {
    const key = CREDENTIAL_FOR_ADAPTER[adapter];
    if (secretRefs[key]) continue;
    const value = process.env[key];
    if (!value) throw new Error(`Missing ${key} for adapter ${adapter}; load ~/.secrets into the environment first`);
    const created = await api.post<{ id: string }>(`/api/companies/${company.id}/secrets`, {
      name: `Chaos ${key}`, key, value, description: "Restart chaos harness provider credential",
    });
    secretRefs[key] = { type: "secret_ref", secretId: created.id, version: "latest" } satisfies SecretReference;
  }
  timeline.add("seed_secrets", { keys: Object.keys(secretRefs) });

  const environments = await api.get<Array<{ id: string; driver: string }>>(`/api/companies/${company.id}/environments?driver=local`);
  const environment = environments.find(candidate => candidate.driver === "local");
  if (!environment) throw new Error("Isolated instance has no managed local environment");

  const agents = {} as ChaosLab["agents"];
  for (const adapter of input.adapters) {
    const profile = runnerProfiles.find(candidate => candidate.id === PROFILE_FOR_ADAPTER[adapter]);
    if (!profile) throw new Error(`runner-e2e catalog has no profile ${PROFILE_FOR_ADAPTER[adapter]}`);
    const payload = profile.buildAgent({ environmentId: environment.id, environmentFixtureId: "local",
      workspacePath: fixtureRepositoryPath, secretRefs, executionId: input.waveId });
    const name = `Chaos ${adapter}`;
    const runtimeConfig = (payload.runtimeConfig ?? {}) as Record<string, unknown>;
    const created = await api.post<{ id: string; name: string }>(`/api/companies/${company.id}/agents`, {
      ...payload,
      name,
      title: "Restart chaos worker",
      runtimeConfig: { ...runtimeConfig, heartbeat: { ...((runtimeConfig.heartbeat ?? {}) as Record<string, unknown>),
        enabled: false, maxConcurrentRuns: Math.max(1, input.concurrency) } },
    });
    agents[adapter] = { id: created.id, name };
    timeline.add("seed_agent", { adapter, agentId: created.id, profile: profile.id, model: profile.model });
  }

  // The project's git_worktree policy only takes effect when the instance has
  // isolated workspaces enabled (the Experimental setting users turn on, as in
  // runner-e2e). Without it every repo task shares the primary checkout (RC-21).
  const experimental = await api.patch<{ enableIsolatedWorkspaces?: boolean }>(
    "/api/instance/settings/experimental", { enableIsolatedWorkspaces: true });
  if (experimental?.enableIsolatedWorkspaces !== true) {
    throw new Error("Isolated instance did not enable isolated workspaces; repo tasks would share one checkout");
  }
  timeline.add("seed_isolated_workspaces", { enableIsolatedWorkspaces: true });

  const project = await api.post<{ id: string }>(`/api/companies/${company.id}/projects`, {
    name: "chaos-sandbox",
    description: "Fixture repository for restart chaos workloads",
    executionWorkspacePolicy: {
      enabled: true,
      defaultMode: "isolated_workspace",
      allowIssueOverride: false,
      environmentId: environment.id,
      workspaceStrategy: { type: "git_worktree" },
    },
    workspace: { name: "Primary", sourceType: "local_path", cwd: fixtureRepositoryPath, isPrimary: true },
  });
  timeline.add("seed_project", { projectId: project.id, fixtureRepositoryPath });
  return { companyId: company.id, environmentId: environment.id, projectId: project.id, fixtureRepositoryPath, agents };
}
