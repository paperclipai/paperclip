import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configuredControllerOutage, controllerOutageForExecution, parseControllerOutage, replaceController, retireControllerCache, validControllerOutageReceipt } from "./controller-outage.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

function fixture() {
  const order: string[] = [];
  const receipts: unknown[] = [];
  return { order, receipts, input: {
    requestId: "calibration", previousPid: 100, outage: { signal: "SIGKILL" as const, holdMs: 20 },
    stop: async (signal: string) => { order.push(signal); },
    waitForUnhealthy: async () => { order.push("http-down"); },
    discardCache: async () => { order.push("empty-cache"); },
    start: vi.fn(async () => { order.push("start"); return { pid: 200 }; }),
    waitForReady: async () => { order.push("ready"); }, cancelled: () => false,
    record: async (receipt: unknown) => { receipts.push(receipt); },
  } };
}

describe("controller outage qualification", () => {
  it("keeps original-execution fault evidence enabled for both dedicated continuity cells", async () => {
    const executions = selectRunnerExecutions(parseRunnerSelectors(["--suite", "daytona-restart-continuity"]));
    expect(executions).toHaveLength(2);
    for (const execution of executions) {
      const outage = controllerOutageForExecution(execution, {});
      expect(outage).toEqual({ signal: "SIGKILL", holdMs: 125_000 });
      expect(controllerOutageForExecution(execution, { PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS: "300000" }))
        .toEqual({ signal: "SIGKILL", holdMs: 300_000 });
      expect(() => controllerOutageForExecution(execution, { PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS: "1000" }))
        .toThrow("shorter than the dedicated continuity contract");
    }
  });

  it("uses the everyday suite's declared default while retaining explicit short profiles", () => {
    const [execution] = selectRunnerExecutions(parseRunnerSelectors([
      "--id", "everyday-workflows.runner-codex.daytona.recover-controller",
    ]));
    expect(controllerOutageForExecution(execution!, {})).toEqual({ signal: "SIGKILL", holdMs: 125_000 });
    expect(controllerOutageForExecution(execution!, { PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS: "1000" }))
      .toEqual({ signal: "SIGKILL", holdMs: 1_000 });
  });

  it.each(["runner-codex", "runner-acpx-claude"])("supplies replacement fault evidence to the %s Daytona restart cell", async profile => {
    const [execution] = selectRunnerExecutions(parseRunnerSelectors([
      "--id", `everyday-workflows.${profile}.daytona.recover-controller`,
    ]));
    expect(execution).toBeDefined();
    const f = fixture();
    const outage = controllerOutageForExecution(execution!, { PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS: "20" });
    const receipt = outage ? await replaceController({ ...f.input, outage }) : undefined;
    expect(validControllerOutageReceipt(receipt, { signal: "SIGKILL", holdMs: 20 })).toBe(true);
    expect(receipt).toMatchObject({ previousPid: 100, replacementPid: 200, cacheDiscarded: true });
    expect(f.order).toEqual(["SIGKILL", "http-down", "empty-cache", "start", "ready"]);
    for (const other of [
      { ...execution!, environment: { ...execution!.environment, id: "local" as const } },
      { ...execution!, profile: { ...execution!.profile, generation: "legacy" as const } },
      { ...execution!, task: { ...execution!.task, id: "stop-redirect" } },
    ]) expect(controllerOutageForExecution(other, {})).toBeUndefined();
  });
  it("records an actual bounded outage before starting the successor", async () => {
    const f = fixture();
    const receipt = await replaceController(f.input);
    expect(f.order).toEqual(["SIGKILL", "http-down", "empty-cache", "start", "ready"]);
    expect(receipt.replacementStartedAfterMs! - receipt.stoppedAfterMs!).toBeGreaterThanOrEqual(20);
    expect(validControllerOutageReceipt(receipt, f.input.outage)).toBe(true);
    expect(validControllerOutageReceipt(receipt, { signal: "SIGTERM", holdMs: 20 })).toBe(false);
    expect(validControllerOutageReceipt(receipt, { signal: "SIGKILL", holdMs: 300_000 })).toBe(false);
    expect(validControllerOutageReceipt(receipt, f.input.outage, "another-attempt")).toBe(false);
    expect(f.receipts[0]).not.toHaveProperty("readyAfterMs");
    expect(f.receipts.at(-1)).toEqual(receipt);
  });

  it.each(["stop", "waitForUnhealthy", "discardCache", "start", "waitForReady"] as const)("retains incomplete evidence when %s fails", async stage => {
    const f = fixture();
    f.input[stage] = vi.fn(async () => { throw new Error(stage); });
    await expect(replaceController(f.input)).rejects.toThrow(stage);
    expect(f.receipts.length).toBeGreaterThan(0);
    expect(f.receipts.every(receipt => !validControllerOutageReceipt(receipt))).toBe(true);
  });

  it("cancels during the offline interval without launching another server", async () => {
    const f = fixture();
    f.input.cancelled = () => f.order.includes("empty-cache");
    await expect(replaceController(f.input)).rejects.toThrow("shutdown interrupted");
    expect(f.input.start).not.toHaveBeenCalled();
  });

  it.each([-1, 300001, 0.5, NaN, Infinity, "300000", null])("rejects invalid duration %s before signaling", holdMs => {
    expect(() => parseControllerOutage({ signal: "SIGKILL", holdMs })).toThrow();
  });
  it.each(["", "-1", "1e3", "NaN", " 1000", "300001"])("rejects invalid environment duration %s", value => {
    expect(() => configuredControllerOutage({ PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS: value })).toThrow();
  });
  it("accepts the five-minute contract without extending the runner grace", () => {
    expect(configuredControllerOutage({ PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS: "300000" }))
      .toEqual({ signal: "SIGKILL", holdMs: 300000 });
    expect(validControllerOutageReceipt({ schema: "paperclip.e2e.controller-outage/v1", requestId: "late",
      signal: "SIGKILL", holdMs: 300000, previousPid: 1, replacementPid: 2, startedAt: new Date().toISOString(),
      stoppedAfterMs: 0, cacheDiscarded: true, replacementStartedAfterMs: 300000, readyAfterMs: 420000 })).toBe(false);
  });
});

