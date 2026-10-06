import { describe, expect, it } from "vitest";
import { resolveExternalRunId } from "../services/heartbeat.js";

describe("resolveExternalRunId", () => {
  it("keeps the identity the adapter reported for the remote run", () => {
    expect(resolveExternalRunId({ externalRunId: "run-hermes-1" })).toBe("run-hermes-1");
  });

  it("trims surrounding whitespace instead of storing it", () => {
    expect(resolveExternalRunId({ externalRunId: "  run-hermes-1  " })).toBe("run-hermes-1");
  });

  it("treats a missing, empty or blank identity as no identity", () => {
    expect(resolveExternalRunId({})).toBeNull();
    expect(resolveExternalRunId({ externalRunId: null })).toBeNull();
    expect(resolveExternalRunId({ externalRunId: "" })).toBeNull();
    expect(resolveExternalRunId({ externalRunId: "   " })).toBeNull();
  });

  it("never turns a non-string value into an identity", () => {
    expect(
      resolveExternalRunId({ externalRunId: 42 as unknown as string }),
    ).toBeNull();
  });
});
