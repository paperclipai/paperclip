import { describe, expect, it } from "vitest";
import type { Environment } from "@paperclipai/shared";

import {
  ManagedSandboxUnavailableForTestError,
  resolveAdapterTestEnvironmentId,
  resolveLocalDefaultEnvironmentId,
  resolveManagedSandboxEnvironmentId,
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

  it("redirects a local-default resolution to the managed sandbox under managed-sandbox-only", () => {
    // The real run redirects a local resolution to the managed sandbox, so the
    // Test must probe the managed sandbox, not the local default.
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
      }),
    ).toBe("managed-env");
  });

  it("redirects a no-tier resolution to the managed sandbox under managed-sandbox-only", () => {
    // The policy hides the local tier, so the list holds no local row and the
    // resolution lands on no tier. The real run still resolves to local and
    // redirects to the managed sandbox, so the Test does the same.
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: null,
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
      }),
    ).toBe("managed-env");
  });

  it("fails closed when managed-sandbox-only is on but no managed sandbox exists", () => {
    // The real run fails closed, so the Test must not fall back to a local host
    // probe that reports a result for a target the run never uses.
    expect(() =>
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: null,
      }),
    ).toThrow(ManagedSandboxUnavailableForTestError);
  });

  it("leaves a non-local default untouched under managed-sandbox-only", () => {
    // The policy hides local; it does not forbid an ssh or a user sandbox that
    // an agent or instance default names, so the Test probes that environment.
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: "ssh-env",
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
      }),
    ).toBe("ssh-env");
  });

  it("ignores the managed-sandbox redirect when the policy is off", () => {
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: false,
        managedSandboxEnvironmentId: "managed-env",
      }),
    ).toBe("local-env");
  });

  it("redirects an agent default that names the hidden local row to the managed sandbox", () => {
    // The policy hides the local environment, so the client list holds no local
    // row and the local-default lookup is null. An agent default that still
    // names the hidden local row names no visible environment, so the resolver
    // treats it as a local resolution and redirects to the managed sandbox.
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: "hidden-local-env",
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: null,
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
        visibleEnvironmentIds: ["managed-env", "ssh-env"],
      }),
    ).toBe("managed-env");
  });

  it("fails closed when an agent default names the hidden local row and no managed sandbox exists", () => {
    expect(() =>
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: "hidden-local-env",
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: null,
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: null,
        visibleEnvironmentIds: ["ssh-env"],
      }),
    ).toThrow(ManagedSandboxUnavailableForTestError);
  });

  it("leaves a visible non-local default untouched when a visibility list is supplied", () => {
    expect(
      resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: "ssh-env",
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: null,
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
        visibleEnvironmentIds: ["ssh-env", "managed-env"],
      }),
    ).toBe("ssh-env");
  });
});

describe("resolveManagedSandboxEnvironmentId", () => {
  it("finds the non-local platform-managed environment", () => {
    const environments = [
      makeEnvironment({
        id: "local-1",
        driver: "local",
        metadata: { managedByPaperclip: true, defaultForInstance: true },
      }),
      makeEnvironment({
        id: "sandbox-1",
        driver: "sandbox",
        metadata: { managedByPaperclip: true },
      }),
    ];
    // The local-default row also carries the managed stamp, so the resolver must
    // exclude the local driver and return the sandbox row.
    expect(resolveManagedSandboxEnvironmentId(environments)).toBe("sandbox-1");
  });

  it("returns null when no managed sandbox environment exists", () => {
    const environments = [
      makeEnvironment({ id: "sandbox-1", driver: "sandbox", metadata: null }),
      makeEnvironment({
        id: "local-1",
        driver: "local",
        metadata: { managedByPaperclip: true, defaultForInstance: true },
      }),
    ];
    expect(resolveManagedSandboxEnvironmentId(environments)).toBeNull();
    expect(resolveManagedSandboxEnvironmentId([])).toBeNull();
    expect(resolveManagedSandboxEnvironmentId(null)).toBeNull();
  });

  it("skips an archived managed sandbox", () => {
    // The server run-time resolver requires an active managed sandbox, so the
    // Test resolution must not select an archived one. An archived sandbox row
    // still carries the managed stamp, so the status guard is the only filter
    // that excludes it. A real run rejects an archived sandbox, so the Test must
    // reject it too.
    const environments = [
      makeEnvironment({
        id: "sandbox-archived",
        driver: "sandbox",
        status: "archived",
        metadata: { managedByPaperclip: true },
      }),
      makeEnvironment({
        id: "local-1",
        driver: "local",
        metadata: { managedByPaperclip: true, defaultForInstance: true },
      }),
    ];
    expect(resolveManagedSandboxEnvironmentId(environments)).toBeNull();
  });

  it("selects the active managed sandbox and skips an archived one", () => {
    // When both an archived and an active managed sandbox exist, the resolver
    // returns the active row, matching the server run-time resolver.
    const environments = [
      makeEnvironment({
        id: "sandbox-archived",
        driver: "sandbox",
        status: "archived",
        metadata: { managedByPaperclip: true },
      }),
      makeEnvironment({
        id: "sandbox-active",
        driver: "sandbox",
        status: "active",
        metadata: { managedByPaperclip: true },
      }),
    ];
    expect(resolveManagedSandboxEnvironmentId(environments)).toBe("sandbox-active");
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
