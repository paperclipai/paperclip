import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolvePaperclipHomeDir, resolvePaperclipInstanceId } from "../config/home.js";

const execFileAsync = promisify(execFile);

export type ServicePlatform = "systemd" | "launchd";
export type ServiceStatus = {
  platform: ServicePlatform;
  serviceName: string;
  installed: boolean;
  active: boolean;
  enabled: boolean;
  pid: number | null;
  detail?: string;
  linger?: boolean | null;
};
export type ServiceInstallOptions = { startNow: boolean; startOnLogin: boolean };

export interface ServiceManager {
  readonly platform: ServicePlatform;
  readonly instanceId: string;
  readonly serviceName: string;
  readonly definitionPath: string;
  renderDefinition(): string;
  install(options: ServiceInstallOptions): Promise<{ changed: boolean }>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
  logs(follow: boolean, lines: number): Promise<void>;
  enableLinger?(): Promise<void>;
}

export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[], options?: { inherit?: boolean }) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = async (command, args, options) => {
  if (options?.inherit) {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(command, args, { windowsHide: true }, (error) => error ? reject(error) : resolve());
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    });
    return { stdout: "", stderr: "" };
  }
  const result = await execFileAsync(command, args, { encoding: "utf8", windowsHide: true });
  return { stdout: result.stdout, stderr: result.stderr };
};

