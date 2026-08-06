import { describe, expect, it } from "vitest";

import { resolveAdapterTestEnvironmentId } from "./adapter-test-environment";

describe("resolveAdapterTestEnvironmentId", () => {
  it("prefers the agent's own environment", () => {
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: "agent-env",
        instanceDefaultEnvironmentId: "instance-env",
      }),
    ).toBe("agent-env");
  });

  it("falls back to the instance default when the agent has none", () => {
    // The regression this pins: an agent relying on the instance default
    // (e.g. a managed sandbox with extra CLIs baked into its image) must be
    // tested inside that environment, not on the Paperclip host where the
    // CLI does not exist.
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: "instance-env",
      }),
    ).toBe("instance-env");
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: "",
        instanceDefaultEnvironmentId: "instance-env",
      }),
    ).toBe("instance-env");
  });

  it("returns null (host probe) when neither is set", () => {
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: undefined,
        instanceDefaultEnvironmentId: undefined,
      }),
    ).toBeNull();
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: "",
        instanceDefaultEnvironmentId: null,
      }),
    ).toBeNull();
  });
});
