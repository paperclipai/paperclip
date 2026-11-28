import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readClarificationState, runClarificationJourney } from "./clarification-flow.js";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./types.js";

vi.mock("../user-actions.js", async importOriginal => ({ ...await importOriginal<typeof import("../user-actions.js")>(),
  createTaskThroughUi: async () => ({ issueId: "11111111-1111-4111-8111-111111111111" }) }));

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const parent = { id: issueId, companyId, parentId: null, assigneeAgentId: "agent", status: "in_progress" };
const child = { id: "child", companyId, parentId: issueId };
function fixture(rows = [parent, child], runs: Record<string, any>[] = []) {
  const get = vi.fn(async (route: string) => {
    const url = new URL(route, "https://qa.example.test");
    if (url.pathname === `/api/companies/${companyId}/issues`) {
      if (url.searchParams.get("view") !== "index") throw Error("unsupported child projection");
      return rows.filter(row => row.parentId === url.searchParams.get("parentIds"));
    }
    if (url.pathname === `/api/issues/${issueId}`) return parent;
    if (url.pathname === `/api/issues/${issueId}/runs`) return runs.map(run => ({ runId: run.id }));
    if (url.pathname.startsWith("/api/heartbeat-runs/")) return runs.find(run => url.pathname.endsWith(`/${run.id}`));
    return [];
  });
  const context = { company: { id: companyId }, environmentId: "daytona", api: { get },
    agent: { id: "agent", provider: "opencode", model: "model", runtimeMode: "native" } } as unknown as JourneyContext;
  return { context, get };
}
it("reads the supported child projection while excluding the journey task and unrelated company work", async () => {
  const { context, get } = fixture([parent, child, { id: "unrelated", companyId, parentId: "other" }]);
  expect((await readClarificationState(context, issueId)).children).toEqual([child]);
  expect(get).toHaveBeenCalledWith(`/api/companies/${companyId}/issues?view=index&parentIds=${issueId}&limit=2`);
});

const failedRun = { id: "run", companyId, agentId: "agent", issueId, status: "failed", runtimeMode: "native",
  errorCode: "native_provider_terminal_failed", error: "Synthetic provider failure",
  contextSnapshot: { paperclipEnvironment: { id: "daytona" } },
  runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: "model" } } } };

it("retains the bound failed run before the first stable question checkpoint, without accepting it", async () => {
  const retained = vi.fn(async () => {});
  const { context } = fixture([parent], [failedRun]);
  await expect(readClarificationState(context, issueId, retained)).rejects.toMatchObject({ code: "agent_run_failed" });
  expect(retained).toHaveBeenCalledExactlyOnceWith({ issueId, runs: [{ id: "run", status: "failed", errorCode: "native_provider_terminal_failed" }] });
  expect(JSON.stringify(retained.mock.calls)).not.toContain("Synthetic provider failure");
});

it.each([
  { ...failedRun, id: "foreign", companyId: "other" },
  { ...failedRun, id: "foreign", issueId: "other" },
  { ...failedRun, id: "foreign", agentId: "other" },
  { ...failedRun, id: "foreign", contextSnapshot: { paperclipEnvironment: { id: "other" } } },
  { ...failedRun, id: "foreign", runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: "other" } } } },
])("does not retain a failure snapshot with a later foreign run: %j", async foreign => {
  const retained = vi.fn(async () => {});
  const { context } = fixture([parent], [failedRun, foreign]);
  await expect(readClarificationState(context, issueId, retained)).rejects.toMatchObject({ code: "agent_run_binding_mismatch" });
  expect(retained).not.toHaveBeenCalled();
});

it("saves the failure receipt through final grading without inventing a question checkpoint", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "clarification-failure-"));
  const { context } = fixture([parent], [failedRun]);
  const evidence = { checks: [] } as unknown as JourneyEvidence;
  try {
    await expect(runClarificationJourney(context, { own: async () => {} } as unknown as TargetSession,
      "synthetic-campaign", evidence, { deadlineAt: Date.now() + 10_000, directory, capture: async () => {} }))
      .rejects.toMatchObject({ code: "agent_run_failed" });
    const receipt = JSON.parse(await readFile(path.join(directory, "clarification-run-failure.json"), "utf8"));
    expect(receipt).toEqual({ issueId, runs: [{ id: "run", status: "failed", errorCode: "native_provider_terminal_failed" }] });
    const graded = JSON.parse(await readFile(path.join(directory, "clarification.json"), "utf8"));
    expect(graded.checkpoints).toEqual([]);
    expect(graded.checks).toHaveLength(11);
    expect(graded.checks.every((check: { passed: boolean }) => !check.passed)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("omits free-form error codes from the failure receipt", async () => {
  const retained = vi.fn(async () => {});
  const { context } = fixture([parent], [{ ...failedRun, errorCode: "Provider refused token=synthetic-secret" }]);
  await expect(readClarificationState(context, issueId, retained)).rejects.toMatchObject({ code: "agent_run_failed" });
  expect(retained).toHaveBeenCalledExactlyOnceWith({ issueId, runs: [{ id: "run", status: "failed" }] });
});

it("keeps the original run failure when private evidence cannot be saved", async () => {
  const retained = vi.fn(async () => { throw Error("Synthetic disk failure"); });
  const { context } = fixture([parent], [failedRun]);
  await expect(readClarificationState(context, issueId, retained)).rejects.toMatchObject({ code: "agent_run_failed",
    cause: expect.objectContaining({ message: "clarification_failure_evidence_write_failed" }) });
});
it("retains an empty child result for a task that did not delegate work", async () => {
  expect((await readClarificationState(fixture([parent]).context, issueId)).children).toEqual([]);
});
it.each([{ ...child, companyId: "other" }, { ...child, parentId: "other" }])("rejects a returned child outside the owned company or task", async foreign => {
  const { context, get } = fixture();
  get.mockImplementation(async route => route.includes("/companies/") ? [foreign] : route === `/api/issues/${issueId}` ? parent : []);
  await expect(readClarificationState(context, issueId)).rejects.toMatchObject({ code: "clarification_child_query_mismatch" });
});