it.each(["absent", "present"])("retires a %s old controller cache", async state => {
  const root = await mkdtemp(join(tmpdir(), "controller-cache-"));
  const cache = join(root, "cache"), retired = join(root, "retired");
  try {
    if (state === "present") { await mkdir(cache); await writeFile(join(cache, "evidence"), "saved"); }
    await retireControllerCache(cache, retired);
    await expect(lstat(cache)).rejects.toMatchObject({ code: "ENOENT" });
    if (state === "present") expect(await readFile(join(retired, "evidence"), "utf8")).toBe("saved");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("does not mistake a missing retirement parent for an already absent cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "controller-cache-")), cache = join(root, "cache");
  try {
    await mkdir(cache); await writeFile(join(cache, "evidence"), "saved");
    await expect(retireControllerCache(cache, join(root, "missing", "retired"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(cache, "evidence"), "utf8")).toBe("saved");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.each(["missing", "previous-revision", "previous-tree", "replacement-revision", "replacement-tree", "reversed"])(
  "requires the requested upgrade artifact pair when evidence is %s", problem => {
    const A = { revision: "a".repeat(40), treeSha256: "a".repeat(64), version: "1", evidence: "development-build" as const };
    const B = { ...A, revision: "b".repeat(40), treeSha256: "b".repeat(64) };
    const receipt = { schema: "paperclip.e2e.controller-outage/v1", requestId: "upgrade", previousPid: 1, replacementPid: 2,
      startedAt: new Date().toISOString(), signal: "SIGKILL", holdMs: 0, stoppedAfterMs: 0,
      replacementStartedAfterMs: 1, readyAfterMs: 2, cacheDiscarded: true,
      previousArtifact: { ...A }, replacementArtifact: { ...B } };
    expect(validControllerOutageReceipt(receipt, undefined, "upgrade", { previous: A, replacement: B })).toBe(true);
    expect(validControllerOutageReceipt({ ...receipt, previousArtifact: B, replacementArtifact: A }, undefined,
      "upgrade", { previous: B, replacement: A })).toBe(true);
    if (problem === "missing") Object.assign(receipt, { previousArtifact: undefined, replacementArtifact: undefined });
    if (problem === "previous-revision") receipt.previousArtifact.revision = "c".repeat(40);
    if (problem === "previous-tree") receipt.previousArtifact.treeSha256 = "c".repeat(64);
    if (problem === "replacement-revision") receipt.replacementArtifact.revision = "c".repeat(40);
    if (problem === "replacement-tree") receipt.replacementArtifact.treeSha256 = "c".repeat(64);
    if (problem === "reversed") Object.assign(receipt, { previousArtifact: B, replacementArtifact: A });
    expect(validControllerOutageReceipt(receipt, undefined, "upgrade", { previous: A, replacement: B })).toBe(false);
  });
