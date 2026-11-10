import { describe, expect, it } from "vitest";
import type { AdapterExecutionResult } from "../adapters/types.js";
import { classifyCodexTerminalSessionFailure } from "@paperclipai/adapter-codex-local/server";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";
import { readTransientRecoveryContractFromRun } from "../services/heartbeat/retries.js";
import { controlledOrdinaryBootstrapFailure, controlledOrdinaryBootstrapProtocol, controlledOrdinaryBootstrapResult,
  controlledOrdinaryBootstrapScript } from "./helpers/recovery-deadline-ordinary-bootstrap.js";
const config = { command: process.execPath, args: ["-e", controlledOrdinaryBootstrapScript] };
const raw: AdapterExecutionResult = { exitCode: 75, signal: null, timedOut: false, errorMessage: "Process exited with code 75",
  resultJson: { stdout: "", stderr: controlledOrdinaryBootstrapProtocol + "\n" } };
const persisted = (result: AdapterExecutionResult) => ({ runtimeMode: "legacy" as const, status: "failed" as const,
  errorCode: result.errorCode ?? "adapter_failed", resultJson: { ...result.resultJson,
    ...(result.errorFamily ? { errorFamily: result.errorFamily } : {}),
    ...(result.executionRecovery ? { executionRecovery: result.executionRecovery } : {}) } });
describe("controlled ordinary retry bootstrap contract", () => {
  it("uses the production typed service classifier and replay-safe no-action contract", () => {
    const result = controlledOrdinaryBootstrapResult(config, raw);
    const classified = classifyCodexTerminalSessionFailure(controlledOrdinaryBootstrapFailure, new Date());
    expect(classified).not.toBeNull();
    if (!classified) throw new Error("Controlled service-capacity failure must have a production retry classification");
    expect(result).toMatchObject(classified);
    expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
    expect(readTransientRecoveryContractFromRun(persisted(result))).toEqual({ errorFamily: "transient_upstream", retryNotBefore: null });
    expect(legacyExecutionNeedsReconciliation(persisted(result))).toBe(false);
    expect(result.resultJson).toBe(raw.resultJson);
  });
  it("rejects another executable, modified program and additional arguments", () => {
    for (const candidate of [{ ...config, command: "/unowned/node" }, { ...config, args: ["-e", controlledOrdinaryBootstrapScript + ";doWork()"] },
      { ...config, args: [...config.args, "extra"] }]) expect(controlledOrdinaryBootstrapResult(candidate, raw)).toBe(raw);
  });
  it("leaves unknown outputs, malformed protocol, timeouts, signals and other exits unreconciled", () => {
    for (const patch of [{ timedOut: true }, { signal: "SIGTERM" }, { exitCode: 1 },
      { resultJson: { stdout: "domain action", stderr: controlledOrdinaryBootstrapProtocol + "\n" } },
      { resultJson: { stdout: "", stderr: "{malformed}" } },
      { resultJson: { stdout: "", stderr: JSON.stringify({ category: "service", title: "Unknown outcome" }) + "\n" } }]) {
      const result = { ...raw, ...patch } as AdapterExecutionResult;
      expect(controlledOrdinaryBootstrapResult(config, result)).toBe(result);
      expect(readTransientRecoveryContractFromRun(persisted(result))).toBeNull();
      expect(legacyExecutionNeedsReconciliation(persisted(result))).toBe(true);
    }
  });
});
