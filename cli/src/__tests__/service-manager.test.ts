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
    expect(unit).toContain("KillMode=mixed");
    expect(unit).toContain('ExecStart="/home/alice/.local/bin/paperclipai" run --instance "team-a"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("TimeoutStopSec=300");
    expect(unit).not.toContain("API_KEY");
  });

  it("escapes systemd variable and specifier expansion in configured values", () => {
    const unit = renderSystemdUnit({
      instanceId: "team-$USER-%i",
      shimPath: "/home/$USER/%i/paperclipai",
      homeDir: "/home/$USER/%i/.paperclip",
    });

    expect(unit).toContain('ExecStart="/home/$$USER/%%i/paperclipai" run --instance "team-$$USER-%%i"');
    expect(unit).toContain('Environment="PAPERCLIP_HOME=/home/$$USER/%%i/.paperclip"');
  });

  it.each([
    ["instanceId", { instanceId: "team-a\nExecStartPre=/tmp/attack", shimPath: "/home/alice/.local/bin/paperclipai", homeDir: "/home/alice/.paperclip" }],
    ["shimPath", { instanceId: "team-a", shimPath: "/home/alice/bin/paperclipai\r\nExecStartPre=/tmp/attack", homeDir: "/home/alice/.paperclip" }],
    ["homeDir", { instanceId: "team-a", shimPath: "/home/alice/.local/bin/paperclipai", homeDir: "/home/alice/.paperclip\nEnvironment=ATTACK=1" }],
  ])("rejects line breaks in the systemd %s", (_field, input) => {
    expect(() => renderSystemdUnit(input)).toThrow("Systemd service values must not contain line breaks");
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

  it("keeps the unit installed when stopping an active service fails", async () => {
    const userHome = await temporaryDirectory();
    const runner: CommandRunner = async (command, args) => {
      if (args.includes("--property=LoadState,ActiveState,UnitFileState,MainPID")) return { stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=42\n", stderr: "" };
      if (command === "systemctl" && args.includes("stop")) throw new Error("stop failed");
      return { stdout: "", stderr: "" };
    };
    const manager = new SystemdServiceManager("default", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    await fs.writeFile(manager.definitionPath, manager.renderDefinition(), "utf8");

    await expect(manager.uninstall()).rejects.toThrow("stop failed");
    await expect(fs.access(manager.definitionPath)).resolves.toBeUndefined();
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
  it("starts without changing the saved login preference", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "print") throw Object.assign(new Error("Could not find service"), { code: 113 });
      if (args[0] === "print-disabled") return { stdout: `\"ing.paperclip.paperclipai.team-a\" => true`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome, path.join(userHome, "LaunchDaemons"));

    await manager.start();

    expect(calls).toContain(`launchctl disable gui/${process.getuid?.() ?? 0}/ing.paperclip.paperclipai.team-a`);
    expect(calls).not.toContain(`launchctl enable gui/${process.getuid?.() ?? 0}/ing.paperclip.paperclipai.team-a`);
  });

  it("preserves disabled state when the service name contains regex metacharacters", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const serviceName = "ing.paperclip.paperclipai.team[qa]+";
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "print") throw Object.assign(new Error("Could not find service"), { code: 113 });
      if (args[0] === "print-disabled") return { stdout: `"${serviceName}" => true`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team[qa]+", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome, path.join(userHome, "LaunchDaemons"));

    await manager.start();

    expect(calls).toContain(`launchctl disable gui/${process.getuid?.() ?? 0}/${serviceName}`);
    expect(calls).not.toContain(`launchctl enable gui/${process.getuid?.() ?? 0}/${serviceName}`);
  });

  it("disables login startup and unloads the keepalive job when stopped", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "print") throw Object.assign(new Error("Could not find service"), { code: 113 });
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome, path.join(userHome, "LaunchDaemons"));

    await manager.install({ startNow: false, startOnLogin: false });
    await manager.stop();

    expect(calls).toContain(`launchctl disable gui/${process.getuid?.() ?? 0}/ing.paperclip.paperclipai.team-a`);
    expect(calls).toContain(`launchctl bootout gui/${process.getuid?.() ?? 0}/ing.paperclip.paperclipai.team-a`);
    expect(calls.some((call) => call.includes("launchctl kill"))).toBe(false);
  });

  it("disables login startup when uninstalled", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "print") throw Object.assign(new Error("Could not find service"), { code: 113 });
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome, path.join(userHome, "LaunchDaemons"));

    await manager.uninstall();

    expect(calls).toContain(`launchctl disable gui/${process.getuid?.() ?? 0}/ing.paperclip.paperclipai.team-a`);
  });

  it("recognizes a loaded system LaunchDaemon without overwriting its root-owned definition", async () => {
    const home = await temporaryDirectory();
    const daemonDir = path.join(home, "LaunchDaemons");
    const serviceName = "ing.paperclip.paperclipai.team-a";
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "launchctl" && args[0] === "print" && args[1] === `system/${serviceName}`) {
        return { stdout: `system/${serviceName} = {\n  state = running\n  pid = 4321\n}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(home, ".paperclip"), "/usr/bin/paperclipai", home, daemonDir);
    await fs.mkdir(daemonDir, { recursive: true });
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    await fs.writeFile(manager.definitionPath, "GUI_AGENT_STAGED_OFF");
    await fs.writeFile(path.join(daemonDir, `${serviceName}.plist`), renderLaunchdPlist({
      instanceId: "team-a", shimPath: "/opt/example/boot-service", homeDir: home,
      stdoutPath: "/tmp/out", stderrPath: "/tmp/err",
    }));

    expect(await manager.status()).toMatchObject({ installed: true, active: true, pid: 4321 });
    expect(await manager.installedExecutablePath()).toBe("/opt/example/boot-service");
    await manager.restart();
    expect(calls).toContain(`sudo -n launchctl kickstart -k system/${serviceName}`);
    expect(await fs.readFile(manager.definitionPath, "utf8")).toBe("GUI_AGENT_STAGED_OFF");
    await expect(manager.install({ startNow: true, startOnLogin: true })).rejects.toThrow("competing GUI agent");
    await expect(manager.uninstall()).rejects.toThrow("uninstall must not");
  });

  it("restarts a still-loaded GUI job without re-enabling its staged-on-disk login agent", async () => {
    const home = await temporaryDirectory();
    const daemonDir = path.join(home, "LaunchDaemons");
    const serviceName = "ing.paperclip.paperclipai.team-a";
    const guiDomain = `gui/${process.getuid?.() ?? 0}`;
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "launchctl" && args[0] === "print" && args[1] === `system/${serviceName}`) throw new Error("not bootstrapped yet");
      if (command === "launchctl" && args[0] === "print" && args[1] === `${guiDomain}/${serviceName}`) {
        return { stdout: `${guiDomain}/${serviceName} = {\n  state = running\n  pid = 1234\n}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(home, ".paperclip"), "/usr/bin/paperclipai", home, daemonDir);
    await fs.mkdir(daemonDir, { recursive: true });
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    await fs.writeFile(path.join(daemonDir, `${serviceName}.plist`), "SYSTEM_DAEMON_STAGED");
    await fs.writeFile(manager.definitionPath, "GUI_AGENT_STAGED_OFF");

    expect(await manager.status()).toMatchObject({ installed: true, active: true, pid: 1234 });
    await manager.restart();
    expect(calls).toContain(`launchctl kickstart -k ${guiDomain}/${serviceName}`);
    expect(calls.some((call) => call.startsWith("sudo "))).toBe(false);
    expect(await fs.readFile(manager.definitionPath, "utf8")).toBe("GUI_AGENT_STAGED_OFF");
  });

  it("bootstraps a configured daemon after system stop, without installing a GUI agent", async () => {
    const home = await temporaryDirectory();
    const daemonDir = path.join(home, "LaunchDaemons");
    const name = "ing.paperclip.paperclipai.team-a";
    const systemPlist = path.join(daemonDir, `${name}.plist`);
    const calls: string[][] = [];
    let loaded = true;
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "launchctl" && args[0] === "print") {
        if (args[1] !== `system/${name}` || !loaded) throw Object.assign(new Error("Could not find service"), { code: 113 });
        return { stdout: `system/${name} = {\n  pid = 4321\n}\n`, stderr: "" };
      }
      if (command === "sudo" && args[2] === "bootout") loaded = false;
      if (command === "sudo" && args[2] === "bootstrap") loaded = true;
      return { stdout: "", stderr: "" };
    };
    await fs.mkdir(daemonDir, { recursive: true });
    await fs.writeFile(systemPlist, "system definition");
    const manager = new LaunchdServiceManager("team-a", runner, path.join(home, ".paperclip"), "/bin/echo", home, daemonDir);

    await manager.stop();
    expect(await manager.status()).toMatchObject({ installed: true, active: false });
    await manager.start();
    expect(calls).toContainEqual(["sudo", "-n", "launchctl", "bootout", `system/${name}`]);
    expect(calls).toContainEqual(["sudo", "-n", "launchctl", "bootstrap", "system", systemPlist]);
    expect(calls).toContainEqual(["sudo", "-n", "launchctl", "kickstart", `system/${name}`]);
    await manager.stop();
    await manager.restart();
    expect(calls.filter(([, , , action]) => action === "bootstrap")).toHaveLength(2);
    expect(calls).not.toContainEqual(["sudo", "-n", "launchctl", "kickstart", "-k", `system/${name}`]);
    await expect(fs.access(manager.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create GUI competition for a loaded daemon with a nonstandard plist filename", async () => {
    const home = await temporaryDirectory();
    const daemonDir = path.join(home, "LaunchDaemons");
    const name = "ing.paperclip.paperclipai.team-a";
    const calls: string[][] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "launchctl" && args[0] === "print") {
        return { stdout: `system/${name} = {\n  pid = 456\n}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(home, ".paperclip"), "/bin/echo", home, daemonDir);
    await expect(manager.install({ startNow: true, startOnLogin: true })).rejects.toThrow("competing GUI agent");
    await expect(manager.uninstall()).rejects.toThrow("competing GUI agent");
    await expect(manager.stop()).rejects.toThrow("source plist");
    expect(calls).not.toContainEqual(["sudo", "-n", "launchctl", "bootout", `system/${name}`]);
    await manager.restart();
    expect(calls).toContainEqual(["sudo", "-n", "launchctl", "kickstart", "-k", `system/${name}`]);
    expect(await manager.definitionOwnership()).toEqual({ kind: "operator", path: `system/${name}` });
    await expect(fs.access(manager.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses GUI writes when launchctl cannot inspect system ownership", async () => {
    const home = await temporaryDirectory();
    const calls: string[][] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      throw new Error("Operation not permitted");
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(home, ".paperclip"), "/bin/echo", home, path.join(home, "LaunchDaemons"));
    await expect(manager.install({ startNow: true, startOnLogin: true })).rejects.toThrow("Cannot inspect launchd job");
    await expect(manager.start()).rejects.toThrow("Cannot inspect launchd job");
    await expect(manager.status()).rejects.toThrow("Cannot inspect launchd job");
    expect(calls.every(([command]) => command === "launchctl")).toBe(true);
    await expect(fs.access(manager.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not suppress malformed launchctl print results", async () => {
    const home = await temporaryDirectory();
    const runner: CommandRunner = async () => ({ stdout: "unexpected response", stderr: "" });
    const manager = new LaunchdServiceManager("team-a", runner, path.join(home, ".paperclip"), "/bin/echo", home, path.join(home, "LaunchDaemons"));
    await expect(manager.install({ startNow: true, startOnLogin: true })).rejects.toThrow("Unexpected output");
    await expect(fs.access(manager.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails sudo without prompting or falling back to the GUI domain", async () => {
    const home = await temporaryDirectory();
    const daemonDir = path.join(home, "LaunchDaemons");
    const name = "ing.paperclip.paperclipai.team-a";
    const calls: string[][] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "launchctl") return { stdout: `system/${name} = {\n pid = 123\n}`, stderr: "" };
      if (command === "sudo") throw new Error("sudo: a password is required");
      throw new Error("unexpected executable");
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(home, ".paperclip"), "/bin/echo", home, daemonDir);
    await expect(manager.restart()).rejects.toThrow("Run sudo launchctl 'kickstart' '-k'");
    expect(calls).toContainEqual(["sudo", "-n", "launchctl", "kickstart", "-k", `system/${name}`]);
    expect(calls.some(([command, ...args]) => command === "launchctl" && args.includes("kickstart"))).toBe(false);
    await expect(fs.access(manager.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never bootstraps a symlinked system plist as root", async () => {
    const home = await temporaryDirectory();
    const daemonDir = path.join(home, "LaunchDaemons");
    const name = "ing.paperclip.paperclipai.team-a";
    await fs.mkdir(daemonDir, { recursive: true });
    const target = path.join(home, "plisted");
    await fs.writeFile(target, "not a service");
    await fs.symlink(target, path.join(daemonDir, `${name}.plist`));
    const calls: string[][] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "print") throw Object.assign(new Error("Could not find service"), { code: 113 });
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(home, ".paperclip"), "/bin/echo", home, daemonDir);
    await expect(manager.start()).rejects.toThrow("unsafe system LaunchDaemon plist");
    expect(calls.some(([command]) => command === "sudo")).toBe(false);
    await expect(manager.install({ startNow: true, startOnLogin: true })).rejects.toThrow("competing GUI agent");
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

  it("refuses to replace a symlinked service definition", async () => {
    const userHome = await temporaryDirectory();
    const manager = new SystemdServiceManager("default", async () => ({ stdout: "", stderr: "" }), path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    const target = path.join(userHome, "target.service"); await fs.writeFile(target, "preserve\n"); await fs.symlink(target, manager.definitionPath);
    await expect(manager.install({ startNow: false, startOnLogin: false })).rejects.toThrow("unsafe service definition");
    expect(await fs.readFile(target, "utf8")).toBe("preserve\n");
  });

});
