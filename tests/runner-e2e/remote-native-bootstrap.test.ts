import { explicitlyRequestsFileOutput } from "../../server/src/services/native-runtime/native-deliverable-feedback.js";
import { copilotProtectionTasks } from "./copilot-protection-tasks.js";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { classifyFailure } from "./failure-classifier.js";
import { ObservedStateTimeout, RemoteAdmissionReadError, RunnerApi, RunnerApiHttpError } from "./api.js";
import { createRemoteNativeBootstrap } from "./remote-native-bootstrap.js";
import { REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS, type RemoteFixtureApi, type RemoteNativeFixture } from "./remote-native-fixtures.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function harness(timeoutMs = REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS + 18_000) {
  const order: string[] = [];
  const issue = { id: "issue", companyId: "company", assigneeAgentId: "agent" };
  const run = { id: "run", companyId: "company", agentId: "agent", status: "running", executionStage: "preparing" };
  const leases = [{ id: "lease", heartbeatRunId: "run", issueId: "issue", status: "active", providerLeaseId: "sandbox" }];
  const api = { get: vi.fn(async (path: string) => path === "/api/issues/issue" ? issue : path === "/api/heartbeat-runs/run" ? run : leases) };
  const fixture = {
    binding: { companyId: "company", environmentId: "env", runId: "run", leaseId: "lease", sandboxId: "sandbox", remoteCwd: "/workspace" },
    baseline: { complete: true },
    publishAction: vi.fn(async () => { order.push("publish"); }),
    close: vi.fn(async () => { order.push("close"); }),
  } as unknown as RemoteNativeFixture;
  const bind = vi.fn(async () => { order.push("armed"); return fixture; });
  const input = {
    api: api as unknown as RemoteFixtureApi, daytona: { get: vi.fn() }, companyId: "company", environmentId: "env", agentId: "agent",
    image: `image@sha256:${"a".repeat(64)}`, nodeSha256: `sha256:${"b".repeat(64)}`, runnerdSha256: `sha256:${"c".repeat(64)}`,
    deadlineAt: Date.now() + timeoutMs, evidence: vi.fn(async (_name: string, _data: unknown) => { order.push("evidence"); }),
  };
  const bootstrap = createRemoteNativeBootstrap(input, bind);
  const request = { issueId: "issue", runId: "run", targets: ["target.txt"], actionPrompt: async (actual: RemoteNativeFixture) => {
    expect(actual).toBe(fixture); await Promise.resolve(); order.push("baseline"); return "PRIVATE ACTUAL ACTION";
  } };
  return { bootstrap, input, bind, api, issue, run, leases, fixture, request, order };
}

it("keeps negated bootstrap instructions out of the production file-delivery contract", () => {
  const prompt = harness().bootstrap.prompt("nonce");
  // Retained failed attempt: comma splitting detached this clause from “do not”.
  const original = "Before reading those instructions, do not infer the task, run shell commands, create or modify any file, ask replacement questions, or mark work complete. Do not create the missing instruction file.";
  expect(explicitlyRequestsFileOutput(original)).toBe(true);
  expect(explicitlyRequestsFileOutput(prompt)).toBe(false);
  expect(prompt).toContain("Do not create or modify any file.");
  expect(prompt).toContain("Do not run shell commands.");
  expect(prompt).toContain("Do not ask replacement questions.");
  expect(prompt).toContain("Do not mark work complete.");
  expect(prompt).toContain("Do not create the missing instruction file.");
  // A real requested output still requires delivery; no production gate changes.
  expect(explicitlyRequestsFileOutput(`${prompt}\nCreate a downloadable report.txt file.`)).toBe(true);
});

