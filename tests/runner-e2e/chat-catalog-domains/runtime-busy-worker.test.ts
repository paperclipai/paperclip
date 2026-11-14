import { expect, it, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { readRuntimeTaskGate, releaseRuntimeWorker, taskBoundRuntimeGate, prepareRuntimeWorkerGate } from "./runtime-busy-worker.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-task-gate-")); roots.push(root); vi.stubEnv("PAPERCLIP_RUNNER_E2E_TEMP_ROOT", root);
  const cwd = path.join(root, "isolated-workspaces", "company", "task"); await mkdir(cwd, { recursive: true });
  const task = { id: "task", companyId: "company", assigneeAgentId: "worker", executionWorkspaceId: "workspace" };
  const workspace = { id: "workspace", companyId: "company", cwd };
  const ctx = { input: { fixtures: { company: { id: "company" } }, api: { get: async (url: string) => url.endsWith("/workspace") ? { workspace } : task } } } as unknown as ChatCatalogContext;
  return { root, cwd, task, workspace, ctx };
}
it("a real bounded Node utility creates readiness in actual task cwd and emits only the genuine released brief", async () => {
  const f = await fixture(), gate = taskBoundRuntimeGate("owned-test", 3000);
  expect(await readRuntimeTaskGate(f.ctx, gate, "task", "worker")).toBe("");
  const child = spawn("/bin/sh", ["-c", `exec ${gate.command}`], { cwd: f.cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; child.stdout.on("data", bytes => { stdout += bytes; });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  try {
    for (let i = 0; i < 50 && await readRuntimeTaskGate(f.ctx, gate, "task", "worker") !== "waiting"; i++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(await readFile(gate.ready, "utf8")).toBe("waiting"); expect(child.exitCode).toBeNull(); expect(stdout).toBe("");
    await writeFile(gate.gate, "Actual human brief: preserve existing website.");
    expect(await exited).toBe(0); expect(stdout.trim()).toBe("Actual human brief: preserve existing website.");
    expect(gate.gate.startsWith(await realpath(f.cwd) + path.sep)).toBe(true);
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await exited; } }
});
it("rejects another company, assignee, active binding or changed workspace before reading/releasing", async () => {
  const f = await fixture(), gate = taskBoundRuntimeGate("scope-test");
  f.task.assigneeAgentId = "other"; await expect(readRuntimeTaskGate(f.ctx, gate, "task", "worker")).rejects.toThrow("assignee");
  f.task.assigneeAgentId = "worker"; f.workspace.companyId = "foreign"; await expect(readRuntimeTaskGate(f.ctx, gate, "task", "worker")).rejects.toThrow("company");
  f.workspace.companyId = "company"; f.task.executionWorkspaceId = "other"; await expect(readRuntimeTaskGate(f.ctx, gate, "task", "worker")).rejects.toThrow("binding");
  f.task.executionWorkspaceId = "workspace"; await readRuntimeTaskGate(f.ctx, gate, "task", "worker");
  f.workspace.id = "new"; f.task.executionWorkspaceId = "new";
  await expect(readRuntimeTaskGate(f.ctx, gate, "task", "worker")).rejects.toThrow("changed after admission");
});
it("rejects escaping workspace and readiness symlinks instead of treating foreign bytes as busy evidence", async () => {
  const f = await fixture(), gate = taskBoundRuntimeGate("symlink-test");
  await readRuntimeTaskGate(f.ctx, gate, "task", "worker");
  await writeFile(path.join(f.root, "outside-ready"), "waiting"); await symlink(path.join(f.root, "outside-ready"), gate.ready);
  await expect(readRuntimeTaskGate(f.ctx, gate, "task", "worker")).rejects.toThrow("readiness path escapes");
  f.workspace.cwd = tmpdir();
  await expect(readRuntimeTaskGate(f.ctx, taskBoundRuntimeGate("outside"), "task", "worker")).rejects.toThrow("owned attempt root");
});
it("retains neutral cleanup release and refuses timeout widening", async () => {
  const f = await fixture(), gate = taskBoundRuntimeGate("cleanup"); await readRuntimeTaskGate(f.ctx, gate, "task", "worker");
  await releaseRuntimeWorker({ gate });
  expect(await readFile(gate.gate, "utf8")).toBe("The human ended this disposable fixture. Preserve any saved work and finish normally.");
  expect(() => taskBoundRuntimeGate("too-long", 300001)).toThrow("bounded");
});
it("funds source and worker before task-bound history, without exposing an agent-home script or admitting work", async () => {
  const f = await fixture(); vi.stubEnv("PAPERCLIP_HOME", path.join(f.root, "paperclip-home")); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "owned-test");
  const funded: string[] = [];
  const ctx = { input: { nonce: "history", execution: { environment: { id: "local" } }, fixtures: { company: { id: "company" }, agent: { id: "source-agent" } },
    api: { post: async (_url: string, body: { scopeId: string; unpricedUsagePolicy: string }) => { expect(body.unpricedUsagePolicy).toBe("allow"); funded.push(body.scopeId); } } }, allRuns: async () => [] } as unknown as ChatCatalogContext;
  const prepared = await prepareRuntimeWorkerGate(ctx, { worker: { id: "worker" }, taskBound: true });
  expect(funded).toEqual(["company", "worker", "source-agent"]);
  expect(prepared.gate.scriptPath).toBe(""); expect(prepared.gate.command).not.toContain(f.root);
});
