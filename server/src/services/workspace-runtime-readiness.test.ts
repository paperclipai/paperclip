import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  child: null as ChildProcess | null,
  hold: "registry" as "registry" | "log-close",
  spawnErrors: [] as Error[],
  settled: Promise.resolve(),
}));

async function afterChildSettled() {
  await boundary.settled;
  await new Promise<void>((resolve) => setImmediate(resolve));
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      boundary.child = child;
      boundary.settled = new Promise<void>((resolve) => {
        child.once("error", (error) => { boundary.spawnErrors.push(error); resolve(); });
        child.once("close", () => resolve());
      });
      return child;
    },
  };
});

vi.mock("./local-service-supervisor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./local-service-supervisor.js")>();
  return {
    ...actual,
    writeLocalServiceRegistryRecord: async (...args: Parameters<typeof actual.writeLocalServiceRegistryRecord>) => {
      if (boundary.hold === "registry") await afterChildSettled();
      return actual.writeLocalServiceRegistryRecord(...args);
    },
    openLocalServiceLogFile: async (...args: Parameters<typeof actual.openLocalServiceLogFile>) => {
      const log = await actual.openLocalServiceLogFile(...args);
      const close = log.handle.close.bind(log.handle);
      log.handle.close = async () => {
        if (boundary.hold === "log-close") await afterChildSettled();
        await close();
      };
      return log;
    },
  };
});

import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { resetRuntimeServicesForTests, startRuntimeServicesForWorkspaceControl } from "./workspace-runtime.js";

let home: string | undefined;
afterEach(async () => {
  await resetRuntimeServicesForTests({ terminateProcesses: true });
  vi.unstubAllEnvs();
  if (home) await fs.rm(home, { recursive: true, force: true });
});

it.each([
  { hold: "registry" as const, shell: "/bin/sh", expected: /exited before readiness.*code 1/ },
  { hold: "log-close" as const, shell: "paperclip-missing-readiness-shell", expected: /ENOENT/ },
])("keeps $hold child failure observed and reports the original startup error", async ({ hold, shell, expected }) => {
  boundary.hold = hold;
  boundary.spawnErrors = [];
  home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-readiness-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_HTTPS", "off");
  vi.stubEnv("SHELL", shell);
  const unhandled: unknown[] = [];
  const observe = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", observe);
  try {
    const result = await startRuntimeServicesForWorkspaceControl({
      invocationId: "readiness-rejection-test",
      actor: { id: null, name: "Paperclip", companyId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      issue: null,
      workspace: {
        baseCwd: home, cwd: home, source: "project_primary", projectId: null,
        workspaceId: null, repoUrl: null, repoRef: null, strategy: "project_primary",
        branchName: "test", worktreePath: null, warnings: [], created: false,
        branchCreatedByRuntime: false,
      },
      executionWorkspaceId: "11111111-2222-4333-8444-555566667777",
      config: { workspaceRuntime: { services: [{ name: "preview", command: "exit 1",
        readiness: { type: "http", urlTemplate: "http://127.0.0.1:19999", timeoutSec: 1 },
      }] } },
      adapterEnv: {},
    }).then(() => null, (error: unknown) => error as Error);
    expect(result).toBeInstanceOf(Error);
    expect(result!.message).toMatch(expected);
    expect(unhandled).toEqual([]);
    const registry = await fs.readdir(path.join(resolvePaperclipInstanceRoot(), "runtime-services")).catch(() => []);
    expect(registry.filter((name) => name.endsWith(".json"))).toEqual([]);
    if (hold === "registry") expect(boundary.child!.exitCode).toBe(1);
    if (hold === "log-close") expect(boundary.spawnErrors).toHaveLength(1);
  } finally {
    process.removeListener("unhandledRejection", observe);
  }
});