function escapeSystemd(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", () => "$$")
    .replaceAll("%", "%%");
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveServiceShimPath(homeDir = os.homedir()): string {
  return process.env.PAPERCLIP_SHIM_PATH?.trim() || path.join(homeDir, ".local", "bin", "paperclipai");
}

export function systemdServiceName(instanceId: string): string {
  return instanceId === "default" ? "paperclipai.service" : `paperclipai-${instanceId}.service`;
}

export function launchdServiceName(instanceId: string): string {
  return instanceId === "default" ? "ing.paperclip.paperclipai" : `ing.paperclip.paperclipai.${instanceId}`;
}

export function renderSystemdUnit(input: { instanceId: string; shimPath: string; homeDir: string }): string {
  return `[Unit]
Description=Paperclip AI (${input.instanceId})
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=notify
NotifyAccess=all
ExecStart="${escapeSystemd(input.shimPath)}" run --instance "${escapeSystemd(input.instanceId)}"
Environment="PAPERCLIP_SERVICE_MANAGED=1"
Environment="PAPERCLIP_INSTANCE_ID=${escapeSystemd(input.instanceId)}"
Environment="PAPERCLIP_HOME=${escapeSystemd(input.homeDir)}"
WorkingDirectory=%h
Restart=always
RestartSec=5
TimeoutStopSec=300

[Install]
WantedBy=default.target
`;
}

export function renderLaunchdPlist(input: { instanceId: string; shimPath: string; homeDir: string; stdoutPath: string; stderrPath: string }): string {
  const label = launchdServiceName(input.instanceId);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(input.shimPath)}</string><string>run</string><string>--instance</string><string>${escapeXml(input.instanceId)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PAPERCLIP_SERVICE_MANAGED</key><string>1</string>
    <key>PAPERCLIP_INSTANCE_ID</key><string>${escapeXml(input.instanceId)}</string>
    <key>PAPERCLIP_HOME</key><string>${escapeXml(input.homeDir)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>300</integer>
  <key>StandardOutPath</key><string>${escapeXml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(input.stderrPath)}</string>
</dict>
</plist>
`;
}

async function writeIfChanged(filePath: string, contents: string): Promise<boolean> {
  const directoryPath = path.dirname(filePath);
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(directoryPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(`Refusing to write service definition through unsafe directory ${directoryPath}.`);
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && directoryStat.uid !== currentUid) throw new Error(`Refusing to write service definition in directory not owned by the current user: ${directoryPath}.`);
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error(`Refusing to replace unsafe service definition ${filePath}.`);
    if (currentUid !== undefined && stat.uid !== currentUid) throw new Error(`Refusing to replace service definition not owned by the current user: ${filePath}.`);
    if (await fs.readFile(filePath, "utf8") === contents) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(directoryPath, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
  return true;
}

export class SystemdServiceManager implements ServiceManager {
  readonly platform = "systemd" as const;
  readonly serviceName: string;
  readonly definitionPath: string;

  constructor(readonly instanceId: string, private readonly runner: CommandRunner = defaultCommandRunner, private readonly homeDir = resolvePaperclipHomeDir(), private readonly shimPath = resolveServiceShimPath(), userHomeDir = os.homedir()) {
    this.serviceName = systemdServiceName(instanceId);
    this.definitionPath = path.join(userHomeDir, ".config", "systemd", "user", this.serviceName);
  }

  renderDefinition(): string {
    return renderSystemdUnit({ instanceId: this.instanceId, shimPath: this.shimPath, homeDir: this.homeDir });
  }

  private async ensureCurrent(): Promise<boolean> {
    const changed = await writeIfChanged(this.definitionPath, this.renderDefinition());
    if (changed) await this.runner("systemctl", ["--user", "daemon-reload"]);
    return changed;
  }

  async install(options: ServiceInstallOptions): Promise<{ changed: boolean }> {
    const changed = await this.ensureCurrent();
    if (options.startOnLogin) await this.runner("systemctl", ["--user", "enable", this.serviceName]);
    else await this.runner("systemctl", ["--user", "disable", this.serviceName]).catch(() => undefined);
    if (options.startNow) await this.start();
    return { changed };
  }

  async uninstall(): Promise<void> {
    const status = await this.status();
    if (status.active) await this.stop();
    await this.runner("systemctl", ["--user", "disable", this.serviceName]).catch(() => undefined);
    await fs.rm(this.definitionPath, { force: true });
    await this.runner("systemctl", ["--user", "daemon-reload"]);
    await this.runner("systemctl", ["--user", "reset-failed", this.serviceName]).catch(() => undefined);
  }

  async start(): Promise<void> { await this.ensureCurrent(); await this.runner("systemctl", ["--user", "start", this.serviceName]); }
  async stop(): Promise<void> { await this.runner("systemctl", ["--user", "stop", this.serviceName]); }
  async restart(): Promise<void> { await this.ensureCurrent(); await this.runner("systemctl", ["--user", "restart", this.serviceName]); }

  async status(): Promise<ServiceStatus> {
    let output: string;
    try {
      output = (await this.runner("systemctl", ["--user", "show", this.serviceName, "--property=LoadState,ActiveState,UnitFileState,MainPID"])).stdout;
    } catch {
      return { platform: this.platform, serviceName: this.serviceName, installed: false, active: false, enabled: false, pid: null, linger: await this.lingerStatus() };
    }
    const values = Object.fromEntries(output.trim().split(/\r?\n/).map((line) => line.split(/=(.*)/s).slice(0, 2)));
    const pid = Number(values.MainPID);
    return { platform: this.platform, serviceName: this.serviceName, installed: values.LoadState === "loaded", active: values.ActiveState === "active", enabled: values.UnitFileState === "enabled", pid: Number.isInteger(pid) && pid > 0 ? pid : null, detail: values.ActiveState, linger: await this.lingerStatus() };
  }

  private async lingerStatus(): Promise<boolean | null> {
    try {
      const result = await this.runner("loginctl", ["show-user", String(process.getuid?.() ?? os.userInfo().username), "--property=Linger", "--value"]);
      return result.stdout.trim() === "yes";
    } catch { return null; }
  }

  async enableLinger(): Promise<void> { await this.runner("loginctl", ["enable-linger", os.userInfo().username]); }
  async logs(follow: boolean, lines: number): Promise<void> { await this.runner("journalctl", ["--user", "--unit", this.serviceName, "--lines", String(lines), ...(follow ? ["--follow"] : [])], { inherit: true }); }
}

export class LaunchdServiceManager implements ServiceManager {
  readonly platform = "launchd" as const;
  readonly serviceName: string;
  readonly definitionPath: string;
  private readonly domain = `gui/${process.getuid?.() ?? 0}`;
  private readonly stdoutPath: string;
  private readonly stderrPath: string;

  constructor(readonly instanceId: string, private readonly runner: CommandRunner = defaultCommandRunner, private readonly homeDir = resolvePaperclipHomeDir(), private readonly shimPath = resolveServiceShimPath(), userHomeDir = os.homedir()) {
    this.serviceName = launchdServiceName(instanceId);
    this.definitionPath = path.join(userHomeDir, "Library", "LaunchAgents", `${this.serviceName}.plist`);
    const logDir = path.join(homeDir, "instances", instanceId, "logs");
    this.stdoutPath = path.join(logDir, "service.log");
    this.stderrPath = path.join(logDir, "service.err.log");
  }

  renderDefinition(): string { return renderLaunchdPlist({ instanceId: this.instanceId, shimPath: this.shimPath, homeDir: this.homeDir, stdoutPath: this.stdoutPath, stderrPath: this.stderrPath }); }

  async install(options: ServiceInstallOptions): Promise<{ changed: boolean }> {
    await fs.mkdir(path.dirname(this.stdoutPath), { recursive: true });
    const changed = await writeIfChanged(this.definitionPath, this.renderDefinition());
    if (changed) await this.runner("launchctl", ["bootout", `${this.domain}/${this.serviceName}`]).catch(() => undefined);
    await this.runner("launchctl", [options.startOnLogin ? "enable" : "disable", `${this.domain}/${this.serviceName}`]);
    if (options.startOnLogin || options.startNow) {
      await this.runner("launchctl", ["bootstrap", this.domain, this.definitionPath]).catch(async () => this.runner("launchctl", ["kickstart", "-k", `${this.domain}/${this.serviceName}`]));
    }
    if (!options.startNow) await this.stop().catch(() => undefined);
    return { changed };
  }

  async uninstall(): Promise<void> {
    await this.runner("launchctl", ["bootout", `${this.domain}/${this.serviceName}`]).catch(() => undefined);
    await this.runner("launchctl", ["disable", `${this.domain}/${this.serviceName}`]).catch(() => undefined);
    await fs.rm(this.definitionPath, { force: true });
  }
  async start(): Promise<void> { await this.install({ startNow: true, startOnLogin: await this.isEnabled() }); }
  async stop(): Promise<void> { await this.runner("launchctl", ["bootout", `${this.domain}/${this.serviceName}`]); }
  async restart(): Promise<void> { await writeIfChanged(this.definitionPath, this.renderDefinition()); await this.runner("launchctl", ["kickstart", "-k", `${this.domain}/${this.serviceName}`]); }

  async status(): Promise<ServiceStatus> {
    try {
      const result = await this.runner("launchctl", ["print", `${this.domain}/${this.serviceName}`]);
      const pidMatch = result.stdout.match(/\bpid\s*=\s*(\d+)/);
      const pid = pidMatch ? Number(pidMatch[1]) : null;
      return { platform: this.platform, serviceName: this.serviceName, installed: true, active: Boolean(pid), enabled: await this.isEnabled(), pid, detail: pid ? "running" : "loaded" };
    } catch {
      let installed = true;
      try { await fs.access(this.definitionPath); } catch { installed = false; }
      return { platform: this.platform, serviceName: this.serviceName, installed, active: false, enabled: installed && await this.isEnabled(), pid: null };
    }
  }

  private async isEnabled(): Promise<boolean> {
    try {
      const result = await this.runner("launchctl", ["print-disabled", this.domain]);
      return !new RegExp(`"${escapeRegExp(this.serviceName)}"\\s*=>\\s*true`).test(result.stdout);
    } catch { return true; }
  }

  async logs(follow: boolean, lines: number): Promise<void> { await this.runner("tail", ["-n", String(lines), ...(follow ? ["-F"] : []), this.stdoutPath, this.stderrPath], { inherit: true }); }
}

export type ServiceManagerDetection = { supported: true; manager: ServiceManager } | { supported: false; reason: string };

export async function detectServiceManager(input: { instanceId?: string; platform?: NodeJS.Platform; runner?: CommandRunner } = {}): Promise<ServiceManagerDetection> {
  const instanceId = resolvePaperclipInstanceId(input.instanceId);
  const platform = input.platform ?? process.platform;
  const runner = input.runner ?? defaultCommandRunner;
  if (platform === "darwin") return { supported: true, manager: new LaunchdServiceManager(instanceId, runner) };
  if (platform !== "linux") return { supported: false, reason: `Service management is not supported on ${platform}. Use paperclipai run instead.` };
  try {
    await runner("systemctl", ["--user", "show-environment"]);
    return { supported: true, manager: new SystemdServiceManager(instanceId, runner) };
  } catch {
    return { supported: false, reason: "No usable systemd user manager was detected (common in containers and WSL1). Use paperclipai run instead." };
  }
}

export async function assertForegroundRunAllowed(instanceId: string, force = false, detector: typeof detectServiceManager = detectServiceManager): Promise<void> {
  if (force || process.env.PAPERCLIP_SERVICE_MANAGED === "1") return;
  const detection = await detector({ instanceId });
  if (!detection.supported) return;
  const status = await detection.manager.status();
  if (status.active) throw new Error(`Paperclip instance '${instanceId}' is already running as ${status.serviceName}. Use 'paperclipai service status --instance ${instanceId}' or pass --force to bypass this safety check.`);
}