it("delivers the required direct Copilot context tool guidance before publishing native actions", () => {
  const h = harness();
  const prompt = createRemoteNativeBootstrap({ ...h.input, requireCopilotTaskContext: true }, h.bind).prompt("copilot");
  expect(prompt).toContain("get_task_context tool is already available directly");
  expect(prompt).toContain("get_task_context exactly once");
  expect(prompt).toContain("Do not call search_api or use call_api or an HTTP route as a substitute");
  expect(explicitlyRequestsFileOutput(prompt)).toBe(false);
  expect(h.bootstrap.prompt("other-provider")).not.toContain("get_task_context");
});

it("keeps async completion immediate with a private sentinel and no delivery wait", () => {
  const task = copilotProtectionTasks.find(task => task.id === "attached-async-settlement")!;
  const action = task.buildPrompt("nonce");
  expect(explicitlyRequestsFileOutput(action)).toBe(false);
  expect(explicitlyRequestsFileOutput(`${harness().bootstrap.prompt("nonce")}\n${action}`)).toBe(false);
  expect(action).toContain("attempt to finish immediately without calling read_bash or another waiting tool");
  expect(action).toContain("Do not modify fixture code, manufacture its result, or start another command.");
  expect(action).toContain("private diagnostic sentinel, not a requested file deliverable");
  expect(action).toContain("evidence [], verification []");
  expect(action).not.toContain("register_deliverable");
});

it("keeps the complete readiness/install reserve when a lease arrives at the admission boundary", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS + 1000); h.bootstrap.prompt("late-lease");
  const lease = h.leases.pop()!;
  let remainingAtBind = 0;
  h.bind.mockImplementation(async () => { remainingAtBind = h.input.deadlineAt - Date.now(); return h.fixture; });
  const pending = h.bootstrap.bindAndRelease(h.request);
  await vi.advanceTimersByTimeAsync(800);
  expect(h.bind).not.toHaveBeenCalled(); expect(h.fixture.publishAction).not.toHaveBeenCalled();
  h.leases.push(lease); await vi.advanceTimersByTimeAsync(100);
  await expect(pending).resolves.toBe(h.fixture);
  expect(remainingAtBind).toBeGreaterThanOrEqual(REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS);
  expect(h.bind).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deadlineAt: h.input.deadlineAt }));
  expect(h.order.indexOf("baseline")).toBeLessThan(h.order.indexOf("publish"));
});

it("withholds actual work until exact run admission, armed observer and awaited baseline", async () => {
  const h = harness(); const prompt = h.bootstrap.prompt("nonce");
  expect(prompt).not.toContain("PRIVATE ACTUAL ACTION");
  expect(prompt).toContain("native file-read tool");
  expect(h.bind).not.toHaveBeenCalled();
  expect(await h.bootstrap.bindAndRelease(h.request)).toBe(h.fixture);
  expect(h.order).toEqual(["armed", "baseline", "evidence", "publish"]);
  expect(h.bind).toHaveBeenCalledWith(expect.objectContaining({
    sdkVersion: "0.203.0", targets: ["target.txt"],
    authority: { companyId: "company", environmentId: "env", runId: "run", leaseId: "lease", sandboxId: "sandbox", image: h.input.image },
  }));
  expect(h.fixture.publishAction).toHaveBeenCalledWith(expect.stringMatching(/^\.paperclip-eval-action-[a-f0-9]{36}\.txt$/u), "PRIVATE ACTUAL ACTION");
  expect(JSON.stringify(h.input.evidence.mock.calls)).not.toContain("PRIVATE ACTUAL ACTION");
  await expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow("one unconsumed");
});

it.each(["issue-company", "issue-agent", "issue-id", "run-company", "run-agent", "run-id", "run-terminal", "ambiguous-lease"])("rejects %s before observer execution or action delivery", async variant => {
  const h = harness(); h.bootstrap.prompt("nonce");
  if (variant === "issue-company") h.issue.companyId = "other";
  if (variant === "issue-agent") h.issue.assigneeAgentId = "other";
  if (variant === "issue-id") h.issue.id = "other";
  if (variant === "run-company") h.run.companyId = "other";
  if (variant === "run-agent") h.run.agentId = "other";
  if (variant === "run-id") h.run.id = "other";
  if (variant === "run-terminal") h.run.status = "succeeded";
  if (variant === "ambiguous-lease") h.leases.push({ ...h.leases[0]!, id: "second" });
  await expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow();
  expect(h.bind).not.toHaveBeenCalled(); expect(h.fixture.publishAction).not.toHaveBeenCalled();
});

