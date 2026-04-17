import { describe, it, expect } from "vitest";
import {
  readProjectWorkspaceRuntimeConfig,
  mergeProjectWorkspaceRuntimeConfig,
} from "./project-workspace-runtime-config.js";

// ---------------------------------------------------------------------------
// readProjectWorkspaceRuntimeConfig
// ---------------------------------------------------------------------------

describe("readProjectWorkspaceRuntimeConfig", () => {
  it("returns null for null metadata", () => {
    expect(readProjectWorkspaceRuntimeConfig(null)).toBeNull();
  });

  it("returns null for undefined metadata", () => {
    expect(readProjectWorkspaceRuntimeConfig(undefined)).toBeNull();
  });

  it("returns null when metadata has no runtimeConfig key", () => {
    expect(readProjectWorkspaceRuntimeConfig({ other: "value" })).toBeNull();
  });

  it("returns null when runtimeConfig is not a record (e.g., a string)", () => {
    expect(readProjectWorkspaceRuntimeConfig({ runtimeConfig: "not-an-object" })).toBeNull();
  });

  it("returns null when runtimeConfig record has no recognized fields", () => {
    expect(readProjectWorkspaceRuntimeConfig({ runtimeConfig: { unknown: true } })).toBeNull();
  });

  it("reads desiredState 'running' from runtimeConfig", () => {
    const result = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: { desiredState: "running" },
    });
    expect(result?.desiredState).toBe("running");
  });

  it("reads desiredState 'stopped' from runtimeConfig", () => {
    const result = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: { desiredState: "stopped" },
    });
    expect(result?.desiredState).toBe("stopped");
  });

  it("returns null desiredState for an unrecognized value", () => {
    const result = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: { workspaceRuntime: { env: {} }, desiredState: "paused" },
    });
    expect(result?.desiredState).toBeNull();
  });

  it("reads workspaceRuntime as a cloned record", () => {
    const runtimeObj = { mode: "docker" };
    const result = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: { workspaceRuntime: runtimeObj },
    });
    expect(result?.workspaceRuntime).toEqual({ mode: "docker" });
    expect(result?.workspaceRuntime).not.toBe(runtimeObj);
  });

  it("reads serviceStates, keeping only 'running' and 'stopped' entries", () => {
    const result = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: {
        serviceStates: { db: "running", api: "stopped", cache: "unknown" },
      },
    });
    expect(result?.serviceStates).toEqual({ db: "running", api: "stopped" });
    expect(result?.serviceStates).not.toHaveProperty("cache");
  });

  it("returns null serviceStates when all entries are invalid", () => {
    const result = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: {
        workspaceRuntime: { foo: "bar" },
        serviceStates: { cache: "invalid" },
      },
    });
    expect(result?.serviceStates).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mergeProjectWorkspaceRuntimeConfig
// ---------------------------------------------------------------------------

describe("mergeProjectWorkspaceRuntimeConfig", () => {
  it("removes runtimeConfig from metadata when patch is null", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(
      { runtimeConfig: { desiredState: "running" }, other: "keep" },
      null,
    );
    expect(result).not.toHaveProperty("runtimeConfig");
    expect(result).toHaveProperty("other", "keep");
  });

  it("returns null when metadata was only runtimeConfig and patch removes it", () => {
    const result = mergeProjectWorkspaceRuntimeConfig({ runtimeConfig: { desiredState: "running" } }, null);
    expect(result).toBeNull();
  });

  it("sets desiredState on a fresh metadata object", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(null, { desiredState: "stopped" });
    expect((result?.runtimeConfig as Record<string, unknown>)?.desiredState).toBe("stopped");
  });

  it("merges desiredState patch without overwriting other runtimeConfig fields", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(
      { runtimeConfig: { workspaceRuntime: { mode: "docker" } } },
      { desiredState: "running" },
    );
    const rc = result?.runtimeConfig as Record<string, unknown>;
    expect(rc?.desiredState).toBe("running");
    expect(rc?.workspaceRuntime).toEqual({ mode: "docker" });
  });

  it("replaces workspaceRuntime when patch supplies one", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(
      { runtimeConfig: { workspaceRuntime: { old: true } } },
      { workspaceRuntime: { new: true } },
    );
    expect(
      (result?.runtimeConfig as Record<string, unknown>)?.workspaceRuntime,
    ).toEqual({ new: true });
  });

  it("removes runtimeConfig entirely when merged result has all null fields", () => {
    // Starting with desiredState; patching desiredState to undefined but null patch clears it
    const result = mergeProjectWorkspaceRuntimeConfig(
      { runtimeConfig: { desiredState: "running" } },
      { desiredState: null },
    );
    expect(result).toBeNull();
  });

  it("preserves unrelated metadata keys through the merge", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(
      { existingKey: "value" },
      { desiredState: "running" },
    );
    expect(result).toHaveProperty("existingKey", "value");
  });
});
