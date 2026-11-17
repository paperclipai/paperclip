/**
 * TECH-8174: the sandbox module is reached only for remote targets. A local target (explicit or
 * absent) keeps the host path and never calls it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const sandbox = vi.hoisted(() => ({ executeHermesOnRemoteTarget: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false })) }));
vi.mock("./execute-sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./execute-sandbox.js")>()),
  executeHermesOnRemoteTarget: sandbox.executeHermesOnRemoteTarget,
}));

const child = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "ok\n\nsession_id: s1", stderr: "" })),
}));
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>()),
  runChildProcess: child.runChildProcess,
}));

import { execute } from "./execute.js";

function ctx(executionTarget: unknown): AdapterExecutionContext {
  return {
    runId: "run-local",
    agent: { id: "a", companyId: "c", name: "Local Hermes", adapterType: "hermes_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { provider: "openai-api", model: "gpt-5.4", cwd: process.cwd() },
    context: {},
    ...(executionTarget === undefined ? {} : { executionTarget }),
    onLog: async () => {},
  } as unknown as AdapterExecutionContext;
}

afterEach(() => vi.clearAllMocks());

describe("execute target routing (TECH-8174)", () => {
  it.each([
    ["no execution target", undefined],
    ["an explicit local target", { kind: "local" }],
  ])("keeps the host path for %s and never calls the sandbox module", async (_label, target) => {
    await execute(ctx(target));
    expect(sandbox.executeHermesOnRemoteTarget).not.toHaveBeenCalled();
    expect(child.runChildProcess).toHaveBeenCalledTimes(1);
  });

  it("routes a sandbox target to the sandbox module and spawns nothing on the host", async () => {
    await execute(ctx({ kind: "remote", transport: "sandbox", remoteCwd: "/workspace" }));
    expect(sandbox.executeHermesOnRemoteTarget).toHaveBeenCalledTimes(1);
    expect(child.runChildProcess).not.toHaveBeenCalled();
  });
});
