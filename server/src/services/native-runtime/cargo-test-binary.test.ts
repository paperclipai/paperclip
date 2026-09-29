import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRunnerCargoTestBinary, resolveRunnerCargoTestBinaryOrDefault } from "./cargo-test-binary.js";

afterEach(() => vi.unstubAllEnvs());

describe("isolated Cargo integration binary resolution", () => {
  const workspace = resolve("/tmp/paperclip-runner-workspace");
  const executable = (name: string) => `${name}${process.platform === "win32" ? ".exe" : ""}`;

  it("preserves the normal target path when CARGO_TARGET_DIR is unset", () => {
    vi.stubEnv("CARGO_TARGET_DIR", "");
    expect(resolveRunnerCargoTestBinary(workspace, "debug", "fake-codex-app-server"))
      .toBe(resolve(workspace, "target", "debug", executable("fake-codex-app-server")));
  });

  it("resolves absolute and workspace-relative target directories", () => {
    vi.stubEnv("CARGO_TARGET_DIR", "/tmp/isolated-cargo-target");
    expect(resolveRunnerCargoTestBinary(workspace, "release", "paperclip-runnerd"))
      .toBe(resolve("/tmp/isolated-cargo-target", "release", executable("paperclip-runnerd")));
    vi.stubEnv("CARGO_TARGET_DIR", "target/history-development");
    expect(resolveRunnerCargoTestBinary(workspace, "release", "paperclip-runnerd"))
      .toBe(resolve(workspace, "target/history-development", "release", executable("paperclip-runnerd")));
  });

  it("uses staged/default resolution only without an isolated target", () => {
    const fallback = vi.fn(() => "/staged/paperclip-runnerd");
    vi.stubEnv("CARGO_TARGET_DIR", "");
    expect(resolveRunnerCargoTestBinaryOrDefault(workspace, "debug", "paperclip-runnerd", fallback))
      .toBe("/staged/paperclip-runnerd");
    expect(fallback).toHaveBeenCalledOnce();
    vi.stubEnv("CARGO_TARGET_DIR", "target/isolated");
    expect(resolveRunnerCargoTestBinaryOrDefault(workspace, "debug", "paperclip-runnerd", fallback))
      .toBe(resolve(workspace, "target/isolated", "debug", executable("paperclip-runnerd")));
    expect(fallback).toHaveBeenCalledOnce();
  });
});
