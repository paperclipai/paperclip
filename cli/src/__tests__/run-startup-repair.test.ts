import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import {
  classifyStartupRepairableFailure,
  repairDevWorkspaceDependencyIntegrity,
} from "../commands/run-startup-repair.js";

describe("run startup repair", () => {
  beforeEach(() => spawnSyncMock.mockReset());

  it("classifies missing external workspace dependencies as dependency integrity failures", () => {
    const error = new Error(
      "Cannot find package '@cursor/sdk' imported from /repo/packages/adapters/cursor-cloud/src/server/execute.ts",
    ) as Error & { code: string };
    error.code = "ERR_MODULE_NOT_FOUND";
    expect(classifyStartupRepairableFailure({ error, projectRoot: "/repo" })).toMatchObject({
      kind: "dependency_integrity_failure",
      missingSpecifier: "@cursor/sdk",
    });
  });

  it("classifies missing node_modules loader paths as dependency integrity failures", () => {
    const error = new Error("Cannot find module '/repo/server/node_modules/tsx/dist/cli.mjs'") as Error & {
      code: string;
    };
    error.code = "ERR_MODULE_NOT_FOUND";
    expect(classifyStartupRepairableFailure({ error, projectRoot: "/repo" })).toMatchObject({
      kind: "dependency_integrity_failure",
      missingSpecifier: "/repo/server/node_modules/tsx/dist/cli.mjs",
    });
  });

  it("does not classify missing local source files as dependency integrity failures", () => {
    const error = new Error(
      "Cannot find module './missing-local-file.js' imported from /repo/server/src/index.ts",
    ) as Error & { code: string };
    error.code = "ERR_MODULE_NOT_FOUND";
    expect(classifyStartupRepairableFailure({ error, projectRoot: "/repo" })).toBeNull();
  });

  it("runs frozen install, workspace link repair, and server build verification in order", () => {
    spawnSyncMock.mockReturnValue({ status: 0, error: undefined });
    repairDevWorkspaceDependencyIntegrity("/repo");
    const binary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    expect(spawnSyncMock.mock.calls).toEqual([
      [binary, ["install", "--frozen-lockfile"], expect.objectContaining({ cwd: "/repo", stdio: "inherit" })],
      [binary, ["run", "preflight:workspace-links"], expect.objectContaining({ cwd: "/repo", stdio: "inherit" })],
      [binary, ["--filter", "@paperclipai/server", "build"], expect.objectContaining({ cwd: "/repo", stdio: "inherit" })],
    ]);
  });
});
