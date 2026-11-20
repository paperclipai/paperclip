import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Db } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetRuntimeServicesForTests,
  startRuntimeServicesForWorkspaceControl,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.js";

const hooks = vi.hoisted(() => ({
  ready: () => {},
  failed: () => {},
  rejectReadiness: false,
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: (...args: unknown[]) => hooks.spawn(...args) };
});

vi.mock("../services/workspace-source-lock.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/workspace-source-lock.js")>(),
  workspaceSourceIdentities: async () => ({ projectIds: [], issueIds: [] }),
  withWorkspaceSourceLocks: async (_db: unknown, _input: unknown, action: () => Promise<unknown>) => action(),
  assertCurrentWorkspaceSourceHeld: async () => {},
}));

vi.mock("../services/local-service-supervisor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/local-service-supervisor.js")>(),
  findAdoptableLocalService: async () => null,
  touchLocalServiceRegistryRecord: async () => {
    if (hooks.rejectReadiness) throw new Error("readiness publication failed");
    hooks.ready();
  },
  removeLocalServiceRegistryRecord: async () => { hooks.failed(); },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("workspace runtime deferred readiness persistence", () => {
  let root: string;
  let workspace: RealizedExecutionWorkspace;
  let allowReadiness: ReturnType<typeof deferred>;
  let settled: ReturnType<typeof deferred>;
  let writes: string[];
  let events: string[];
  let persistedStatus: string | undefined;
  let rejectFirstWrite: boolean;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-deferred-readiness-"));
    vi.stubEnv("PAPERCLIP_HOME", root);
    workspace = {
      baseCwd: root, cwd: root, source: "project_primary", strategy: "project_primary",
      projectId: "project-1", workspaceId: "workspace-1", repoUrl: null, repoRef: "HEAD",
      branchName: null, branchCreatedByRuntime: false, worktreePath: null, warnings: [], created: false,
    };
    allowReadiness = deferred();
    settled = deferred();
    writes = [];
    events = [];
    persistedStatus = undefined;
    rejectFirstWrite = false;
    hooks.rejectReadiness = false;
    hooks.ready = settled.resolve;
    hooks.failed = settled.resolve;
    hooks.spawn.mockReset().mockImplementation(() => Object.assign(new EventEmitter(), {
      pid: undefined, exitCode: null, signalCode: null,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => {
      await allowReadiness.promise;
      return new Response("ok");
    }));
  });

  afterEach(async () => {
    await resetRuntimeServicesForTests({ terminateProcesses: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  function database() {
    let initialWrite = true;
    const db = {
      select: () => ({ from: () => ({ where: () => ({
        for: async () => [{ id: workspace.workspaceId }],
        orderBy: () => ({ limit: async () => [] }),
      }) }) }),
      insert: () => ({ values: (values: { status: string }) => ({
        onConflictDoUpdate: async () => {
          const status = values.status;
          if (initialWrite) {
            initialWrite = false;
            expect(status).toBe("starting");
            allowReadiness.resolve();
            await settled.promise;
            await setImmediate();
            if (rejectFirstWrite) throw new Error("initial persistence failed");
          }
          writes.push(status);
          events.push(status);
          persistedStatus = status;
        },
      }) }),
      transaction: async <T>(action: (tx: unknown) => Promise<T>) => {
        const result = await action(db);
        events.push("commit");
        return result;
      },
    };
    return db as unknown as Db;
  }

  function start(db: Db) {
    return startRuntimeServicesForWorkspaceControl({
      db, actor: { id: "agent-1", name: "Engineer", companyId: "company-1" },
      issue: null, workspace, adapterEnv: {},
      config: { workspaceRuntime: { services: [{
        name: "worker", command: "deferred-readiness-test", lifecycle: "shared",
        reuseScope: "project_workspace", stopPolicy: { type: "manual" },
        readiness: { type: "http", urlTemplate: "http://127.0.0.1/ready" },
      }] } },
    });
  }

  it("persists running after readiness settles during the initial starting write", async () => {
    const [service] = await start(database());
    expect(service).toMatchObject({ status: "running", reused: false });
    expect(writes).toEqual(["starting", "running"]);
    expect(events).toEqual(["starting", "commit", "running"]);
    expect(persistedStatus).toBe("running");
  });

  it("propagates rejected readiness and persists its terminal state after commit", async () => {
    hooks.rejectReadiness = true;
    await expect(start(database())).rejects.toThrow("readiness publication failed");
    expect(writes).toEqual(["starting", "stopped"]);
    expect(events).toEqual(["starting", "commit", "stopped"]);
    expect(persistedStatus).toBe("stopped");
  });

  it("reuses a running service without spawning or scheduling another readiness write", async () => {
    const db = database();
    const [first] = await start(db);
    const [second] = await start(db);
    expect(second).toMatchObject({ id: first!.id, status: "running", reused: true });
    expect(hooks.spawn).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(["starting", "running", "running"]);
    expect(persistedStatus).toBe("running");
  });

  it("handles readiness rejection even when the initial write also rejects", async () => {
    hooks.rejectReadiness = true;
    rejectFirstWrite = true;
    await expect(start(database())).rejects.toThrow("initial persistence failed");
    expect(writes).toEqual([]);
  });
});