it("waits through queued admission without publishing early", async () => {
  const h = harness(); h.bootstrap.prompt("nonce"); h.run.status = "queued";
  const original = h.api.get.getMockImplementation()!; let count = 0;
  h.api.get.mockImplementation(async path => {
    if (path === "/api/heartbeat-runs/run" && ++count === 2) h.run.status = "running";
    return original(path);
  });
  await h.bootstrap.bindAndRelease(h.request);
  expect(count).toBe(2); expect(h.fixture.publishAction).toHaveBeenCalledTimes(1);
});

it.each(["", "x".repeat(16385)])("rejects empty or over-bound action after closing only its observer", async action => {
  const h = harness(); h.bootstrap.prompt("nonce");
  await expect(h.bootstrap.bindAndRelease({ ...h.request, actionPrompt: () => action })).rejects.toThrow("empty or too large");
  expect(h.fixture.publishAction).not.toHaveBeenCalled(); expect(h.fixture.close).toHaveBeenCalledTimes(1);
});

it("retains uncertain delivery and cleanup failure without retrying publication", async () => {
  const h = harness(); h.bootstrap.prompt("nonce");
  vi.mocked(h.fixture.publishAction).mockRejectedValue(new Error("uncertain delivery"));
  vi.mocked(h.fixture.close).mockRejectedValue(new Error("cleanup failed"));
  await expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow("observer cleanup is unproven");
  await expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow("one unconsumed");
  expect(h.fixture.publishAction).toHaveBeenCalledTimes(1);
});

it("rejects ambiguous bootstrap delivery and reused nonces", async () => {
  const h = harness(); h.bootstrap.prompt("first");
  expect(() => h.bootstrap.prompt("first")).toThrow("reused"); h.bootstrap.prompt("second");
  await expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow("one unconsumed");
  expect(h.api.get).not.toHaveBeenCalled();
});

it.each(["nodeSha256", "runnerdSha256", "image"])("requires immutable %s before any remote call", field => {
  const h = harness();
  expect(() => createRemoteNativeBootstrap({ ...h.input, [field]: "ambient-latest" }, h.bind)).toThrow("immutable");
  expect(h.input.daytona.get).not.toHaveBeenCalled();
});


it("admits a cold building_snapshot lease after 20 seconds within the unchanged case deadline", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(90_000); h.bootstrap.prompt("cold");
  const original = h.api.get.getMockImplementation()!;
  let sandboxState = "building_snapshot";
  h.api.get.mockImplementation(async path => path.endsWith("/leases") && sandboxState === "building_snapshot" ? [] : original(path));
  const delivery = h.bootstrap.bindAndRelease(h.request);
  await vi.advanceTimersByTimeAsync(25_000);
  expect(h.bind).not.toHaveBeenCalled(); expect(h.fixture.publishAction).not.toHaveBeenCalled();
  sandboxState = "started";
  await vi.advanceTimersByTimeAsync(100);
  await expect(delivery).resolves.toBe(h.fixture);
  expect(h.bind).toHaveBeenCalledWith(expect.objectContaining({ deadlineAt: 90_000 }));
  expect(h.input.daytona.get).not.toHaveBeenCalled();
});

it.each(["failed", "cancelled", "succeeded"])("stops waiting immediately when provisioning run becomes %s", async status => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS + 18_000); h.bootstrap.prompt("terminal"); h.leases.length = 0;
  const delivery = expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow("stopped before observer setup");
  await vi.advanceTimersByTimeAsync(1000); h.run.status = status;
  await vi.advanceTimersByTimeAsync(100); await delivery;
  expect(Date.now()).toBeLessThan(h.input.deadlineAt);
  expect(h.bind).not.toHaveBeenCalled(); expect(h.fixture.publishAction).not.toHaveBeenCalled();
  expect(h.input.evidence).toHaveBeenCalledWith("remote-native-bootstrap-startup-run.json", expect.objectContaining({ runStatus: status, deadlineReached: false }));
});

