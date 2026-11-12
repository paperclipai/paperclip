import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const prepare = vi.hoisted(() => vi.fn());
const poll = vi.hoisted(() => vi.fn());
vi.mock("./runtime-busy-worker.js", async original => ({ ...await original<object>(), prepareRuntimeWorkerGate: prepare }));
vi.mock("../api.js", async original => ({ ...await original<object>(), pollUntil: poll }));
import { readRuntimeTaskGate, taskBoundRuntimeGate } from "./runtime-busy-worker.js";
import { runtimeApprovalQueueCases } from "./runtime-approval-queue.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); poll.mockReset(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const parkedResult = { nativeResult: { reportedWorkDisposition: "yielded", evidence: [{ ref: "interaction:question" }],
  continuation: { kind: "response_wake", idempotencyKey: "interaction-response:question" } } };
async function fixture(run: { status: string; resultJson: unknown } = { status: "succeeded", resultJson: parkedResult }) {
  const root = await mkdtemp(path.join(tmpdir(), "approval-owned-task-")); roots.push(root); vi.stubEnv("PAPERCLIP_RUNNER_E2E_TEMP_ROOT", root);
  const cwd = path.join(root, "actual-isolated-task"); await mkdir(cwd);
  const gate = taskBoundRuntimeGate("approval-owned");
  await writeFile(path.join(cwd, `${gate.gateName}.waiting`), "waiting");
  const task = { id: "task", companyId: "company", assigneeAgentId: "morgan", executionWorkspaceId: "workspace" };
  const workspace = { id: "workspace", companyId: "company", cwd };
  const post = vi.fn(async (_url: string, _body: unknown) => task);
  prepare.mockImplementation(async (_ctx, options) => { expect(options).toEqual({ taskBound: true }); return { gate, worker: { id: "morgan" } }; });
  const get = async (url: string) => url.endsWith("/workspace") ? { workspace }
    : url.endsWith("/interactions") ? [{ id: "question", kind: "ask_user_questions", status: "pending", issueId: "task", createdByAgentId: "morgan", sourceRunId: "run" }]
      : url === "/api/heartbeat-runs/run" ? { id: "run", ...run } : task;
  const ctx = { input: { nonce: "approval-owned", fixtures: { company: { id: "company" } }, api: { post, get } }, allRuns: async () => [{ id: "run", agentId: "morgan", status: run.status }] } as unknown as ChatCatalogContext;
  return { ctx, root, cwd, task, workspace, gate, post };
}
it("approval setup gates the question on the product's parked pending-input turn and scripts a cwd-local bounded wait", async () => {
  const f = await fixture();
  poll.mockImplementationOnce(async options => { const value = await options.load(); expect(options.accept(value)).toBe(true); expect(options.reject(value)).toBeUndefined(); throw new Error("verified pending-input boundary"); });
  await expect(runtimeApprovalQueueCases[0]!.setup(f.ctx)).rejects.toThrow("verified pending-input boundary");
  expect(f.post.mock.calls[0]![1]).toMatchObject({ assigneeAgentId: "morgan", status: "todo" });
  const body = f.post.mock.calls[0]![1] as { description: string };
  expect(body.description).toContain(`run ${f.gate.command} once`);
  expect(body.description).not.toContain(f.root);
});
it.each([
  ["a question turn that is still running", { status: "running", resultJson: null }, false],
  ["a turn that completed without parking on the question", { status: "succeeded", resultJson: { nativeResult: { ...parkedResult.nativeResult, reportedWorkDisposition: "completed" } } }, true],
])("approval setup does not accept %s", async (_label, run, rejected) => {
  const f = await fixture(run);
  poll.mockImplementationOnce(async options => { const value = await options.load(); expect(options.accept(value)).toBe(false); expect(Boolean(options.reject(value))).toBe(rejected); throw new Error("checked"); });
  await expect(runtimeApprovalQueueCases[0]!.setup(f.ctx)).rejects.toThrow("checked");
});
it("the active-turn gate binds the actual assigned task workspace", async () => {
  const f = await fixture();
  await expect(readRuntimeTaskGate(f.ctx, f.gate, "task", "morgan")).resolves.toBe("waiting");
  expect(f.gate.boundTaskId).toBe("task"); expect(f.gate.boundWorkspaceId).toBe("workspace");
  expect(f.gate.ready).toBe(path.join(await realpath(f.cwd), `${f.gate.gateName}.waiting`));
});
it.each(["company", "assignee", "workspace"])("the active-turn gate rejects foreign %s readiness", async invalid => {
  const f = await fixture();
  if (invalid === "company") f.workspace.companyId = "foreign";
  if (invalid === "assignee") f.task.assigneeAgentId = "other";
  if (invalid === "workspace") f.task.executionWorkspaceId = "other";
  await expect(readRuntimeTaskGate(f.ctx, f.gate, "task", "morgan")).rejects.toThrow(/actual company, assignee and workspace/);
});
