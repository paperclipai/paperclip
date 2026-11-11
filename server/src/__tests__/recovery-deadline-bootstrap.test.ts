import { describe, expect, it } from "vitest";
import type { AdapterExecutionResult } from "../adapters/types.js";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";
import { controlledCompanyBootstrapMessage, controlledCompanyBootstrapResult, controlledCompanyBootstrapScript } from "./helpers/recovery-deadline-bootstrap.js";
const config = { command: process.execPath, args: ["-e", controlledCompanyBootstrapScript] };
const raw: AdapterExecutionResult = { exitCode: 75, signal: null, timedOut: false, errorMessage: "Process exited with code 75",
  resultJson: { stdout: "", stderr: controlledCompanyBootstrapMessage + "\n" } };
const needsReconciliation = (result: AdapterExecutionResult) => legacyExecutionNeedsReconciliation({ runtimeMode: "legacy",
  status: "failed", errorCode: "adapter_failed", resultJson: { ...result.resultJson,
    ...(result.executionRecovery ? { executionRecovery: result.executionRecovery } : {}) } });
describe("controlled company bootstrap fixture contract", () => {
  it("distinguishes stopped-process evidence from replay-safe pre-task failure", () => {
    expect(needsReconciliation(raw)).toBe(true);
    const result = controlledCompanyBootstrapResult(config, raw);
    expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
    expect(needsReconciliation(result)).toBe(false);
    expect(result.resultJson).toBe(raw.resultJson);
    expect(result.exitCode).toBe(75);
  });
  it("does not classify another command, appended action, extra argument, or unknown program", () => {
    for (const candidate of [{ ...config, command: "/unowned/node" }, { ...config, args: ["-e", controlledCompanyBootstrapScript + ";doWork()"] },
      { ...config, args: [...config.args, "extra"] }, { ...config, args: ["-e", "unknownWork()"] }]) {
      expect(controlledCompanyBootstrapResult(candidate, raw)).toBe(raw);
      expect(needsReconciliation(controlledCompanyBootstrapResult(candidate, raw))).toBe(true);
    }
  });
  it("preserves unknown output, timeout and signal failures without replay evidence", () => {
    for (const patch of [{ timedOut: true }, { signal: "SIGTERM" }, { exitCode: 1 },
      { resultJson: { stdout: "task action happened", stderr: controlledCompanyBootstrapMessage + "\n" } },
      { resultJson: { stdout: "", stderr: "Unknown provider action outcome\n" } }]) {
      const result = { ...raw, ...patch } as AdapterExecutionResult;
      expect(controlledCompanyBootstrapResult(config, result)).toBe(result);
      expect(needsReconciliation(controlledCompanyBootstrapResult(config, result))).toBe(true);
    }
  });
});