it("rechecks run ownership while waiting for the lease", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(); h.bootstrap.prompt("owner"); h.leases.length = 0;
  const delivery = expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow("ownership is unproven");
  await vi.advanceTimersByTimeAsync(100); h.run.companyId = "foreign";
  await vi.advanceTimersByTimeAsync(100); await delivery;
  expect(h.bind).not.toHaveBeenCalled(); expect(h.fixture.publishAction).not.toHaveBeenCalled();
});

it.each(["foreign-run", "foreign-issue", "inactive", "missing-provider"])("never admits %s and reserves setup time within the authored deadline with bounded state", async variant => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS + 1000); h.bootstrap.prompt("timeout");
  if (variant === "foreign-run") h.leases[0]!.heartbeatRunId = "foreign";
  if (variant === "foreign-issue") h.leases[0]!.issueId = "foreign";
  if (variant === "inactive") h.leases[0]!.status = "released";
  if (variant === "missing-provider") h.leases[0]!.providerLeaseId = "";
  h.run.executionStage = "PRIVATE".repeat(10_000);
  const delivery = expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow("Timed out waiting for owned native qualification lease");
  await vi.advanceTimersByTimeAsync(1000); await delivery;
  expect(Date.now()).toBe(1000); expect(h.bind).not.toHaveBeenCalled();
  expect(h.fixture.publishAction).not.toHaveBeenCalled();
  const state = h.input.evidence.mock.calls[0]![1];
  expect(state).toMatchObject({ executionStage: "unknown", activeOwnedLeaseCount: 0, deadlineReached: false, admissionDeadlineReached: true });
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(512);
  expect(JSON.stringify(state)).not.toContain("PRIVATE");
});

it("rejects a second same-run lease even if only one lease is active", async () => {
  const h = harness(); h.bootstrap.prompt("ambiguous");
  h.leases.push({ ...h.leases[0]!, id: "old", status: "released" });
  await expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow("Ambiguous native qualification lease");
  expect(h.bind).not.toHaveBeenCalled(); expect(h.fixture.publishAction).not.toHaveBeenCalled();
});

it("does not start observation after the case deadline", async () => {
  const h = harness(0); h.bootstrap.prompt("expired");
  await expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow("Timed out waiting");
  expect(h.api.get).not.toHaveBeenCalled(); expect(h.bind).not.toHaveBeenCalled();
});


it.each(["terminal", "run-owner", "issue-owner"])("does not lose a successful %s read when the lease endpoint rejects", async variant => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(); h.bootstrap.prompt("read-error");
  if (variant === "terminal") h.run.status = "failed";
  if (variant === "run-owner") h.run.companyId = "foreign";
  if (variant === "issue-owner") h.issue.companyId = "foreign";
  const original = h.api.get.getMockImplementation()!;
  h.api.get.mockImplementation(async path => {
    if (path.endsWith("/leases") || (variant === "issue-owner" && path.endsWith("/run"))
      || (variant !== "issue-owner" && path.endsWith("/issue"))) throw new Error("PRIVATE API ERROR");
    return original(path);
  });
  await expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow(variant === "terminal" ? "stopped before observer setup" : "ownership is unproven");
  expect(Date.now()).toBe(0); expect(h.bind).not.toHaveBeenCalled();
  expect(h.input.evidence.mock.calls[0]![1]).toMatchObject({ admissionDeadlineReached: false });
  expect(JSON.stringify(h.input.evidence.mock.calls)).not.toContain("PRIVATE");
});

