import { describe, expect, it, vi, afterEach } from "vitest";
import * as serverUtils from "./server-utils.js";
import { runAdapterExecutionTargetProcess } from "./execution-target.js";
import { createProviderStoppedBoundary } from "./provider-stopped-boundary.js";

const result = { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 12, startedAt: "now" };
const options = (onProcessStopped: () => void) => ({ cwd: "/tmp", env: {}, timeoutSec: 1, graceSec: 1, onLog: async () => {}, onProcessStopped });
const target = (execute: () => Promise<any>) => ({ kind: "remote", transport: "sandbox", remoteCwd: "/workspace", runner: { execute } }) as any;
afterEach(() => vi.restoreAllMocks());
describe("owned provider process stop boundary", () => {
  it.each([0, 1])("notifies after a remote invocation returns an observed exit code %s", async exitCode => {
    const stopped = vi.fn();
    await runAdapterExecutionTargetProcess("run", target(async () => ({ ...result, exitCode })), "provider", [], options(stopped));
    expect(stopped).toHaveBeenCalledOnce();
  });
  it("notifies after the local child closed on timeout", async () => {
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({ ...result, exitCode: null, signal: "SIGTERM", timedOut: true });
    const stopped = vi.fn();
    await runAdapterExecutionTargetProcess("run", null, "provider", [], options(stopped));
    expect(stopped).toHaveBeenCalledOnce();
  });
  it.each([
    { ...result, exitCode: null, timedOut: true },
    { ...result, exitCode: null, timedOut: false },
  ])("does not treat an incomplete remote execution as a stop receipt", async incomplete => {
    const stopped = vi.fn();
    await runAdapterExecutionTargetProcess("run", target(async () => incomplete), "provider", [], options(stopped));
    expect(stopped).not.toHaveBeenCalled();
  });
  it("does not infer remote termination from a transport rejection", async () => {
    const stopped = vi.fn();
    await expect(runAdapterExecutionTargetProcess("run", target(async () => { throw new Error("transport lost"); }), "provider", [], options(stopped))).rejects.toThrow("transport lost");
    expect(stopped).not.toHaveBeenCalled();
  });
});

describe("final invocation instruction collection fence", () => {
  it("collects once, after the last completed attempt, before restore", async () => {
    const order: string[] = [];
    const fence = createProviderStoppedBoundary(async () => { order.push("collect"); });
    fence.beginInvocation()();
    expect(order).toEqual([]);
    fence.beginInvocation()();
    await fence.collectBeforeRestore();
    order.push("restore");
    await fence.collectBeforeRestore();
    expect(order).toEqual(["collect", "restore"]);
  });
  it("an uncertain later attempt invalidates an earlier stop, including late callbacks", async () => {
    const collect = vi.fn(async () => {});
    const fence = createProviderStoppedBoundary(collect);
    const old = fence.beginInvocation(); old();
    fence.beginInvocation(); old();
    await fence.collectBeforeRestore();
    expect(collect).not.toHaveBeenCalled();
  });
  it("does not collect before any provider invocation", async () => {
    const collect = vi.fn(async () => {});
    await createProviderStoppedBoundary(collect).collectBeforeRestore();
    expect(collect).not.toHaveBeenCalled();
  });
  it("does not infer SSH provider termination from transport exit 255", async () => {
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({ ...result, exitCode: 255 });
    const stopped = vi.fn();
    await runAdapterExecutionTargetProcess("run", { kind: "remote", transport: "ssh", spec: { host: "fixture" }, remoteCwd: "/workspace" } as any, "provider", [], options(stopped));
    expect(stopped).not.toHaveBeenCalled();
  });
  it("retains the stop observation when a subsequent log-tail flush throws", async () => {
    const stopped = vi.fn();
    await expect(runAdapterExecutionTargetProcess("run", target(async () => result), "provider", [], {
      ...options(stopped), runLogTail: { create: () => ({ wrapCommand: (command: string, args: string[]) => ({ command, args }), start: () => {}, finish: async () => { throw new Error("log flush failed"); }, abort: async () => {} }) } as any,
    })).rejects.toThrow("log flush failed");
    expect(stopped).toHaveBeenCalledOnce();
  });
});
