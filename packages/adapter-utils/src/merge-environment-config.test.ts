import { describe, it, expect } from "vitest";
import { mergeEnvironmentConfig } from "./merge-environment-config.js";

describe("mergeEnvironmentConfig", () => {
  it("returns adapterConfig unchanged when environmentConfig is undefined", () => {
    const adapterConfig = { namespace: "default", nodeSelector: { foo: "bar" } };
    expect(mergeEnvironmentConfig(adapterConfig, undefined)).toEqual(adapterConfig);
  });

  it("returns adapterConfig unchanged when environmentConfig is null", () => {
    const adapterConfig = { namespace: "default" };
    expect(mergeEnvironmentConfig(adapterConfig, null)).toEqual(adapterConfig);
  });

  it("environmentConfig wins for fields set on both sides", () => {
    const merged = mergeEnvironmentConfig(
      { namespace: "default", nodeSelector: { foo: "bar" } },
      { namespace: "paperclip", workspaceVolumeClaim: "paperclip-data" },
    );
    expect(merged).toEqual({
      namespace: "paperclip",
      nodeSelector: { foo: "bar" },
      workspaceVolumeClaim: "paperclip-data",
    });
  });

  it("nested object fields override at top level (no deep merge)", () => {
    // Document the simple-merge behavior so adapter writers don't expect
    // deep-merge surprises on nodeSelector / labels.
    const merged = mergeEnvironmentConfig(
      { nodeSelector: { workload: "paperclip", arch: "amd64" } },
      { nodeSelector: { workload: "agents" } },
    );
    expect(merged.nodeSelector).toEqual({ workload: "agents" });
  });

  it("ignores environmentConfig keys whose values are null", () => {
    const adapter: Record<string, unknown> = { namespace: "default" };
    const env: Record<string, unknown> = { namespace: null, workspaceMountPath: "/paperclip" };
    const merged = mergeEnvironmentConfig(adapter, env);
    expect(merged.namespace).toBe("default");
    expect(merged.workspaceMountPath).toBe("/paperclip");
  });

  it("ignores environmentConfig keys whose values are undefined", () => {
    const adapter: Record<string, unknown> = { namespace: "default", workspaceMountPath: "/work" };
    const env: Record<string, unknown> = { namespace: undefined, workspaceMountPath: "/paperclip" };
    const merged = mergeEnvironmentConfig(adapter, env);
    expect(merged.namespace).toBe("default");
    expect(merged.workspaceMountPath).toBe("/paperclip");
  });

  it("preserves adapterConfig when environmentConfig is empty", () => {
    const adapterConfig = { namespace: "default", nodeSelector: { foo: "bar" } };
    expect(mergeEnvironmentConfig(adapterConfig, {})).toEqual(adapterConfig);
  });
});