it.each(["/api/issues/issue", "/api/heartbeat-runs/run", "/api/environments/env/leases"])("never admits while %s cannot be read", async failedPath => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS + 1000); h.bootstrap.prompt("missing-read");
  const original = h.api.get.getMockImplementation()!;
  h.api.get.mockImplementation(async path => { if (path === failedPath) throw new Error("PRIVATE API ERROR"); return original(path); });
  const delivery = expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow("diagnostics withheld");
  await vi.advanceTimersByTimeAsync(1000); await delivery;
  expect(h.bind).not.toHaveBeenCalled(); expect(h.fixture.publishAction).not.toHaveBeenCalled();
  expect(JSON.stringify(h.input.evidence.mock.calls)).not.toContain("PRIVATE");
});

it("allows a transient lease read failure to recover without losing the setup reserve", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(); h.bootstrap.prompt("recover-read");
  const original = h.api.get.getMockImplementation()!; let failed = false;
  h.api.get.mockImplementation(async path => { if (path.endsWith("/leases") && !failed) { failed = true; throw new Error("unavailable"); } return original(path); });
  const delivery = h.bootstrap.bindAndRelease(h.request);
  await vi.advanceTimersByTimeAsync(100); await expect(delivery).resolves.toBe(h.fixture);
  expect(h.bind).toHaveBeenCalledTimes(1);
});

it("rejects a lease read completing inside the final setup reserve and saves startup evidence", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS + 1000); h.bootstrap.prompt("late");
  const original = h.api.get.getMockImplementation()!;
  h.api.get.mockImplementation(async path => {
    if (path.endsWith("/leases")) await new Promise(resolve => setTimeout(resolve, 1100));
    return original(path);
  });
  const delivery = expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow("Timed out waiting");
  await vi.advanceTimersByTimeAsync(1200); await delivery;
  expect(h.bind).not.toHaveBeenCalled(); expect(h.fixture.publishAction).not.toHaveBeenCalled();
  expect(h.input.evidence.mock.calls[0]![1]).toMatchObject({ phase: "lease_admission", leasesRead: "rejected", admissionDeadlineReached: true, deadlineReached: false });
  expect(h.input.evidence.mock.calls[0]![1]).not.toHaveProperty("activeOwnedLeaseCount");
});

it("captures binder failure after admission without publishing or repeating setup", async () => {
  const h = harness(); h.bootstrap.prompt("bind-failure");
  h.bind.mockRejectedValue(new Error("remote_native_fixture:insufficient_setup_budget"));
  await expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow("insufficient_setup_budget");
  expect(h.input.evidence.mock.calls[0]![1]).toMatchObject({ phase: "observer_setup", activeOwnedLeaseCount: 1 });
  expect(h.bind).toHaveBeenCalledTimes(1); expect(h.fixture.publishAction).not.toHaveBeenCalled();
});


