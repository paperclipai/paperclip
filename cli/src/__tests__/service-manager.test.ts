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
      if (args[0] === "print-disabled") return { stdout: `\"ing.paperclip.paperclipai.team-a\" => true`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);

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
      if (args[0] === "print-disabled") return { stdout: `"${serviceName}" => true`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team[qa]+", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);

    await manager.start();

    expect(calls).toContain(`launchctl disable gui/${process.getuid?.() ?? 0}/${serviceName}`);
    expect(calls).not.toContain(`launchctl enable gui/${process.getuid?.() ?? 0}/${serviceName}`);
  });

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

  it("disables login startup when uninstalled", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);

    await manager.uninstall();

    expect(calls).toContain(`launchctl disable gui/${process.getuid?.() ?? 0}/ing.paperclip.paperclipai.team-a`);
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

describe("operator-added service environment", () => {
  it("keeps custom launchd EnvironmentVariables when start re-renders the plist", async () => {
    const userHome = await temporaryDirectory();
    const runner: CommandRunner = async () => ({ stdout: "", stderr: "" });
    const manager = new LaunchdServiceManager("default", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    const customized = manager.renderDefinition().replace(
      "  </dict>\n  <key>RunAtLoad</key>",
      "    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>\n    <key>ENABLE_CLAUDEAI_MCP_SERVERS</key><string>false</string>\n  </dict>\n  <key>RunAtLoad</key>",
    );
    await fs.writeFile(manager.definitionPath, customized, "utf8");

    await manager.start();
    await manager.restart();

    const plist = await fs.readFile(manager.definitionPath, "utf8");
    expect(plist).toContain("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>");
    expect(plist).toContain("<key>ENABLE_CLAUDEAI_MCP_SERVERS</key><string>false</string>");
    expect(plist.match(/<key>PAPERCLIP_HOME<\/key>/g)).toHaveLength(1);
    expect(manager.renderDefinition(plist)).toBe(plist);
  });

  it("keeps custom systemd Environment= lines when restart re-renders the unit", async () => {
    const userHome = await temporaryDirectory();
    const runner: CommandRunner = async () => ({ stdout: "", stderr: "" });
    const manager = new SystemdServiceManager("default", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    const customized = manager.renderDefinition().replace(
      "WorkingDirectory=%h",
      'Environment="PATH=/home/alice/.local/bin:/usr/bin"\nEnvironment=PAPERCLIP_TAILNET_BIND_HOST=100.64.0.1\nWorkingDirectory=%h',
    );
    await fs.writeFile(manager.definitionPath, customized, "utf8");

    await manager.restart();

    const unit = await fs.readFile(manager.definitionPath, "utf8");
    expect(unit).toContain('Environment="PATH=/home/alice/.local/bin:/usr/bin"');
    expect(unit).toContain("Environment=PAPERCLIP_TAILNET_BIND_HOST=100.64.0.1");
    expect(unit.match(/PAPERCLIP_HOME=/g)).toHaveLength(1);
    expect(manager.renderDefinition(unit)).toBe(unit);
  });
  it("carries systemd assignments forward exactly as written", async () => {
    const userHome = await temporaryDirectory();
    const runner: CommandRunner = async () => ({ stdout: "", stderr: "" });
    const manager = new SystemdServiceManager("default", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    const operatorLines = [
      'Environment="PATH=%h/.local/bin:/usr/bin" "FEATURE_FLAG=1"',
      "Environment='GREETING=hello world' PLAIN=$HOME",
      'Environment="QUOTED=say \\"hi\\"" PAPERCLIP_HOME=/elsewhere',
    ];
    const customized = manager.renderDefinition().replace("WorkingDirectory=%h", `${operatorLines.join("\n")}\nWorkingDirectory=%h`);
    await fs.writeFile(manager.definitionPath, customized, "utf8");

    await manager.restart();

    const unit = await fs.readFile(manager.definitionPath, "utf8");
    expect(unit).toContain(operatorLines[0]);
    expect(unit).toContain(operatorLines[1]);
    expect(unit).toContain('Environment="QUOTED=say \\"hi\\""\n');
    expect(unit).not.toContain("%%h");
    expect(unit).not.toContain("/elsewhere");
    expect(unit.match(/PAPERCLIP_HOME=/g)).toHaveLength(1);
    expect(manager.renderDefinition(unit)).toBe(unit);
  });

  it("decodes numeric character references in launchd values", async () => {
    const userHome = await temporaryDirectory();
    const runner: CommandRunner = async () => ({ stdout: "", stderr: "" });
    const manager = new LaunchdServiceManager("default", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    const customized = manager.renderDefinition().replace(
      "  </dict>\n  <key>RunAtLoad</key>",
      "    <key>PATH</key><string>/Users/Alice&#32;Smith/bin:/usr&#x2F;bin</string>\n  </dict>\n  <key>RunAtLoad</key>",
    );
    await fs.writeFile(manager.definitionPath, customized, "utf8");

    await manager.start();

    const plist = await fs.readFile(manager.definitionPath, "utf8");
    expect(plist).toContain("<key>PATH</key><string>/Users/Alice Smith/bin:/usr/bin</string>");
    expect(plist).not.toContain("&amp;#");
  });
});
