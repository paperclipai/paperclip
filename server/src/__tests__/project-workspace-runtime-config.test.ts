import { describe, it, expect } from "vitest";
import {
  readProjectWorkspaceRuntimeConfig,
  mergeProjectWorkspaceRuntimeConfig,
} from "../services/project-workspace-runtime-config.js";

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

  it("returns null when runtimeConfig is not a plain object", () => {
    expect(readProjectWorkspaceRuntimeConfig({ runtimeConfig: "string" })).toBeNull();
    expect(readProjectWorkspaceRuntimeConfig({ runtimeConfig: 42 })).toBeNull();
    expect(readProjectWorkspaceRuntimeConfig({ runtimeConfig: null })).toBeNull();
    expect(readProjectWorkspaceRuntimeConfig({ runtimeConfig: [] })).toBeNull();
  });

  it("returns null when runtimeConfig is an empty object (both fields are null)", () => {
    // workspaceRuntime is not a record → null; desiredState is missing → null
    expect(readProjectWorkspaceRuntimeConfig({ runtimeConfig: {} })).toBeNull();
  });

  it("returns config with desiredState='running' when set", () => {
    const result = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: { desiredState: "running" },
    });
    expect(result).toEqual({ workspaceRuntime: null, desiredState: "running", serviceStates: null });
  });

  it("returns config with desiredState='stopped' when set", () => {
    const result = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: { desiredState: "stopped" },
    });
    expect(result).toEqual({ workspaceRuntime: null, desiredState: "stopped", serviceStates: null });
  });

  it("normalises unknown desiredState values to null", () => {
    const result = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: { desiredState: "paused", workspaceRuntime: { key: "v" } },
    });
    expect(result?.desiredState).toBeNull();
    expect(result?.workspaceRuntime).toEqual({ key: "v" });
  });

  it("returns config with workspaceRuntime when set", () => {
    const result = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: { workspaceRuntime: { port: 3000 } },
    });
    expect(result).toEqual({ workspaceRuntime: { port: 3000 }, desiredState: null, serviceStates: null });
  });

  it("clones the workspaceRuntime object (does not share reference)", () => {
    const original = { port: 3000 };
    const result = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: { workspaceRuntime: original },
    });
    expect(result?.workspaceRuntime).not.toBe(original);
    expect(result?.workspaceRuntime).toEqual(original);
  });

  it("returns null when workspaceRuntime is an array", () => {
    // arrays are not plain records
    const result = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: { workspaceRuntime: [1, 2, 3] },
    });
    // workspaceRuntime becomes null; desiredState is also absent → null
    expect(result).toBeNull();
  });

  it("returns config with both fields populated", () => {
    const result = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: { workspaceRuntime: { a: 1 }, desiredState: "running" },
    });
    expect(result).toEqual({ workspaceRuntime: { a: 1 }, desiredState: "running", serviceStates: null });
  });
});

// ---------------------------------------------------------------------------
// mergeProjectWorkspaceRuntimeConfig
// ---------------------------------------------------------------------------

describe("mergeProjectWorkspaceRuntimeConfig", () => {
  it("removes runtimeConfig when patch is null and returns null for empty metadata", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(
      { runtimeConfig: { desiredState: "running" } },
      null,
    );
    expect(result).toBeNull();
  });

  it("removes runtimeConfig when patch is null but preserves other metadata fields", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(
      { runtimeConfig: { desiredState: "running" }, theme: "dark" },
      null,
    );
    expect(result).toEqual({ theme: "dark" });
    expect(result).not.toHaveProperty("runtimeConfig");
  });

  it("merges desiredState into empty metadata", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(null, { desiredState: "running" });
    expect(result).toEqual({ runtimeConfig: { workspaceRuntime: null, desiredState: "running", serviceStates: null } });
  });

  it("merges workspaceRuntime into empty metadata", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(null, { workspaceRuntime: { port: 8080 } });
    expect(result).toEqual({
      runtimeConfig: { workspaceRuntime: { port: 8080 }, desiredState: null, serviceStates: null },
    });
  });

  it("merges patch over existing runtimeConfig", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(
      { runtimeConfig: { desiredState: "running", workspaceRuntime: { port: 3000 } } },
      { desiredState: "stopped" },
    );
    expect(result).toEqual({
      runtimeConfig: { desiredState: "stopped", workspaceRuntime: { port: 3000 }, serviceStates: null },
    });
  });

  it("preserves unchanged fields when patching only one field", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(
      { runtimeConfig: { desiredState: "stopped", workspaceRuntime: { a: 1 } } },
      { workspaceRuntime: { a: 2 } },
    );
    expect(result).toEqual({
      runtimeConfig: { desiredState: "stopped", workspaceRuntime: { a: 2 }, serviceStates: null },
    });
  });

  it("removes runtimeConfig when patch clears both fields to null", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(
      { runtimeConfig: { desiredState: "running" } },
      { desiredState: null, workspaceRuntime: null },
    );
    expect(result).toBeNull();
  });

  it("normalises invalid desiredState in patch to null, removes runtimeConfig if all null", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(
      { runtimeConfig: { desiredState: "running" } },
      { desiredState: "invalid" as never },
    );
    // desiredState becomes null, workspaceRuntime is null → runtimeConfig removed
    expect(result).toBeNull();
  });

  it("preserves other metadata keys alongside updated runtimeConfig", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(
      { theme: "light", runtimeConfig: { desiredState: "stopped" } },
      { desiredState: "running" },
    );
    expect(result).toEqual({
      theme: "light",
      runtimeConfig: { desiredState: "running", workspaceRuntime: null, serviceStates: null },
    });
  });

  it("clones workspaceRuntime from patch (no shared reference)", () => {
    const runtime = { port: 9000 };
    const result = mergeProjectWorkspaceRuntimeConfig(null, { workspaceRuntime: runtime });
    const stored = (result?.runtimeConfig as Record<string, unknown>)?.workspaceRuntime;
    expect(stored).not.toBe(runtime);
    expect(stored).toEqual(runtime);
  });

  it("handles null metadata with null patch — returns null", () => {
    expect(mergeProjectWorkspaceRuntimeConfig(null, null)).toBeNull();
  });

  it("handles undefined metadata gracefully", () => {
    const result = mergeProjectWorkspaceRuntimeConfig(undefined, { desiredState: "running" });
    expect(result).toEqual({
      runtimeConfig: { workspaceRuntime: null, desiredState: "running", serviceStates: null },
    });
  });
});