it.each(["terminal", "run-owner", "issue-owner"])("rejects %s immediately with another failed read and a pending lease, and consumes its late rejection", async variant => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(); h.bootstrap.prompt("slow-lease");
  if (variant === "terminal") h.run.status = "failed";
  if (variant === "run-owner") h.run.companyId = "foreign";
  if (variant === "issue-owner") h.issue.companyId = "foreign";
  let rejectLease!: (error: Error) => void;
  const leaseRead = new Promise<never>((_resolve, reject) => { rejectLease = reject; });
  const original = h.api.get.getMockImplementation()!;
  h.api.get.mockImplementation(async path => {
    if (path.endsWith("/leases")) return leaseRead;
    if (path === (variant === "issue-owner" ? "/api/heartbeat-runs/run" : "/api/issues/issue")) throw new Error("503 PRIVATE");
    return original(path);
  });
  await expect(h.bootstrap.bindAndRelease(h.request)).rejects.toThrow(variant === "terminal" ? "stopped before observer setup" : "ownership is unproven");
  expect(Date.now()).toBe(0); expect(h.api.get).toHaveBeenCalledTimes(3);
  expect(h.api.get).toHaveBeenCalledWith("/api/environments/env/leases", { timeout: 18_000 });
  const saved = JSON.stringify(h.input.evidence.mock.calls);
  expect(saved).toContain('"leasesRead":"pending"'); expect(saved).not.toContain("PRIVATE");
  rejectLease(new Error("late private rejection"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(JSON.stringify(h.input.evidence.mock.calls)).toBe(saved);
  expect(h.api.get).toHaveBeenCalledTimes(3); expect(h.bind).not.toHaveBeenCalled();
});

it("retains persistent 503 classification without its raw cause", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS + 1000); h.bootstrap.prompt("503");
  const cause = new RunnerApiHttpError(503, "GET /api/environments/env/leases returned 503: PRIVATE BODY");
  const original = h.api.get.getMockImplementation()!;
  h.api.get.mockImplementation(async path => { if (path.endsWith("/leases")) throw cause; return original(path); });
  const delivery = h.bootstrap.bindAndRelease(h.request).catch(error => error);
  await vi.advanceTimersByTimeAsync(1000); const error = await delivery;
  expect(error).toBeInstanceOf(ObservedStateTimeout); expect(error.cause).toBeUndefined();
  expect(classifyFailure(error)).toBe("transient_infrastructure");
  expect(error.message).not.toContain("PRIVATE");
  expect(h.input.evidence.mock.calls[0]![1]).toMatchObject({ readFailureClass: "transient_infrastructure" });
  expect(JSON.stringify(h.input.evidence.mock.calls)).not.toContain("PRIVATE");
  expect(h.bind).not.toHaveBeenCalled();
});

it.each([true, false])("clears a recovered 503 cause before %s admission or observed-state timeout", async admits => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS + 1000); h.bootstrap.prompt("503-recovery");
  const original = h.api.get.getMockImplementation()!; let failed = false;
  h.api.get.mockImplementation(async path => {
    if (path.endsWith("/leases")) {
      if (!failed) { failed = true; throw new RunnerApiHttpError(503, "PRIVATE BODY"); }
      if (!admits) return [];
    }
    return original(path);
  });
  const delivery = h.bootstrap.bindAndRelease(h.request).catch(error => error);
  await vi.advanceTimersByTimeAsync(1000); const result = await delivery;
  if (admits) expect(result).toBe(h.fixture);
  else { expect(classifyFailure(result)).toBe("candidate_failure"); expect(result.cause).toBeUndefined(); }
});

it("bounds an unresponsive read at admission without launching replacement reads", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS + 1000); h.bootstrap.prompt("hung");
  const original = h.api.get.getMockImplementation()!;
  h.api.get.mockImplementation(async path => path.endsWith("/leases") ? new Promise<never>(() => {}) : original(path));
  const delivery = h.bootstrap.bindAndRelease(h.request).catch(error => error);
  await vi.advanceTimersByTimeAsync(1100); const error = await delivery;
  expect(classifyFailure(error)).toBe("transient_infrastructure");
  expect(h.api.get).toHaveBeenCalledTimes(3); expect(h.bind).not.toHaveBeenCalled();
});


