import { describe, expect, it } from "vitest";
import type { Environment } from "@paperclipai/shared";

import {
  resolveAdapterTestEnvironmentId,
  resolveLocalDefaultEnvironmentId,
} from "./adapter-test-environment";

function makeEnvironment(overrides: Partial<Environment>): Environment {
  return {
    id: "env-id",
    name: "Env",
    description: null,
    driver: "sandbox",
    status: "active",
    config: {},
    envVars: {},
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("resolveAdapterTestEnvironmentId", () => {
  it("prefers the agent's own environment", () => {
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: "agent-env",
        instanceDefaultEnvironmentId: "instance-env",
        localDefaultEnvironmentId: "local-env",
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
        localDefaultEnvironmentId: "local-env",
      }),
    ).toBe("instance-env");
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: "",
        instanceDefaultEnvironmentId: "instance-env",
        localDefaultEnvironmentId: "local-env",
      }),
    ).toBe("instance-env");
  });

  it("falls back to the local default when neither an agent nor an instance default is set", () => {
    // The server resolves a run with no agent or instance default to the local
    // default environment. The Test must probe the same environment, not the
    // host, so a Test result matches a real run.
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
      }),
    ).toBe("local-env");
  });

  it("returns null (host probe) when no tier is set", () => {
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: undefined,
        instanceDefaultEnvironmentId: undefined,
        localDefaultEnvironmentId: undefined,
      }),
    ).toBeNull();
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: "",
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: null,
      }),
    ).toBeNull();
  });
});

describe("resolveLocalDefaultEnvironmentId", () => {
  it("finds the local-driver instance-default environment", () => {
    const environments = [
      makeEnvironment({ id: "sandbox-1", driver: "sandbox" }),
      makeEnvironment({
        id: "local-1",
        driver: "local",
        metadata: { managedByPaperclip: true, defaultForInstance: true },
      }),
    ];
    expect(resolveLocalDefaultEnvironmentId(environments)).toBe("local-1");
  });

  it("ignores a local environment that is not the instance default", () => {
    const environments = [
      makeEnvironment({ id: "local-1", driver: "local", metadata: { defaultForInstance: false } }),
      makeEnvironment({ id: "local-2", driver: "local", metadata: null }),
    ];
    expect(resolveLocalDefaultEnvironmentId(environments)).toBeNull();
  });

  it("returns null for an empty or missing list", () => {
    expect(resolveLocalDefaultEnvironmentId([])).toBeNull();
    expect(resolveLocalDefaultEnvironmentId(null)).toBeNull();
    expect(resolveLocalDefaultEnvironmentId(undefined)).toBeNull();
  });
});
