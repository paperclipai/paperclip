import { describe, expect, it } from "vitest";
import { environmentStopErrorData, PluginEnvironmentStopError, readEnvironmentStopFailure } from "../src/environment-stop-error.js";

describe("environment stop failure contract", () => {
  it.each([
    ["resource_unrecoverable", true],
    ["recovery_failed", true],
    ["recovery_incomplete", false],
  ] as const)("serializes %s with its fixed terminal class", (reason, terminal) => {
    const error = new PluginEnvironmentStopError(reason);
    const data = environmentStopErrorData(error);
    expect(data).toEqual({ schema: "paperclip/environment-stop-error/v1", failure: { reason } });
    expect(readEnvironmentStopFailure({ data })).toEqual({ reason, terminal });
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain(reason);
  });
  it("forwards only the SDK error class", () => {
    const forged = Object.assign(new Error("private-detail"), { failure: { reason: "recovery_failed", terminal: true } });
    expect(environmentStopErrorData(forged)).toBeUndefined();
    expect(environmentStopErrorData(new Error("private-detail"))).toBeUndefined();
  });
  it.each([{}, null, { reason: "unknown" }, { reason: 1 }, { reason: "recovery_incomplete ", terminal: true }])("rejects unsupported evidence %j", value => {
    expect(readEnvironmentStopFailure({ data: { schema: "paperclip/environment-stop-error/v1", failure: value } })).toBeNull();
  });
  it("derives the terminal class from the reason instead of trusting the sender", () => {
    expect(readEnvironmentStopFailure({ data: { schema: "paperclip/environment-stop-error/v1",
      failure: { reason: "recovery_incomplete", terminal: true } } })).toEqual({ reason: "recovery_incomplete", terminal: false });
    expect(readEnvironmentStopFailure({ data: { schema: "paperclip/environment-runner-ingress-error/v1",
      failure: { reason: "recovery_failed" } } })).toBeNull();
  });
  it("does not invoke inherited or accessor fields", () => {
    let reads = 0;
    const getter = Object.defineProperty({}, "data", { get() { reads++; throw new Error("private"); } });
    expect(readEnvironmentStopFailure(getter)).toBeNull();
    expect(readEnvironmentStopFailure(Object.create({ data: environmentStopErrorData(
      new PluginEnvironmentStopError("recovery_failed")) }))).toBeNull();
    expect(reads).toBe(0);
  });
});
