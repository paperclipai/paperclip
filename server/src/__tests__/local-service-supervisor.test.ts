import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWindowsProcessCreatedAtMs } from "@paperclipai/adapter-utils/windows-process-ownership";
import {
  resetRuntimeServicesForTests,
  startRuntimeServicesForWorkspaceControl,
} from "../services/workspace-runtime.js";
import {
  doesLocalServiceCommandLineMatch,
  isLocalServiceCommandLineComparable,
  isPidAlive,
  listLocalServiceRegistryRecords,
  readLocalServicePortOwner,
  resolveLocalServiceLogPath,
  terminateLocalService,
} from "../services/local-service-supervisor.js";

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

    // The managed service uses a login shell, whose PATH can select a different
    // Node installation from the one CI configured for this test process.
    // Git Bash accepts Windows drive paths with forward slashes.
    const nodeExecutable = process.platform === "win32"
      ? process.execPath.replace(/\\/g, "/")
      : process.execPath;
    const nodeCommand = "'" + nodeExecutable.replace(/'/g, "'\\''") + "'";
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
          branchCreatedByRuntime: false,
        },
        config: {
          workspaceRuntime: {
            services: [{
              name: "web",
              command: nodeCommand + " -e \"const http=require('node:http'); console.log('fixture starting', process.execPath, process.env.PORT); process.on('SIGTERM',()=>{}); http.createServer((req,res)=>{ process.stdout.write('request '+req.url+'\\\\n',(error)=>{ if (!error) res.end('ok'); }); }).listen(Number(process.env.PORT), '127.0.0.1',()=>console.log('fixture listening', process.env.PORT))\"",
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
      expect(log).toContain(process.execPath);

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

  it("terminates the descendant tree on Windows so an orphan cannot hold the service stdio", async () => {
    if (process.platform !== "win32") return;
    const wrapper = spawn(process.execPath, ["-e", [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], { detached:true, stdio:['ignore','inherit','inherit'] });",
      "process.stdout.write(String(c.pid));",
      "setInterval(()=>{},1000);",
    ].join(" ")], { stdio: ["ignore", "pipe", "pipe"] });
    let grandchildPid: number | null = null;
    try {
      grandchildPid = await new Promise<number>((resolve, reject) => {
        wrapper.stdout!.on("data", (d) => {
          const pid = Number.parseInt(String(d).trim(), 10);
          if (Number.isInteger(pid) && pid > 0) resolve(pid);
        });
        wrapper.on("error", reject);
      });
      expect(isPidAlive(grandchildPid)).toBe(true);

      const rootCreatedAtMs = await readWindowsProcessCreatedAtMs(wrapper.pid!);
      expect(rootCreatedAtMs).not.toBeNull();

      await terminateLocalService({
        pid: wrapper.pid!,
        processGroupId: wrapper.pid!,
        ...(rootCreatedAtMs === null
          ? {}
          : { processCreatedAt: new Date(rootCreatedAtMs).toISOString() }),
      });

      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && isPidAlive(grandchildPid)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(isPidAlive(grandchildPid)).toBe(false);
      expect(isPidAlive(wrapper.pid!)).toBe(false);
    } finally {
      if (grandchildPid) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {}
      }
      try {
        wrapper.kill("SIGKILL");
      } catch {}
    }
  }, 45_000);

  it("terminates an orphaned descendant on Windows after the root process already exited", async () => {
    if (process.platform !== "win32") return;
    const wrapper = spawn(process.execPath, ["-e", [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], { detached:true, stdio:['ignore','inherit','inherit'] });",
      "process.stdout.write(String(c.pid));",
      "setInterval(()=>{},1000);",
    ].join(" ")], { stdio: ["ignore", "pipe", "pipe"] });
    let grandchildPid: number | null = null;
    try {
      grandchildPid = await new Promise<number>((resolve, reject) => {
        wrapper.stdout!.on("data", (d) => {
          const pid = Number.parseInt(String(d).trim(), 10);
          if (Number.isInteger(pid) && pid > 0) resolve(pid);
        });
        wrapper.on("error", reject);
      });
      expect(isPidAlive(grandchildPid)).toBe(true);

      const rootCreatedAtMs = await readWindowsProcessCreatedAtMs(wrapper.pid!);
      expect(rootCreatedAtMs).not.toBeNull();

      wrapper.kill("SIGKILL");
      const rootDeadline = Date.now() + 15_000;
      while (Date.now() < rootDeadline && isPidAlive(wrapper.pid!)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(isPidAlive(wrapper.pid!)).toBe(false);
      expect(isPidAlive(grandchildPid)).toBe(true);

      await terminateLocalService({
        pid: wrapper.pid!,
        processGroupId: wrapper.pid!,
        ...(rootCreatedAtMs === null
          ? {}
          : { processCreatedAt: new Date(rootCreatedAtMs).toISOString() }),
      });

      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && isPidAlive(grandchildPid)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(isPidAlive(grandchildPid)).toBe(false);
    } finally {
      if (grandchildPid) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {}
      }
      try {
        wrapper.kill("SIGKILL");
      } catch {}
    }
  }, 120_000);

  it("stops the tree of a service record without a creation time on Windows", async () => {
    if (process.platform !== "win32") return;
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const probe = net.createServer();
      probe.on("error", rejectPort);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const resolved = typeof address === "object" && address ? address.port : 0;
        probe.close(() => resolvePort(resolved));
      });
    });
    const marker = "paperclip-supervisor-probe";
    const wrapper = spawn(process.execPath, ["-e", [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], { detached:true, stdio:['ignore','inherit','inherit'] });",
      `require('node:http').createServer(()=>{}).listen(${port}, '127.0.0.1', () => { process.stdout.write(String(c.pid)); });`,
      "setInterval(()=>{},1000);",
    ].join(" "), marker], { stdio: ["ignore", "pipe", "pipe"] });
    let grandchildPid: number | null = null;
    try {
      grandchildPid = await new Promise<number>((resolve, reject) => {
        wrapper.stdout!.on("data", (d) => {
          const pid = Number.parseInt(String(d).trim(), 10);
          if (Number.isInteger(pid) && pid > 0) resolve(pid);
        });
        wrapper.on("error", reject);
      });
      expect(isPidAlive(grandchildPid)).toBe(true);

      await terminateLocalService({
        pid: wrapper.pid!,
        processGroupId: wrapper.pid!,
        port,
        command: marker,
        serviceName: marker,
      });

      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && isPidAlive(grandchildPid)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(isPidAlive(grandchildPid)).toBe(false);
    } finally {
      if (grandchildPid) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {}
      }
      try {
        wrapper.kill("SIGKILL");
      } catch {}
    }
  }, 120_000);

  it("refuses to kill an unrelated process that reuses a recorded pid on Windows", async () => {
    if (process.platform !== "win32") return;
    const foreign = spawn(process.execPath, ["-e", [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], { stdio:['ignore','inherit','inherit'] });",
      "process.stdout.write(String(c.pid));",
      "setInterval(()=>{},1000);",
    ].join(" ")], { stdio: ["ignore", "pipe", "pipe"] });
    let foreignChildPid: number | null = null;
    try {
      foreignChildPid = await new Promise<number>((resolve, reject) => {
        foreign.stdout!.on("data", (d) => {
          const pid = Number.parseInt(String(d).trim(), 10);
          if (Number.isInteger(pid) && pid > 0) resolve(pid);
        });
        foreign.on("error", reject);
      });
      expect(isPidAlive(foreign.pid!)).toBe(true);
      expect(isPidAlive(foreignChildPid)).toBe(true);

      await expect(
        terminateLocalService({
          pid: foreign.pid!,
          processGroupId: foreign.pid!,
          processCreatedAt: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      ).rejects.toThrow(/Failed to terminate local service process tree/);

      expect(isPidAlive(foreign.pid!)).toBe(true);
      expect(isPidAlive(foreignChildPid)).toBe(true);
    } finally {
      if (foreignChildPid) {
        try {
          process.kill(foreignChildPid, "SIGKILL");
        } catch {}
      }
      try {
        foreign.kill("SIGKILL");
      } catch {}
    }
  }, 120_000);
});
