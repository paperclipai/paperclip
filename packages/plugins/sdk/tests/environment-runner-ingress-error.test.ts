import { describe, expect, it } from "vitest";
import { environmentRunnerIngressErrorData, PluginEnvironmentRunnerIngressError, readEnvironmentRunnerIngressFailure } from "../src/environment-runner-ingress-error.js";

describe("runner ingress failure contract", () => {
  const failure = { phase: "private_preview", httpStatus: 502 } as const;
  it("serializes only producer-owned closed data", () => {
    const extended = { ...failure, token: "private-token", url: "private-url" };
    const error = new PluginEnvironmentRunnerIngressError(extended);
    const data = environmentRunnerIngressErrorData(error);
    expect(readEnvironmentRunnerIngressFailure({ data })).toEqual(failure);
    expect(JSON.stringify(data)).not.toContain("private-");
    expect(JSON.stringify(error)).not.toContain("private-");
    expect(error.message).toBe("Runner connection endpoint could not be acquired (HTTP 502).");
    expect(error.cause).toBeUndefined();
    expect(environmentRunnerIngressErrorData(Object.assign(new Error("forged"), { failure, data }))).toBeUndefined();
  });
  it.each([{}, null, { ...failure, phase: "unknown" }, { ...failure, httpStatus: "502" },
    { ...failure, httpStatus: 200 }, { ...failure, httpStatus: 600 }, { ...failure, httpStatus: 502.5 }])("rejects unsupported evidence %j", value => {
    expect(readEnvironmentRunnerIngressFailure({ data: { schema: "paperclip/environment-runner-ingress-error/v1", failure: value } })).toBeNull();
  });
  it("does not invoke inherited or accessor fields", () => {
    let reads = 0;
    const getter = Object.defineProperty({}, "data", { get() { reads++; throw new Error("private"); } });
    expect(readEnvironmentRunnerIngressFailure(getter)).toBeNull();
    expect(readEnvironmentRunnerIngressFailure(Object.create({ data: environmentRunnerIngressErrorData(
      new PluginEnvironmentRunnerIngressError(failure)) }))).toBeNull();
    expect(reads).toBe(0);
  });
});
