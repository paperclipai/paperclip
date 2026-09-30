import { expect, it, vi } from "vitest";
import { createRemoteNativeBootstrap } from "./remote-native-bootstrap.js";
import type { RemoteFixtureApi, RemoteNativeFixture } from "./remote-native-fixtures.js";

function harness() {
  const order: string[] = [];
  const issue = { id: "issue", companyId: "company", assigneeAgentId: "agent" };
  const run = { id: "run", companyId: "company", agentId: "agent", status: "running" };
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
    deadlineAt: Date.now() + 5000, evidence: vi.fn(async () => { order.push("evidence"); }),
  };
  const bootstrap = createRemoteNativeBootstrap(input, bind);
  const request = { issueId: "issue", runId: "run", targets: ["target.txt"], actionPrompt: async (actual: RemoteNativeFixture) => {
    expect(actual).toBe(fixture); await Promise.resolve(); order.push("baseline"); return "PRIVATE ACTUAL ACTION";
  } };
  return { bootstrap, input, bind, api, issue, run, leases, fixture, request, order };
}

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
