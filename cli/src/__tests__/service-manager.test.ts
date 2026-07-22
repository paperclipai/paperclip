import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertForegroundRunAllowed,
  detectServiceManager,
  LaunchdServiceManager,
  renderLaunchdPlist,
  renderSystemdUnit,
  SystemdServiceManager,
  type CommandRunner,
  type ServiceManager,
} from "../services/service-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  delete process.env.PAPERCLIP_SERVICE_MANAGED;
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("service definition generation", () => {
  it("generates a stable systemd notify unit without secrets", () => {
    const unit = renderSystemdUnit({ instanceId: "team-a", shimPath: "/home/alice/.local/bin/paperclipai", homeDir: "/home/alice/.paperclip" });
    expect(unit).toContain("Type=notify");
    expect(unit).toContain("NotifyAccess=all");
    expect(unit).toContain('ExecStart="/home/alice/.local/bin/paperclipai" run --instance "team-a"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("TimeoutStopSec=300");
    expect(unit).not.toContain("API_KEY");
  });

  it("generates a launchd agent with keepalive and instance logs", () => {
    const plist = renderLaunchdPlist({ instanceId: "team-a", shimPath: "/Users/alice/.local/bin/paperclipai", homeDir: "/Users/alice/.paperclip", stdoutPath: "/Users/alice/.paperclip/instances/team-a/logs/service.log", stderrPath: "/Users/alice/.paperclip/instances/team-a/logs/service.err.log" });
    expect(plist).toContain("ing.paperclip.paperclipai.team-a");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("service.err.log");
  });
});

describe("systemd drift regeneration", () => {
  it("rewrites a drifted unit and reloads the user manager", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "", stderr: "" };
    };
    const manager = new SystemdServiceManager("default", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    await fs.writeFile(manager.definitionPath, "stale\n", "utf8");

    const result = await manager.install({ startNow: false, startOnLogin: false });

    expect(result.changed).toBe(true);
    expect(await fs.readFile(manager.definitionPath, "utf8")).toBe(manager.renderDefinition());
    expect(calls).toContain("systemctl --user daemon-reload");
  });
});

describe("service adapter dispatch", () => {
  it("selects launchd on macOS", async () => {
    const detection = await detectServiceManager({ platform: "darwin", instanceId: "default" });
    expect(detection.supported).toBe(true);
    if (detection.supported) expect(detection.manager).toBeInstanceOf(LaunchdServiceManager);
  });

  it("selects systemd only when the user manager is reachable", async () => {
    const runner: CommandRunner = async () => ({ stdout: "", stderr: "" });
    const detection = await detectServiceManager({ platform: "linux", instanceId: "default", runner });
    expect(detection.supported).toBe(true);
    if (detection.supported) expect(detection.manager).toBeInstanceOf(SystemdServiceManager);
  });

  it("returns a foreground-run skip on unsupported hosts", async () => {
    const runner: CommandRunner = async () => { throw new Error("no bus"); };
    const detection = await detectServiceManager({ platform: "linux", instanceId: "default", runner });
    expect(detection).toEqual({ supported: false, reason: expect.stringContaining("paperclipai run") });
  });
});

describe("launchd lifecycle", () => {
  it("disables login startup and unloads the keepalive job when stopped", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);

    await manager.install({ startNow: false, startOnLogin: false });
    await manager.stop();

    expect(calls).toContain(`launchctl disable gui/${process.getuid?.() ?? 0}/ing.paperclip.paperclipai.team-a`);
    expect(calls).toContain(`launchctl bootout gui/${process.getuid?.() ?? 0}/ing.paperclip.paperclipai.team-a`);
    expect(calls.some((call) => call.includes("launchctl kill"))).toBe(false);
  });
});

describe("single-writer guard", () => {
  const activeManager = { status: async () => ({ active: true, serviceName: "paperclipai.service" }) } as unknown as ServiceManager;
  const detector = async () => ({ supported: true as const, manager: activeManager });

  it("refuses a second foreground writer", async () => {
    await expect(assertForegroundRunAllowed("default", false, detector)).rejects.toThrow("already running");
  });

  it("allows an explicit force override", async () => {
    await expect(assertForegroundRunAllowed("default", true, detector)).resolves.toBeUndefined();
  });

  it("allows the supervisor-owned process", async () => {
    process.env.PAPERCLIP_SERVICE_MANAGED = "1";
    await expect(assertForegroundRunAllowed("default", false, detector)).resolves.toBeUndefined();
  });
});
