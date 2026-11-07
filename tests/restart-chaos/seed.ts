import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunnerApi } from "../runner-e2e/api.js";
import { runnerEnvironments, runnerProfiles } from "../runner-e2e/catalog.js";
import { installFixtureDaytonaProvider, waitForFixtureDaytonaProvider } from "../runner-e2e/live-fixtures.js";
import type { MatrixExecution, SecretReference, SecretReferenceMap } from "../runner-e2e/types.js";
import type { ChaosApi } from "./api.js";
import { CREDENTIAL_FOR_ADAPTER, PROFILE_FOR_ADAPTER } from "./config.js";
import type { Timeline } from "./timeline.js";
import type { AdapterId, EnvironmentKind } from "./types.js";
import { fixtureRepositoryFiles } from "./workloads.js";

export interface ChaosLab {
  companyId: string;
  environmentId: string;
  environmentKind: EnvironmentKind;
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

/** The runner-e2e fixture helpers take RunnerApi's `{ timeout }` options. */
function runnerApiView(api: ChaosApi) {
  return {
    get: <T>(route: string, options?: { timeout?: number }) => api.get<T>(route, options?.timeout),
    post: <T>(route: string, body?: unknown, options?: { timeout?: number }) => api.post<T>(route, body, options?.timeout),
  } as unknown as Pick<RunnerApi, "get" | "post">;
}

/**
 * Daytona environment exactly as runner-e2e creates it: the bundled Daytona
 * plugin (live-fixtures.ts installFixtureDaytonaProvider) and the `daytona`
 * fixture from catalog.ts runnerEnvironments, pinned to the immutable image.
 */
export function chaosDaytonaShape(cpu: number) {
  // The runner-e2e fixture's 4 GiB memory and 10 GiB disk, with the vCPU count
  // chosen by --daytona-cpu (4 by default, like the fixture). 2 vCPU with this
  // memory and disk passed a 3-task wave on a 10 vCPU org.
  return { cpu, memory: 4, disk: 10 };
}

async function createDaytonaEnvironment(input: { api: ChaosApi; companyId: string; image: string; cpu: number; waveId: string;
  secretRefs: SecretReferenceMap; timeline: Timeline }): Promise<string> {
  const fixture = runnerEnvironments.find(candidate => candidate.id === "daytona");
  if (!fixture) throw new Error("runner-e2e catalog has no daytona environment fixture");
  const view = runnerApiView(input.api);
  await waitForFixtureDaytonaProvider(view, { companyId: input.companyId, deadlineAt: Date.now() + 120_000 });
  const payload = fixture.buildEnvironment({ secretRefs: input.secretRefs, daytonaImage: input.image, executionId: input.waveId });
  const shape = chaosDaytonaShape(input.cpu);
  const environment = await input.api.post<{ id: string; driver: string }>(`/api/companies/${input.companyId}/environments`,
    { ...payload, config: { ...(payload.config as Record<string, unknown>), ...shape } });
  input.timeline.add("seed_environment", { environmentId: environment.id, driver: environment.driver, image: input.image, ...shape });
  return environment.id;
}

/**
 * Native Codex on a sandbox needs the image's platform qualification recorded
 * first, as in live-fixtures.ts (the agent is not created otherwise).
 */
async function qualifyNativeCodex(input: { api: ChaosApi; companyId: string; environmentId: string; timeline: Timeline }) {
  const startedAt = Date.now();
  const probe = await input.api.post<{ ok: boolean; details?: { platformQualificationRecorded?: boolean; leaseId?: string } }>(
    `/api/environments/${input.environmentId}/probe?companyId=${encodeURIComponent(input.companyId)}`, {}, 330_000);
  input.timeline.add("seed_codex_qualification", { ok: probe.ok, recorded: probe.details?.platformQualificationRecorded ?? false,
    leaseId: probe.details?.leaseId ?? null, durationMs: Date.now() - startedAt });
  if (probe.ok !== true || probe.details?.platformQualificationRecorded !== true) {
    throw new Error("Native Codex image qualification was not recorded; the Codex agent was not created.");
  }
}

/**
 * Seeds the isolated instance. Credentials cross into the server only as
 * encrypted company secrets, as in tests/runner-e2e/live-fixtures.ts, and the
 * agent payloads come from the shared runner-e2e catalog profiles.
 */
/** adapterConfig for a forced runner lifecycle; warm uses the product's default idle window. */
export function chaosLifecycleOverrides(lifecycle: "per_turn" | "warm" | undefined): Record<string, unknown> | undefined {
  if (lifecycle === "warm") return { lifecycleMode: "warm", idleTimeoutMs: 300_000 };
  return lifecycle === "per_turn" ? { lifecycleMode: "per_turn" } : undefined;
}

export async function seedChaosLab(input: {
  api: ChaosApi;
  env: EnvironmentKind;
  daytonaImage?: string;
  daytonaCpu?: number;
  adapters: readonly AdapterId[];
  concurrency: number;
  budgetCents: number;
  masks?: readonly string[];
  fixtureRoot: string;
  waveId: string;
  timeline: Timeline;
  /** Merged into each agent's adapterConfig (for example a runner lifecycle mode). */
  adapterConfigOverrides?: Record<string, unknown>;
  /** Called as soon as the wave owns external resources that need cleanup. */
  onEnvironment?: (lab: Pick<ChaosLab, "companyId" | "environmentId" | "environmentKind">) => void;
}): Promise<ChaosLab> {
  const { api, timeline } = input;
  if (input.env === "daytona") {
    if (!input.daytonaImage) throw new Error("--env daytona needs --daytona-image");
    // Installed before the company exists so the provider worker is warm.
    await installFixtureDaytonaProvider(runnerApiView(input.api), { environment: { id: "daytona" } } as MatrixExecution);
    timeline.add("seed_daytona_plugin", {});
  }
  const fixtureRepositoryPath = await createFixtureRepository(path.join(input.fixtureRoot, "chaos-sandbox"));
  const company = await api.post<{ id: string }>("/api/companies", {
    name: "Chaos Lab",
    description: `Restart chaos harness wave ${input.waveId}`,
    budgetMonthlyCents: input.budgetCents,
  });
  timeline.add("seed_company", { companyId: company.id });
  if (input.masks?.includes("rc06")) {
    // Keep the amount, disable only the hard stop on this isolated company (RC-06 mask).
    await api.post(`/api/companies/${company.id}/budgets/policies`, {
      scopeType: "company", scopeId: company.id, amount: input.budgetCents, hardStopEnabled: false,
    });
    timeline.add("seed_mask_rc06", { companyId: company.id, budgetCents: input.budgetCents, hardStopEnabled: false });
  }

  const secretRefs: SecretReferenceMap = {};
  const credentialKeys = [...new Set([...input.adapters.map(adapter => CREDENTIAL_FOR_ADAPTER[adapter]),
    ...(input.env === "daytona" ? ["DAYTONA_API_KEY" as const] : [])])];
  for (const key of credentialKeys) {
    const value = process.env[key];
    if (!value) throw new Error(`Missing ${key}; load ~/.secrets into the environment first`);
    const created = await api.post<{ id: string }>(`/api/companies/${company.id}/secrets`, {
      name: `Chaos ${key}`, key, value, description: "Restart chaos harness credential",
    });
    secretRefs[key] = { type: "secret_ref", secretId: created.id, version: "latest" } satisfies SecretReference;
  }
  timeline.add("seed_secrets", { keys: Object.keys(secretRefs) });

  let environmentId: string;
  if (input.env === "daytona") {
    environmentId = await createDaytonaEnvironment({ api, companyId: company.id, image: input.daytonaImage!, cpu: input.daytonaCpu ?? 4,
      waveId: input.waveId, secretRefs, timeline });
    input.onEnvironment?.({ companyId: company.id, environmentId, environmentKind: "daytona" });
    if (input.adapters.includes("codex")) await qualifyNativeCodex({ api, companyId: company.id, environmentId, timeline });
  } else {
    const environments = await api.get<Array<{ id: string; driver: string }>>(`/api/companies/${company.id}/environments?driver=local`);
    const environment = environments.find(candidate => candidate.driver === "local");
    if (!environment) throw new Error("Isolated instance has no managed local environment");
    environmentId = environment.id;
  }

  const agents = {} as ChaosLab["agents"];
  for (const adapter of input.adapters) {
    const profile = runnerProfiles.find(candidate => candidate.id === PROFILE_FOR_ADAPTER[adapter]);
    if (!profile) throw new Error(`runner-e2e catalog has no profile ${PROFILE_FOR_ADAPTER[adapter]}`);
    if (!profile.supportedEnvironments.includes(input.env)) throw new Error(`Profile ${profile.id} does not support ${input.env}`);
    const payload = profile.buildAgent({ environmentId, environmentFixtureId: input.env,
      workspacePath: fixtureRepositoryPath, secretRefs, executionId: input.waveId });
    const name = `Chaos ${adapter}`;
    const runtimeConfig = (payload.runtimeConfig ?? {}) as Record<string, unknown>;
    const created = await api.post<{ id: string; name: string }>(`/api/companies/${company.id}/agents`, {
      ...payload,
      ...(input.adapterConfigOverrides ? { adapterConfig: {
        ...((payload.adapterConfig ?? {}) as Record<string, unknown>), ...input.adapterConfigOverrides } } : {}),
      name,
      title: "Restart chaos worker",
      runtimeConfig: { ...runtimeConfig, heartbeat: { ...((runtimeConfig.heartbeat ?? {}) as Record<string, unknown>),
        enabled: false, maxConcurrentRuns: Math.max(1, input.concurrency) } },
    });
    agents[adapter] = { id: created.id, name };
    timeline.add("seed_agent", { adapter, agentId: created.id, profile: profile.id, model: profile.model, environmentId });
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
      environmentId,
      workspaceStrategy: { type: "git_worktree" },
    },
    workspace: { name: "Primary", sourceType: "local_path", cwd: fixtureRepositoryPath, isPrimary: true },
  });
  timeline.add("seed_project", { projectId: project.id, fixtureRepositoryPath });
  return { companyId: company.id, environmentId, environmentKind: input.env, projectId: project.id, fixtureRepositoryPath, agents };
}