it.each([
  ["Playwright TimeoutError", Object.assign(new Error("Timeout 1000ms exceeded. PRIVATE"), { name: "TimeoutError" }), "transient_infrastructure"],
  ["Playwright fetch timeout", new Error("apiRequestContext.get: Timeout 1000ms exceeded. PRIVATE"), "transient_infrastructure"],
  ["server fetch timeout", new Error("Timeout 1000ms exceeded PRIVATE"), "transient_infrastructure"],
  ["connection reset", new Error("apiRequestContext.get: read ECONNRESET PRIVATE"), "transient_infrastructure"],
  ["socket hang up", new Error("socket hang up"), "transient_infrastructure"],
  ["prefixed socket hang up", new Error("apiRequestContext.get: Socket Hang Up PRIVATE"), "transient_infrastructure"],
  ["undefined", undefined, "candidate_failure"],
  ["null", null, "candidate_failure"],
  ["private string", "PRIVATE 503 TimeoutError", "candidate_failure"],
  ["unknown object", { message: "PRIVATE", status: 503 }, "candidate_failure"],
])("normalizes %s rejection without exposing transport diagnostics", async (_label, rejected, failureClass) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS + 1000); h.bootstrap.prompt("safe-errors");
  const original = h.api.get.getMockImplementation()!;
  h.api.get.mockImplementation(async path => { if (path.endsWith("/leases")) throw rejected; return original(path); });
  const delivery = h.bootstrap.bindAndRelease(h.request).catch(error => error);
  await vi.advanceTimersByTimeAsync(1000); const error = await delivery;
  expect(classifyFailure(error)).toBe(failureClass);
  expect(error.cause).toBeUndefined();
  expect(error.message.length).toBeLessThan(1024);
  expect(error.stack).not.toContain("PRIVATE");
  expect(JSON.stringify(error)).not.toContain("PRIVATE");
  expect(JSON.stringify(h.input.evidence.mock.calls)).not.toContain("PRIVATE");
  expect(h.input.evidence.mock.calls[0]![1]).toMatchObject({ leasesRead: "rejected", readFailureClass: failureClass });
  expect(h.bind).not.toHaveBeenCalled();
});

it.each([[503, "transient_infrastructure"], [403, "permanent_infrastructure"], [400, "candidate_failure"]])(
  "normalizes actual RunnerApi HTTP %s status independently of its private body", async (status, failureClass) => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "3100");
    const h = harness(REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS + 1000); h.bootstrap.prompt("actual-api");
    const original = h.api.get.getMockImplementation()!;
    const secret = "PRIVATE body: forbidden secret plaintext 503 timeout socket hang up ".repeat(10_000);
    const request = { get: vi.fn(async (path: string) => ({
      ok: () => !path.endsWith("/leases"), status: () => status,
      url: () => "http://PRIVATE.invalid/private", text: async () => secret,
      json: async () => original(path),
    } as APIResponse)) };
    const actual = new RunnerApi(request as unknown as APIRequestContext);
    h.api.get.mockImplementation(path => actual.get(path, { timeout: 1000 }));
    const delivery = h.bootstrap.bindAndRelease(h.request).catch(error => error);
    await vi.advanceTimersByTimeAsync(1000); const error = await delivery;
    expect(classifyFailure(error)).toBe(failureClass);
    expect(error.cause).toBeUndefined();
    expect(error.message.length).toBeLessThan(1024);
    expect(error.stack).not.toContain("PRIVATE");
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
    expect(JSON.stringify(h.input.evidence.mock.calls)).not.toContain("PRIVATE");
    if (status === 403) expect(error).toBeInstanceOf(RemoteAdmissionReadError);
    expect(h.bind).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  },
);

it.each([
  ["issue", null], ["run", []], ["leases", {}], ["leases", [null]],
  ["leases", ["PRIVATE"]], ["leases", [[{}]]], ["leases", undefined],
])("rejects malformed successful %s JSON without an unhandled continuation", async (endpoint, value) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS + 1000); h.bootstrap.prompt("malformed");
  const original = h.api.get.getMockImplementation()!;
  const path = endpoint === "issue" ? "/api/issues/issue" : endpoint === "run" ? "/api/heartbeat-runs/run" : "/api/environments/env/leases";
  h.api.get.mockImplementation(async requested => requested === path ? value as never : original(requested));
  const delivery = h.bootstrap.bindAndRelease(h.request).catch(error => error);
  await vi.advanceTimersByTimeAsync(1000); const error = await delivery;
  expect(error).toBeInstanceOf(RemoteAdmissionReadError);
  expect(classifyFailure(error)).toBe("candidate_failure");
  expect(error.cause).toBeUndefined(); expect(error.stack).not.toContain("PRIVATE");
  expect(h.bind).not.toHaveBeenCalled();
});
