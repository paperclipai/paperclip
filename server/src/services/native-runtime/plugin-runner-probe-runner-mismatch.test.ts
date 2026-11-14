import { describe, expect, it } from "vitest";
import { environmentTaskErrorCodeData, JsonRpcCallError, PluginEnvironmentTaskError } from "@paperclipai/plugin-sdk";
import { probePluginRunnerEnvironment } from "./plugin-runner-probe.js";
import { assertHarnessTestPassed } from "../agent-harness-verification.js";

const probe = (runnerTask: () => Promise<unknown>) => probePluginRunnerEnvironment({
  companyId: "fixture-company", adapterType: "paperclip_runner", config: { provider: "codex", model: "fixture-model" },
  executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: ".", leaseId: "probe-lease",
    runnerTaskProbe: { runId: "probe-run", sessionId: "probe-session" }, runnerTask },
} as Parameters<typeof probePluginRunnerEnvironment>[0]);

describe("plugin Runner probe with an outdated remote Runner", () => {
  it("reports a retryable Runner mismatch from the plugin's stable code", async () => {
    const refusal = new JsonRpcCallError({ code: -32002, message: "The installed Runner does not match the expected revision",
      data: environmentTaskErrorCodeData(new PluginEnvironmentTaskError("runner_revision_mismatch")) });
    const result = await probe(async () => { throw refusal; });
    expect(result).toMatchObject({ status: "fail", checks: [{ code: "runner_revision_mismatch", level: "error", retryable: true }] });
    expect(() => assertHarnessTestPassed(result)).toThrow(expect.objectContaining({ code: "runner_revision_mismatch" }));
  });

  it("keeps other plugin failures a non-retryable failed probe, even with the same message", async () => {
    const result = await probe(async () => { throw new Error("The installed Runner does not match the expected revision"); });
    expect(result).toMatchObject({ status: "fail", checks: [{ code: "runner_hello_probe_failed", level: "error" }] });
    expect(result.checks[0]).not.toHaveProperty("retryable");
  });
});
