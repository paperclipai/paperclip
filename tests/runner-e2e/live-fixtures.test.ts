import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import * as fixtureReadiness from "./live-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerApi } from "./api.js";
import { buildRuntimeUsage } from "./billing.js";
import { runnerMatrix } from "./catalog.js";
import { deleteDaytonaEnvironment, setupLiveFixtures, selectFixtureRuntimeLeases, fixtureRuntimeCostCoverage } from "./live-fixtures.js";

describe("live runner fixtures", () => {
  it.each([
    ["daytona", "native-write-permission-stop", false],
    ["daytona", "native-write-provider-loss", false],
    ["daytona", "message-marker", true],
    ["local", "native-write-permission-stop", null],
    ["local", "native-write-provider-loss", null],
  ] as const)("produces the Kimi lease lifecycle for %s %s", async (environment, task, reusable) => {
    const execution = runnerMatrix.find(row => row.id === `kimi-qualification.runner-acpx-kimi.${environment}.${task}`)!;
    let environmentBody: any;
    let agentBody: any;
    const api = {
      async get() { return [{ id: "local", driver: "local", config: {} }]; },
      async postSensitive(_url: string, data: any) { return { id: `secret-${data.key}` }; },
      async post(url: string, data: any) {
        if (url === "/api/plugins/install") return { id: "plugin", status: "ready" };
        if (url === "/api/companies") return { id: "company", name: "Fixture" };
        if (url.endsWith("/environments")) { environmentBody = data; return { id: "environment", driver: "sandbox", config: data.config }; }
        if (url.endsWith("/agents")) { agentBody = data; return { id: "agent", companyId: "company", ...data }; }
        throw new Error(`Unexpected POST ${url}`);
      },
      async delete() {},
    } as unknown as RunnerApi;
    const fixtures = await setupLiveFixtures({ api, execution, executionNonce: "lifecycle-contract", workspacePath: "/tmp/fixture",
      credentials: { KIMI_API_KEY: "synthetic-kimi-key", DAYTONA_API_KEY: "synthetic-daytona-key" },
      daytonaImage: `registry.example.test/runtime@sha256:${"a".repeat(64)}` });
    try {
      if (reusable === null) {
        expect(environmentBody).toBeUndefined();
        expect(fixtures.environment).toEqual({ id: "local", driver: "local", config: {} });
      } else {
        expect(environmentBody.config).toMatchObject({ reuseLease: reusable, runnerLifecycleMode: reusable ? "warm" : "per_turn",
          apiKey: { type: "secret_ref", secretId: "secret-DAYTONA_API_KEY", version: "latest" } });
        expect(fixtures.environment.config).toEqual(environmentBody.config);
      }
      expect(agentBody.adapterConfig).toMatchObject({ provider: "acpx", acpxAgent: "kimi", model: "kimi-for-coding" });
    } finally { await fixtures.teardown(); }
  });

  it.each([
    ["receipt-smoke", 100], ["same-task-roundtrip", 1_000],
  ] as const)("bounds %s before creating its initial subscription agent", async (taskId, budget) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "case-fixture-limits-")));
    const home = path.join(root, "paperclip-home");
    await mkdir(home);
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_TEMP_ROOT", root);
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "runner-e2e-case-fixture-test");
    const execution = runnerMatrix.find(row => row.id === `case-handoffs.runner-codex-subscription.local.${taskId}`)!;
    const companyId = "11111111-2222-4333-8444-555555555555";
    let companyBody: any;
    let agentBody: any;
    let fixtures: Awaited<ReturnType<typeof setupLiveFixtures>> | undefined;
    const api = {
      async get() { return [{ id: "local", driver: "local" }]; },
      async post(url: string, data: any) {
        if (url === "/api/companies") { companyBody = data; return { id: companyId, name: "Test" }; }
        if (url.endsWith("/agents")) { agentBody = data; return { id: "triage", ...data }; }
        throw new Error(`Unexpected POST ${url}`);
      },
    } as unknown as RunnerApi;
    try {
      fixtures = await setupLiveFixtures({ api, execution, executionNonce: "fixture-limit-test", workspacePath: path.join(root, "workspace"),
        credentials: { CODEX_AUTH_JSON: JSON.stringify({ tokens: { account_id: "synthetic-account", access_token: "synthetic-access",
          refresh_token: "synthetic-refresh", id_token: "synthetic-id" } }) } });
      expect(companyBody.budgetMonthlyCents).toBe(budget);
      expect(agentBody.budgetMonthlyCents).toBe(budget);
      expect(agentBody).not.toHaveProperty("instructionsBundle");
      expect(agentBody.adapterConfig.env).toMatchObject({ OPENAI_API_KEY: "", CODEX_API_KEY: "" });
      if (taskId === "receipt-smoke") {
        expect(agentBody.adapterConfig).toMatchObject({ provider: "codex", timeoutSec: 90, modelReasoningEffort: "low" });
        expect(agentBody.runtimeConfig.heartbeat).toMatchObject({ enabled: false, maxConcurrentRuns: 1, maxDailyRuns: 1, maxDailyCostCents: 100 });
      } else {
        expect(agentBody.adapterConfig).not.toHaveProperty("modelReasoningEffort");
        expect(agentBody.runtimeConfig).not.toHaveProperty("heartbeat");
      }
    } finally {
      await fixtures?.teardown();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["runner-codex", "runner-acpx-claude", "runner-opencode"].flatMap(profile =>
    ["hire-reuse", "delegate-feedback"].map(task => [profile, task]))) (
    "applies %s %s budget stops in actual setup with a nonce and only its selected credential", async (profile, task) => {
      const execution = runnerMatrix.find(row => row.id === `everyday-workflows.${profile}.local.${task}`)!;
      let agentBody: any;
      let companyBody: any;
      const api = {
        async get() { return [{ id: "local", driver: "local" }]; },
        async postSensitive(url: string) { return url.endsWith("/ai-connections") ? { connectionId: "account" } : { id: "secret" }; },
        async post(url: string, data: any) {
          if (url === "/api/companies") { companyBody = data; return { id: "company", name: "Test" }; }
          if (url.endsWith("/agents")) { agentBody = data; return { id: "lead", ...data }; }
          throw new Error(`Unexpected POST ${url}`);
        },
      } as unknown as RunnerApi;
      const fixtures = await setupLiveFixtures({ api, execution, executionNonce: "random-nonce", workspacePath: "/tmp/test",
        credentials: { [execution.profile.credential]: "test-value" } });
      expect(companyBody.budgetMonthlyCents).toBe(1_000);
      expect(agentBody.budgetMonthlyCents).toBe(1_000);
      await fixtures.teardown();
    },
  );

  it.each(["runner-codex", "runner-acpx-claude", "runner-opencode"])(
    "sets both connection-guidance budget stops for %s before execution", async profile => {
      const execution = runnerMatrix.find(row => row.suite.id === "native-connection-guidance" && row.profile.id === profile)!;
      let companyBudget: unknown;
      let agentBudget: unknown;
      const api = {
        async get() { return [{ id: "local", driver: "local" }]; },
        async postSensitive() { return { id: "secret" }; },
        async post(url: string, data: any) {
          if (url === "/api/companies") { companyBudget = data.budgetMonthlyCents; return { id: "company", name: "Test" }; }
          if (url.endsWith("/agents")) { agentBudget = data.budgetMonthlyCents; return { id: "lead", ...data }; }
          throw new Error("Unexpected POST " + url);
        },
      } as unknown as RunnerApi;
      const fixtures = await setupLiveFixtures({ api, execution, executionNonce: "nonce", workspacePath: "/tmp/test",
        credentials: { [execution.profile.credential]: "test-value" } });
      expect(companyBudget).toBe(1_000);
      expect(agentBudget).toBe(1_000);
      await fixtures.teardown();
    },
  );

  it.each(["runner-codex", "legacy-codex", "runner-acpx-claude", "legacy-opencode"])(
    "creates a production-default %s hire with company and agent budget stops", async (profile) => {
      const execution = runnerMatrix.find(row => row.suite.id === "stock-harness" && row.profile.id === profile)!;
      let agentBody: any;
      const api = {
        async get() { return [{ id: "local", driver: "local" }]; },
        async postSensitive() { return { id: "secret" }; },
        async post(url: string, data: any) {
          if (url === "/api/companies") {
            expect(data.budgetMonthlyCents).toBe(1_000);
            return { id: "company", name: "Fixture" };
          }
          if (url.endsWith("/agents")) { agentBody = data; return { id: "agent", ...data }; }
          throw new Error(`Unexpected POST ${url}`);
        },
      } as unknown as RunnerApi;
      const fixtures = await setupLiveFixtures({ api, execution, executionNonce: "nonce", workspacePath: "/tmp/fixture",
        credentials: { [execution.profile.credential]: "fixture-key" } });
      expect(agentBody).not.toHaveProperty("instructionsBundle");
      expect(agentBody.budgetMonthlyCents).toBe(1_000);
      expect(agentBody.adapterConfig.env[execution.profile.credential]).toEqual({ type: "secret_ref", secretId: "secret", version: "latest" });
      await fixtures.teardown();
    },
  );
  it("anchors extended file validation to a public project workspace for local and remote copy-back", async () => {
    const execution = runnerMatrix.find(e => e.id === "extended-harnesses.runner-acpx-pi.local.file-edit-validate")!;
    let projectBody: any;
    const api = {
      async get() { return [{ id: "local", driver: "local" }]; },
      async postSensitive() { return { id: "secret" }; },
      async post(url: string, data: any) {
        if (url === "/api/companies") return { id: "company", name: "Test" };
        if (url.endsWith("/agents")) return { id: "agent", ...data };
        if (url.endsWith("/projects")) { projectBody = data; return { id: "project", ...data }; }
        throw new Error(`Unexpected POST ${url}`);
      },
    } as unknown as RunnerApi;
    const fixtures = await setupLiveFixtures({ api, execution, executionNonce: "nonce", workspacePath: "/tmp/fixture-workspace", credentials: { OPENROUTER_API_KEY: "fixture-key" } });
    expect(fixtures.project?.id).toBe("project");
    expect(projectBody).toMatchObject({ executionWorkspacePolicy: { environmentId: "local", workspaceStrategy: { type: "project_primary" } }, workspace: { cwd: "/tmp/fixture-workspace", sourceType: "local_path" } });
  });

  it.each([
    ["runner-codex", "hiring-templates", "hire-coder-template-reuse"],
    ["runner-acpx-claude", "hiring-templates", "hire-coder-template-reuse"],
    ["runner-codex", "everyday-workflows", "hire-reuse"],
    ["runner-acpx-claude", "everyday-workflows", "hire-reuse"],
    ["runner-opencode", "everyday-workflows", "hire-reuse"],
    ["runner-codex", "agent-chat-hardening", "hire-delegate-reuse"],
    ["runner-acpx-claude", "agent-chat-hardening", "hire-delegate-reuse"],
  ])(
    "gives %s %s/%s a personal managed account without env overrides",
    async (profile, suite, task) => {
      const execution = runnerMatrix.find(
        (e) =>
          e.suite.id === suite &&
          e.task.id === task &&
          e.profile.id === profile &&
          e.environment.id === "local",
      )!;
      const provider =
        profile === "runner-acpx-claude" ? "anthropic" : profile === "runner-opencode" ? "openrouter" : "openai";
      let connected = false;
      let agentBody: any;
      const api = {
        async post(url: string, data: any) {
          if (url === "/api/companies") return { id: "company", name: "Test" };
          if (url.endsWith("/agents")) {
            agentBody = data;
            return { id: "lead", ...data };
          }
          throw new Error(`Unexpected POST ${url}`);
        },
        async postSensitive(url: string, data: any) {
          if (url.endsWith("/ai-connections")) {
            expect(data).toMatchObject({
              provider,
              method: "api_key",
              ownership: "personal",
              apiKey: "test-value",
              agentIds: [],
              allAgents: false,
            });
            connected = true;
            return { connectionId: "managed-account" };
          }
          return { id: "secret" };
        },
        async get() {
          return [{ id: "local", driver: "local" }];
        },
      } as unknown as RunnerApi;
      const fixtures = await setupLiveFixtures({
        api,
        execution,
        executionNonce: "nonce",
        workspacePath: "/tmp/test",
        credentials: {
          [execution.profile.credential]: "test-value",
        },
      });
      expect(connected).toBe(true);
      expect(agentBody.adapterConfig.env).toBeUndefined();
      expect(agentBody.runtimeConfig.aiConnection).toEqual({
        provider,
        method: "api_key",
        mode: "responsible_user",
      });
      expect((fixtures as any).aiConnection.connectionId).toBe(
        "managed-account",
      );
    },
  );

  it.each(["legacy-codex", "runner-acpx-claude", "runner-opencode"])("installs Daytona before its %s environment without adding a Codex qualification probe", async profile => {
    const calls: string[] = [];
    const api = {
      async post(path: string, data?: Record<string, unknown>) {
        calls.push(`POST ${path}`);
        if (path === "/api/plugins/install") {
          expect(data).toMatchObject({ isLocalPath: true });
          expect(data?.packageName).toEqual(
            expect.stringContaining(
              "packages/plugins/sandbox-providers/daytona",
            ),
          );
          return {
            id: "plugin-daytona",
            pluginKey: "paperclip.daytona-sandbox-provider",
            status: "ready",
          };
        }
        if (path === "/api/companies") {
          return { id: "company-1", name: "Runner E2E" };
        }
        if (path.endsWith("/environments")) {
          expect(calls).toContain("POST /api/plugins/install");
          return { id: "environment-1", driver: "sandbox", config: data?.config };
        }
        if (path.endsWith("/agents")) {
          return { id: "agent-1", name: "Agent", companyId: "company-1" };
        }
        throw new Error(`Unexpected POST ${path}`);
      },
      async postSensitive(path: string, data?: Record<string, unknown>) {
        calls.push(`POST ${path}`);
        return { id: `secret-${String(data?.key).toLowerCase()}` };
      },
      async delete(path: string) {
        calls.push(`DELETE ${path}`);
      },
    } as unknown as RunnerApi;
    const execution = runnerMatrix.find(
      (candidate) =>
        candidate.id ===
        `core-compatibility.${profile}.daytona.message-marker`,
    );
    expect(execution).toBeDefined();

    const fixtures = await setupLiveFixtures({
      api,
      execution: execution!,
      executionNonce: "nonce",
      workspacePath: "/tmp/workspace",
      credentials: {
        [execution!.profile.credential]: "provider-test-value",
        DAYTONA_API_KEY: "daytona-test-value",
      },
      daytonaImage:
        "ghcr.io/paperclip/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(calls.indexOf("POST /api/plugins/install")).toBeLessThan(
      calls.indexOf("POST /api/companies/company-1/environments"),
    );
    expect(calls.some(call => call.includes("/probe"))).toBe(false);
    await fixtures.teardown();
    expect(calls).toContain(
      "DELETE /api/environments/environment-1?destroyReusableSandboxLeases=true",
    );
  });

  it.each(["explicit", "auto"])("qualifies the immutable Codex image once before %s agent creation", async mode => {
    const original = runnerMatrix.find(row => row.id === "core-compatibility.runner-codex.daytona.message-marker")!;
    const execution = { ...original, profile: { ...original.profile, buildAgent(input: Parameters<typeof original.profile.buildAgent>[0]) {
      const payload = original.profile.buildAgent(input);
      return { ...payload, adapterType: mode === "auto" ? "codex_local" : "paperclip_runner",
        runner: mode === "auto" ? "auto" : "paperclip" };
    } } };
    const calls: string[] = [];
    const api = {
      async get(path: string) {
        calls.push(`GET ${path}`);
        return [{ type: "codex_local", defaultRunner: "paperclip", supportedRunners: ["paperclip", "legacy"] }];
      },
      async post(path: string, data: any, options: any) {
        calls.push(`POST ${path}`);
        if (path === "/api/plugins/install") return { id: "plugin", status: "ready" };
        if (path === "/api/companies") return { id: "company", name: "Fixture" };
        if (path.endsWith("/environments")) return { id: "environment", driver: "sandbox", config: data.config };
        if (path === "/api/environments/environment/probe?companyId=company") {
          expect(options).toEqual({ timeout: 330_000 });
          return { ok: true, details: { platformQualificationRecorded: true, leaseId: "setup-probe" } };
        }
        if (path.endsWith("/agents")) {
          expect(calls).toContain("POST /api/environments/environment/probe?companyId=company");
          expect(data.adapterType).toBe(mode === "auto" ? "codex_local" : "paperclip_runner");
          expect(data.runner).toBe(mode === "auto" ? "auto" : "paperclip");
          if (mode === "auto") expect(calls).toContain("GET /api/adapters?companyId=company&environmentId=environment");
          return { id: "agent", companyId: "company", ...data };
        }
        throw new Error(`Unexpected POST ${path}`);
      },
      async postSensitive() { return { id: "secret" }; },
      async delete() {},
    } as unknown as RunnerApi;
    const fixtures = await setupLiveFixtures({ api, execution, executionNonce: "nonce", workspacePath: "/tmp/fixture",
      credentials: { OPENAI_API_KEY: "fixture-key", DAYTONA_API_KEY: "fixture-provider-key" },
      daytonaImage: `registry.example.test/runtime@sha256:${"a".repeat(64)}` });
    expect(fixtures.setupProbe).toMatchObject({ leaseId: "setup-probe", ...(mode === "auto" ? { defaultRunner: "paperclip" } : {}) });
    expect(calls.filter(call => call.includes("/probe?"))).toHaveLength(1);
    expect(calls.filter(call => call.startsWith("GET"))).toHaveLength(mode === "auto" ? 1 : 0);
    await fixtures.teardown();
  });

  it.each(["probe-failed", "not-recorded", "wrong-default"])("stops before automatic Codex creation when image qualification is %s", async failure => {
    const original = runnerMatrix.find(row => row.id === "core-compatibility.runner-codex.daytona.message-marker")!;
    const execution = { ...original, profile: { ...original.profile, buildAgent(input: Parameters<typeof original.profile.buildAgent>[0]) {
      return { ...original.profile.buildAgent(input), adapterType: "codex_local", runner: "auto" };
    } } };
    const calls: string[] = [];
    const api = {
      async get() { return [{ type: "codex_local", defaultRunner: "legacy", supportedRunners: ["legacy"] }]; },
      async post(path: string, data: any) {
        calls.push(path);
        if (path === "/api/plugins/install") return { id: "plugin", status: "ready" };
        if (path === "/api/companies") return { id: "company", name: "Fixture" };
        if (path.endsWith("/environments")) return { id: "environment", driver: "sandbox", config: data.config };
        if (path.includes("/probe?")) return { ok: failure !== "probe-failed",
          details: { platformQualificationRecorded: failure !== "not-recorded", leaseId: "setup-probe" } };
        throw new Error(`Unexpected POST ${path}`);
      },
      async postSensitive() { return { id: "secret" }; },
      async delete(path: string) { calls.push(`DELETE ${path}`); },
    } as unknown as RunnerApi;
    await expect(setupLiveFixtures({ api, execution, executionNonce: "nonce", workspacePath: "/tmp/fixture",
      credentials: { OPENAI_API_KEY: "fixture-key", DAYTONA_API_KEY: "fixture-provider-key" },
      daytonaImage: `registry.example.test/runtime@sha256:${"a".repeat(64)}` })).rejects.toThrow(failure === "wrong-default" ? "server-owned default" : "not recorded");
    expect(calls.some(call => call.endsWith("/agents"))).toBe(false);
    expect(calls.filter(call => call.includes("/probe?"))).toHaveLength(1);
    expect(calls).toContain("DELETE /api/environments/environment?destroyReusableSandboxLeases=true");
  });

  it("includes the owned setup probe in existing runtime estimates while excluding unrelated leases", () => {
    const lease = (id: string, duration: number, heartbeatRunId?: string) => ({ id, provider: "daytona", heartbeatRunId,
      acquiredAt: "2026-10-12T00:00:00Z", releasedAt: new Date(Date.parse("2026-10-12T00:00:00Z") + duration).toISOString(),
      metadata: { cpu: 4, memory: 4, disk: 10 } });
    const leases = [lease("task", 20_000, "selected-run"), lease("setup-probe", 10_000), lease("unrelated", 600_000, "other-run")];
    const selected = selectFixtureRuntimeLeases({ leases, runIds: ["selected-run"], setupProbeLeaseId: "setup-probe" });
    expect(selected.map(value => value.id)).toEqual(["task", "setup-probe"]);
    const usage = buildRuntimeUsage({ environmentId: "daytona", runs: [], leases: selected });
    expect(usage.leaseCount).toBe(2);
    expect(usage.leaseDurationMs).toBe(30_000);
    expect(usage.costStatus).toBe("estimated");
    expect(usage.estimatedListCostUsd).toBeGreaterThan(0);
    expect(selectFixtureRuntimeLeases({ leases, runIds: ["selected-run"] }).map(value => value.id)).toEqual(["task"]);
  });

  it("creates a primary project workspace for reusable Daytona scope", async () => {
    const calls: string[] = [];
    const api = {
      async post(path: string, data?: Record<string, unknown>) {
        calls.push(`POST ${path}`);
        if (path === "/api/plugins/install") {
          return {
            id: "plugin-daytona",
            pluginKey: "paperclip.daytona-sandbox-provider",
            status: "ready",
          };
        }
        if (path === "/api/companies") {
          return { id: "company-1", name: "Runner E2E" };
        }
        if (path.endsWith("/environments")) {
          return { id: "environment-1", driver: "sandbox", config: data?.config };
        }
        if (path.endsWith("/agents")) {
          return { id: "agent-1", name: "Agent", companyId: "company-1" };
        }
        if (path.startsWith("/api/environments/environment-1/probe?")) {
          return { ok: true, details: { platformQualificationRecorded: true, leaseId: "setup-probe" } };
        }
        if (path.endsWith("/projects")) {
          expect(data).toMatchObject({
            executionWorkspacePolicy: {
              enabled: true,
              defaultMode: "shared_workspace",
              environmentId: "environment-1",
            },
            workspace: {
              sourceType: "local_path",
              cwd: "/tmp/workspace",
              isPrimary: true,
            },
          });
          return {
            id: "project-1",
            name: data?.name,
            primaryWorkspace: {
              id: "project-workspace-1",
              cwd: "/tmp/workspace",
            },
          };
        }
        throw new Error(`Unexpected POST ${path}`);
      },
      async get() { return [{ type: "codex_local", defaultRunner: "paperclip", supportedRunners: ["paperclip", "legacy"] }]; },
      async postSensitive(_path: string, data?: Record<string, unknown>) {
        return { id: `secret-${String(data?.key).toLowerCase()}` };
      },
      async delete() {},
    } as unknown as RunnerApi;
    const execution = runnerMatrix.find(
      (candidate) =>
        candidate.id ===
        "daytona-warm-continuity.runner-codex.daytona.warm-three-turn",
    )!;

    const fixtures = await setupLiveFixtures({
      api,
      execution,
      executionNonce: "nonce",
      workspacePath: "/tmp/workspace",
      credentials: {
        [execution!.profile.credential]: "provider-test-value",
        DAYTONA_API_KEY: "daytona-test-value",
      },
      daytonaImage:
        "ghcr.io/paperclip/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(fixtures.project?.primaryWorkspace?.id).toBe("project-workspace-1");
    expect(
      calls.indexOf("POST /api/companies/company-1/environments"),
    ).toBeLessThan(calls.indexOf("POST /api/companies/company-1/projects"));
    await fixtures.teardown();
  });
});

describe("owned browser setup lease accounting", () => {
  it("includes both exact setup IDs and task runs while excluding unrelated leases", () => {
    const leases = [{ id: "platform", provider: "daytona" }, { id: "adapter", provider: "daytona" },
      { id: "task", provider: "daytona", heartbeatRunId: "run" }, { id: "unrelated", provider: "daytona" }];
    expect(selectFixtureRuntimeLeases({ leases, runIds: ["run"], setupLeaseIds: ["platform", "adapter"] }).map(lease => lease.id)).toEqual(["platform", "adapter", "task"]);
    expect(selectFixtureRuntimeLeases({ leases, runIds: [], setupLeaseIds: ["platform"] }).map(lease => lease.id)).toEqual(["platform"]);
    expect(selectFixtureRuntimeLeases({ leases, runIds: [], setupLeaseIds: [] })).toEqual([]);
  });
});

describe("managed setup runtime cost coverage", () => {
  it("prices both exact setup windows with task usage and keeps missing attribution unknown", () => {
    const leases = ["platform", "adapter", "task", "unrelated"].map((id, index) => ({ id, provider: "daytona", heartbeatRunId: id === "task" ? "run" : null,
      acquiredAt: "2026-10-13T00:00:00Z", releasedAt: `2026-10-13T00:00:0${index + 1}Z`, metadata: { cpu: 4, memory: 4, disk: 10 } }));
    const selected = selectFixtureRuntimeLeases({ leases, runIds: ["run"], setupLeaseIds: ["platform", "adapter"] });
    const usage = buildRuntimeUsage({ environmentId: "daytona", runs: [], leases: selected });
    expect(usage.leaseCount).toBe(3);
    expect(usage.leaseDurationMs).toBe(6000);
    expect(usage.estimatedListCostUsd).toBeGreaterThan(0);
    expect(fixtureRuntimeCostCoverage(usage, {})).toEqual(usage);
    const incomplete = fixtureRuntimeCostCoverage(usage, { setupLeaseAccountingIncomplete: true });
    expect(incomplete.costStatus).toBe("unavailable");
    expect(incomplete.costSource).toBe("provider_cost_unavailable");
    expect(incomplete).not.toHaveProperty("estimatedListCostUsd");
    expect(incomplete.leaseCount).toBe(3);
  });
});

describe("Daytona fixture readiness after candidate startup", () => {
  const companyId = "11111111-2222-4333-8444-555555555555";
  const pluginId = "22222222-2222-4333-8444-555555555555";
  const pluginKey = "paperclip.daytona-sandbox-provider";
  const waitReady = () => (fixtureReadiness as unknown as {
    waitForFixtureDaytonaProvider: (api: Pick<RunnerApi, "get">, input: { companyId: string; deadlineAt: number }) => Promise<void>;
  }).waitForFixtureDaytonaProvider;
  function candidateCompanyCallback(execution: unknown, api: unknown, restart: () => Promise<void>, deadlineAt: number) {
    const source = readFileSync(new URL("./runner.spec.ts", import.meta.url), "utf8");
    const start = source.indexOf("    const onCompanyCreated = async (id: string) => {");
    const end = source.indexOf("    const api = new RunnerApi(request);", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const js = transformSync(source.slice(start, end), { loader: "ts", format: "cjs" }).code;
    return new Function("kimiCandidateAdmissionForExecution", "execution", "api", "nonce", "startedAtMs", "deadlineMs", "trace", "saveTrace", "restartIsolatedPaperclipServer", "waitForFixtureDaytonaProvider", js + ";return onCompanyCreated;")(
      () => ({}), execution, api, "fixture", 0, deadlineAt, undefined, async () => {}, restart, waitReady(),
    ) as (id: string) => Promise<void>;
  }
  function apiAt(readiness: () => boolean, mismatch = false) {
    const calls: string[] = [];
    return {
      calls,
      async get<T>(route: string): Promise<T> {
        calls.push(route);
        if (route.endsWith("/dashboard")) return { pluginId, worker: { status: readiness() ? "running" : "starting" } } as T;
        return { sandboxProviders: { daytona: readiness() ? { status: "supported", source: "plugin", pluginKey, pluginId: mismatch ? "foreign" : pluginId, supportsRunExecution: true } : { status: "unsupported" } } } as T;
      },
      async post() { calls.push("ENV_POST"); if (!readiness()) throw new Error("environment POST422: plugin worker starting"); return { id: "environment" }; },
    };
  }
  it("awaits real public provider readiness before the environment POST after HTTP restart ACK", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      let running = false; setTimeout(() => { running = true; }, 1_000);
      const api = apiAt(() => running);
      const callback = candidateCompanyCallback({ environment: { id: "daytona" } }, api, async () => {}, 5_000);
      const outcome = (async () => { await callback(companyId); return api.post(); })().then(value => ({ ok: true, value }), error => ({ ok: false, error: error.message }));
      await vi.advanceTimersByTimeAsync(1_250);
      expect(await outcome).toMatchObject({ ok: true, value: { id: "environment" } });
      expect(api.calls.filter(x => x === "ENV_POST")).toHaveLength(1);
      expect(api.calls.some(x => x.endsWith("/dashboard"))).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("leaves local candidate restart sequencing free of Daytona readiness requests", async () => {
    const api = apiAt(() => false);
    await candidateCompanyCallback({ environment: { id: "local" } }, api, async () => {}, Date.now() + 5_000)(companyId);
    expect(api.calls).toEqual([]);
  });
  it("does not admit a DB-ready provider whose live worker never runs", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const api = apiAt(() => false);
      const result = waitReady()(api, { companyId, deadlineAt: 1_000 }).then(() => null, error => error);
      await vi.advanceTimersByTimeAsync(1_100);
      const error = await result;
      expect(error).toMatchObject({ failureClass: "candidate_failure" });
      expect(api.calls).not.toContain("ENV_POST");
    } finally { vi.useRealTimers(); }
  });
  it("rejects a different advertised plugin identity before creating an environment", async () => {
    const api = apiAt(() => true, true);
    await expect(waitReady()(api, { companyId, deadlineAt: Date.now() + 5_000 })).rejects.toThrow(/plugin identity/);
    expect(api.calls).not.toContain("ENV_POST");
  });
});


describe("absolute Daytona fixture cleanup deadline", () => {
  it("waits for an ordinary pending cleanup to succeed beyond the default120s without extending the original Kimi window", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const times: number[] = [];
    const remove = vi.fn(async (_path: string, options?: { allowNotFound?: boolean; timeout?: number }) => {
      times.push(Date.now());
      expect(options?.allowNotFound).toBe(true);
      expect(options!.timeout).toBeLessThanOrEqual(660_000 - Date.now());
      if (Date.now() < 300_000) throw new Error("DELETE409 pending_cleanup");
    });
    try {
      const completed = deleteDaytonaEnvironment({ delete: remove }, "environment", 660_000);
      await vi.advanceTimersByTimeAsync(300_000);
      await completed;
      expect(times.at(-1)).toBe(300_000);
      expect(times.length).toBe(101);
    } finally { vi.useRealTimers(); }
  });

  it("stops at the absolute deadline and clamps final request/sleep time", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const times: number[] = [], timeouts: number[] = [];
    const remove = vi.fn(async (_path: string, options?: { timeout?: number }) => {
      times.push(Date.now()); timeouts.push(options!.timeout!);
      throw new Error("DELETE409 pending_cleanup");
    });
    try {
      const completed = deleteDaytonaEnvironment({ delete: remove }, "environment", 3_500).catch(error => error);
      await vi.advanceTimersByTimeAsync(3_500);
      expect(await completed).toMatchObject({ message: expect.stringContaining("Daytona lease cleanup failed") });
      expect(times).toEqual([0, 3_000]);
      expect(timeouts).toEqual([3_500, 500]);
      await expect(deleteDaytonaEnvironment({ delete: remove }, "environment", 3_500)).rejects.toThrow("cleanup failed");
      expect(remove).toHaveBeenCalledTimes(2);
      vi.setSystemTime(0);
      const lateSuccess = vi.fn(async () => { vi.setSystemTime(3_500); });
      await expect(deleteDaytonaEnvironment({ delete: lateSuccess }, "environment", 3_500)).rejects.toThrow("deadline expired");
    } finally { vi.useRealTimers(); }
  });

  it("preserves the120s default for callers without an absolute cleanup deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const remove = vi.fn(async () => { throw new Error("DELETE409 pending_cleanup"); });
    try {
      const completed = deleteDaytonaEnvironment({ delete: remove }, "environment").catch(error => error);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await completed).toMatchObject({ message: expect.stringContaining("cleanup failed") });
      expect(remove).toHaveBeenCalledTimes(40);
    } finally { vi.useRealTimers(); }
  });
});
