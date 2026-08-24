import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetRuntimeServicesForTests,
  startRuntimeServicesForWorkspaceControl,
} from "../services/workspace-runtime.js";
import {
  doesLocalServiceCommandLineMatch,
  findAdoptableLocalService,
  findLocalServiceRegistryRecordByRuntimeServiceId,
  isLocalServiceCommandLineComparable,
  listLocalServiceRegistryRecords,
  readLocalServicePortOwner,
  readLocalServiceRegistryRecord,
  resolveLocalServiceLogPath,
  terminateLocalService,
  writeLocalServiceRegistryRecord,
} from "../services/local-service-supervisor.js";
import {
  disposeZombieLeadProcessGroup,
  readLinuxProcessState,
  spawnZombieLeadProcessGroup,
} from "./helpers/zombie-process.js";

describe("local service supervision", () => {
  afterEach(async () => {
    await resetRuntimeServicesForTests({ terminateProcesses: true });
  });

  it("keeps request-logging runtime stdio usable after the supervisor side closes", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-stdio-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-home-"));
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `service-stdio-${randomUUID()}`;

    let registryRecord: Awaited<ReturnType<typeof listLocalServiceRegistryRecords>>[number] | null = null;
    try {
      const [service] = await startRuntimeServicesForWorkspaceControl({
        actor: { id: null, name: "Board", companyId: randomUUID() },
        issue: null,
        workspace: {
          baseCwd: workspaceRoot,
          source: "agent_home",
          projectId: null,
          workspaceId: null,
          repoUrl: null,
          repoRef: null,
          strategy: "project_primary",
          cwd: workspaceRoot,
          branchName: null,
          worktreePath: null,
          warnings: [],
          created: false,
        },
        config: {
          workspaceRuntime: {
            services: [{
              name: "web",
              command: "node -e \"const http=require('node:http'); process.on('SIGTERM',()=>{}); http.createServer((req,res)=>{ process.stdout.write('request '+req.url+'\\\\n',(error)=>{ if (!error) res.end('ok'); }); }).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "agent",
              stopPolicy: { type: "manual" },
            }],
          },
        },
        adapterEnv: {},
      });

      expect(service?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(service?.port).toBeTypeOf("number");
      registryRecord = (await listLocalServiceRegistryRecords({ profileKind: "workspace-runtime" }))
        .find((record) => record.runtimeServiceId === service!.id) ?? null;
      expect(registryRecord).not.toBeNull();

      await resetRuntimeServicesForTests({ simulateSupervisorExit: true });

      await expect(fetch(`${service!.url}/after-restart`)).resolves.toMatchObject({ ok: true });
      const log = await fs.readFile(resolveLocalServiceLogPath(registryRecord!.serviceKey), "utf8");
      expect(log).toContain("request /after-restart");

      await terminateLocalService(registryRecord!);
      expect(await readLocalServicePortOwner(service!.port!)).toBeNull();
      await expect(fetch(service!.url!)).rejects.toThrow();
      registryRecord = null;
    } finally {
      if (registryRecord) await terminateLocalService(registryRecord).catch(() => undefined);
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
      await fs.rm(paperclipHome, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("does not wait for an unrelated process that takes over the service port", async () => {
    if (process.platform === "win32") return;
    const unrelatedListener = net.createServer();
    await new Promise<void>((resolve) => unrelatedListener.listen(0, "127.0.0.1", resolve));
    const address = unrelatedListener.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!port) throw new Error("Failed to allocate unrelated listener port");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    try {
      await terminateLocalService({
        pid: child.pid!,
        processGroupId: child.pid!,
        port,
      });
      expect(await readLocalServicePortOwner(port)).toBe(process.pid);
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The target process group was already terminated.
      }
      await new Promise<void>((resolve, reject) => {
        unrelatedListener.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("recognizes a pnpm command after the launcher becomes pnpm.cjs", () => {
    expect(doesLocalServiceCommandLineMatch({
      commandLine: "/usr/bin/node /opt/pnpm/pnpm.cjs dev -- --bind custom --bind-host 127.0.0.1",
      recordedCommand: "pnpm dev -- --bind custom --bind-host 127.0.0.1",
      serviceName: "paperclip-dev",
    })).toBe(true);
  });

  it("does not compare shell expressions with the surviving process argv", () => {
    expect(isLocalServiceCommandLineComparable(
      "env | sort > /tmp/service.env; exec pnpm dev --bind loopback",
    )).toBe(false);
    expect(isLocalServiceCommandLineComparable(
      "node -e \"process.stdout.write('left | right')\"",
    )).toBe(true);
  });

  it("does not accept a different command merely because it uses node", () => {
    expect(doesLocalServiceCommandLineMatch({
      commandLine: "/usr/bin/node /workspace/server/dist/index.js",
      recordedCommand: "pnpm dev -- --bind custom --bind-host 127.0.0.1",
      serviceName: "paperclip-dev",
    })).toBe(false);
  });

  it("does not collapse different script paths to the same basename", () => {
    expect(doesLocalServiceCommandLineMatch({
      commandLine: "/usr/bin/node /other-workspace/server.js",
      recordedCommand: "node ./server.js",
      serviceName: "web",
    })).toBe(false);
  });
});

// The zombie shape is built from /proc, so these cases only run on Linux.
const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("local service registry liveness against an unreaped pid", () => {
  async function withTempInstanceHome<T>(fn: () => Promise<T>) {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-zombie-registry-"));
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `zombie-registry-${randomUUID()}`;
    try {
      return await fn();
    } finally {
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  }

  function zombieRecord(pid: number, serviceKey: string, runtimeServiceId: string | null) {
    const now = new Date().toISOString();
    return {
      version: 1,
      serviceKey,
      profileKind: "workspace-runtime",
      serviceName: "web",
      // A redirect makes the recorded command uncomparable to OS argv, so
      // isLikelyMatchingCommand short-circuits to true on every host. Without
      // that, the outcome would depend on what `ps` reports for a zombie.
      command: "node server.js > server.log 2>&1",
      cwd: process.cwd(),
      envFingerprint: "zombie",
      // No port, so there is no live listener to fall through to. The record is
      // backed by nothing but the recorded pid.
      port: null,
      url: null,
      pid,
      processGroupId: null,
      provider: "local_process" as const,
      runtimeServiceId,
      reuseKey: null,
      startedAt: now,
      lastSeenAt: now,
      metadata: null,
    };
  }

  it("drops a runtime-service record whose recorded pid is an unreaped zombie", async () => {
    const zombie = await spawnZombieLeadProcessGroup();
    try {
      expect(readLinuxProcessState(zombie.zombiePid)).toBe("Z");
      await withTempInstanceHome(async () => {
        const serviceKey = "workspace-runtime-web-zombie";
        const runtimeServiceId = randomUUID();
        await writeLocalServiceRegistryRecord(zombieRecord(zombie.zombiePid, serviceKey, runtimeServiceId));

        await expect(findLocalServiceRegistryRecordByRuntimeServiceId({
          runtimeServiceId,
          profileKind: "workspace-runtime",
        })).resolves.toBeNull();
        await expect(readLocalServiceRegistryRecord(serviceKey)).resolves.toBeNull();
      });
    } finally {
      disposeZombieLeadProcessGroup(zombie);
    }
  });

  it("does not report a service adoptable when its recorded pid is an unreaped zombie", async () => {
    const zombie = await spawnZombieLeadProcessGroup();
    try {
      expect(readLinuxProcessState(zombie.zombiePid)).toBe("Z");
      await withTempInstanceHome(async () => {
        const serviceKey = "workspace-runtime-web-zombie-adopt";
        await writeLocalServiceRegistryRecord(zombieRecord(zombie.zombiePid, serviceKey, null));

        await expect(findAdoptableLocalService({
          serviceKey,
          profileKind: "workspace-runtime",
        })).resolves.toBeNull();
        await expect(readLocalServiceRegistryRecord(serviceKey)).resolves.toBeNull();
      });
    } finally {
      disposeZombieLeadProcessGroup(zombie);
    }
  });

  it("treats termination of an unreaped zombie pid as already done", async () => {
    const zombie = await spawnZombieLeadProcessGroup();
    try {
      expect(readLinuxProcessState(zombie.zombiePid)).toBe("Z");
      // Signals sent to a zombie are discarded, so the escalate-then-verify
      // cycle can never observe it leave. Without a zombie-aware check this
      // burns both grace windows and then reports a failure to terminate a
      // process that is already dead.
      await expect(terminateLocalService(
        { pid: zombie.zombiePid, processGroupId: null },
        { forceAfterMs: 300, verifyAfterMs: 300 },
      )).resolves.toBeUndefined();
    } finally {
      disposeZombieLeadProcessGroup(zombie);
    }
  });
});
