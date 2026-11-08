import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChaosApi } from "./api.js";
import { seedChaosLab } from "./seed.js";
import { Timeline } from "./timeline.js";

type Call = { method: string; route: string; body?: unknown };

/** Records the seed's board API calls; answers like a fresh local_trusted instance. */
function fakeApi(experimentalResponse: (body: Record<string, unknown>) => Record<string, unknown>) {
  const calls: Call[] = [];
  let ids = 0;
  const api = {
    get: async (route: string) => {
      calls.push({ method: "GET", route });
      if (route.includes("/environments")) return [{ id: "environment-1", driver: "local" }];
      throw new Error(`unexpected GET ${route}`);
    },
    post: async (route: string, body?: unknown) => {
      calls.push({ method: "POST", route, body });
      return { id: `id-${++ids}`, name: "x" };
    },
    patch: async (route: string, body?: unknown) => {
      calls.push({ method: "PATCH", route, body });
      if (route === "/api/instance/settings/experimental") return experimentalResponse(body as Record<string, unknown>);
      throw new Error(`unexpected PATCH ${route}`);
    },
  };
  return { api: api as unknown as ChaosApi, calls };
}

describe("seedChaosLab workspace isolation", () => {
  let fixtureRoot: string;
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "rc21-seed-"));
    vi.stubEnv("OPENAI_API_KEY", "test-only-not-a-key");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  const seed = (api: ChaosApi) => seedChaosLab({ api, env: "local", adapters: ["codex"], concurrency: 2,
    budgetCents: 3_000, fixtureRoot, waveId: "w-test", timeline: new Timeline(null) });

  // RC-21: the project's git_worktree policy is gated behind the instance's
  // isolated-workspaces setting. Without it every repo task ran in the shared
  // primary checkout, so concurrent tasks wrote into one tree.
  it("enables isolated workspaces before creating the git_worktree project", async () => {
    const { api, calls } = fakeApi(body => ({ ...body }));
    await seed(api);
    const enable = calls.findIndex(call => call.method === "PATCH" && call.route === "/api/instance/settings/experimental"
      && (call.body as Record<string, unknown>).enableIsolatedWorkspaces === true);
    const project = calls.findIndex(call => call.method === "POST" && call.route.endsWith("/projects"));
    expect(enable).toBeGreaterThanOrEqual(0);
    expect(project).toBeGreaterThan(enable);
    expect((calls[project]!.body as { executionWorkspacePolicy: unknown }).executionWorkspacePolicy)
      .toMatchObject({ enabled: true, defaultMode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } });
  });

  it("refuses to seed when the instance does not confirm isolated workspaces", async () => {
    const { api, calls } = fakeApi(() => ({ enableIsolatedWorkspaces: false }));
    await expect(seed(api)).rejects.toThrow(/isolated workspaces/i);
    expect(calls.some(call => call.method === "POST" && call.route.endsWith("/projects"))).toBe(false);
  });
});

describe("seedChaosLab RC-06 mask", () => {
  let fixtureRoot: string;
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "rc06-seed-"));
    vi.stubEnv("OPENAI_API_KEY", "test-only-not-a-key");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  const seed = (api: ChaosApi, timeline: Timeline, masks?: string[]) => seedChaosLab({ api, env: "local", adapters: ["codex"],
    concurrency: 2, budgetCents: 3_000, fixtureRoot, waveId: "w-test", timeline, ...(masks ? { masks } : {}) });
  const isPolicyCall = (call: Call) => call.method === "POST" && /^\/api\/companies\/[^/]+\/budgets\/policies$/.test(call.route);

  it("keeps the budget amount and disables only the company hard stop", async () => {
    const { api, calls } = fakeApi(body => ({ ...body }));
    const timeline = new Timeline(null);
    await seed(api, timeline, ["rc06"]);
    const company = calls.find(call => call.method === "POST" && call.route === "/api/companies")!;
    expect((company.body as { budgetMonthlyCents: number }).budgetMonthlyCents).toBe(3_000);
    const policies = calls.filter(isPolicyCall);
    expect(policies).toHaveLength(1);
    expect(policies[0]!.route).toBe("/api/companies/id-1/budgets/policies");
    expect(policies[0]!.body).toEqual({ scopeType: "company", scopeId: "id-1", amount: 3_000, hardStopEnabled: false });
    expect(timeline.entries.filter(entry => entry.kind === "seed_mask_rc06"))
      .toEqual([expect.objectContaining({ companyId: "id-1", budgetCents: 3_000, hardStopEnabled: false })]);
  });

  it("leaves the company hard stop on without the mask", async () => {
    const { api, calls } = fakeApi(body => ({ ...body }));
    const timeline = new Timeline(null);
    await seed(api, timeline);
    expect(calls.some(isPolicyCall)).toBe(false);
    expect(timeline.entries.some(entry => entry.kind === "seed_mask_rc06")).toBe(false);
  });
});
