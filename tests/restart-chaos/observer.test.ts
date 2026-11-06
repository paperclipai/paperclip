import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChaosApi } from "./api.js";
import { REST_CONFIRM_MS, TaskObserver, listWorkspaceFiles } from "./observer.js";
import { createFixtureRepository, type ChaosLab } from "./seed.js";
import { Timeline } from "./timeline.js";
import type { TaskPlan } from "./types.js";
import { BENCH_EXPECTED, parseBenchRecord } from "./workloads.js";

process.env.RESTART_CHAOS_QUIET = "1";
const lab: ChaosLab = { companyId: "c1", environmentId: "e1", projectId: "p1", fixtureRepositoryPath: "/tmp/none",
  agents: { codex: { id: "a1", name: "Chaos codex" }, claude: { id: "a2", name: "Chaos claude" }, opencode: { id: "a3", name: "Chaos opencode" } } };
const plan: TaskPlan = { taskId: "t01", index: 0, workload: "C1", adapter: "codex", fault: "K1", fireAfterMs: 999_999,
  holdMs: 0, followUpAfterMs: 1_000, nonce: "abcd1234" };
const ready = { serverReady: true, faultInProgress: false };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

/** Fake board API: a C1 issue whose first run already finished. */
function fakeApi(overrides: Partial<Record<string, (route: string) => unknown>> = {}) {
  const posted: string[] = [];
  const api = {
    async get(route: string) {
      for (const [prefix, handler] of Object.entries(overrides)) if (route.includes(prefix)) return handler!(route);
      if (route.endsWith("/runs")) return [{ runId: "r1", status: "succeeded", createdAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString() }];
      return { id: "i1", status: "in_progress", interruption: null };
    },
    async post(route: string) { posted.push(route); return route.endsWith("/issues") ? { id: "i1", identifier: "CHA-1" } : { id: "comment-1" }; },
  };
  return { api: api as unknown as ChaosApi, posted };
}

describe("TaskObserver", () => {
  it("does not finish a C1 task on the poll that posts the follow-up", async () => {
    const { api, posted } = fakeApi();
    const observer = new TaskObserver(plan, api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    // The task rests before the follow-up is due, for longer than the rest window.
    await observer.poll(start + 100);
    await observer.poll(start + 100 + REST_CONFIRM_MS + 1);
    expect(observer.done).toBe(false);
    expect(observer.record.followUp).toMatchObject({ commentId: "comment-1" });
    expect(posted.some(route => route.endsWith("/comments"))).toBe(true);
    // A fresh rest window must elapse after the comment before the task counts as resting.
    await observer.poll(start + 200 + REST_CONFIRM_MS + 2);
    expect(observer.done).toBe(false);
    await observer.poll(start + 300 + 2 * REST_CONFIRM_MS + 3);
    expect(observer.done).toBe(true);
  });

  it("reports a failed workspace-operation read as a sweep error, not a clean rest", async () => {
    const { api } = fakeApi({ "/workspace-operations": () => { throw new Error("timeout"); } });
    const observer = new TaskObserver(plan, api, lab, new Timeline(null), ready);
    await observer.launch();
    const sweep = await observer.sweep();
    expect(sweep.error).toMatch(/timeout/);
  });

  it("fires the planned fault once, after its offset", async () => {
    const { api } = fakeApi();
    const observer = new TaskObserver({ ...plan, fireAfterMs: 5_000 }, api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    expect(observer.faultDue(start + 4_999)).toBeNull();
    expect(observer.faultDue(start + 5_000)).toEqual({ kind: "K1", holdMs: 0, atMs: 5_000 });
    expect(observer.faultDue(start + 6_000)).toBeNull();
  });
});

describe("fixture repository", () => {
  it("lists workspace files without VCS or cache directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-fixture-"));
    directories.push(root);
    await createFixtureRepository(root);
    const files = await listWorkspaceFiles(root);
    expect(files).toContain("chaoscli/cli.py");
    expect(files.some(file => file.startsWith(".git/"))).toBe(false);
  });

  it("bench.sh writes a tagged completion record with the deterministic result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-bench-"));
    directories.push(root);
    await createFixtureRepository(root, 1);
    const output = execFileSync("./bench.sh", ["abcd1234"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    expect(output.trim().split("\n").at(-1)).toBe(BENCH_EXPECTED);
    const record = parseBenchRecord(await readFile(path.join(root, ".bench", "run-abcd1234.txt"), "utf8"));
    expect(record?.result).toBe(BENCH_EXPECTED);
  }, 60_000);
});
