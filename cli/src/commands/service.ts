import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Command } from "commander";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServiceStatusOptions = { json?: boolean };
type ServiceLogsOptions = { follow?: boolean; lines?: number };

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const PAPERCLIP_LOG_DIR = path.join(os.homedir(), ".paperclip", "logs");
const SERVICE_LOG_PATH = path.join(PAPERCLIP_LOG_DIR, "service.log");

export function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== path.parse(dir).root) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name === "paperclipai" || pkg.name === "paperclip") return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error("Could not find paperclipai package root from " + startDir);
}

function paperclipRootDir(): string {
  return findPackageRoot(import.meta.dirname);
}

function nodeExecPath(): string {
  return process.execPath;
}

function serverEntryPath(): string {
  const root = paperclipRootDir();
  // In the published npm package, the CLI package is the root and it bundles
  // the server. In the monorepo, the server lives at server/dist/index.js.
  const monorepoServer = path.join(root, "server", "dist", "index.js");
  if (existsSync(monorepoServer)) return monorepoServer;
  // Fallback: if running from the CLI package directly (npm global install),
  // the server dependency is in node_modules.
  const nmServer = path.join(root, "node_modules", "@paperclipai", "server", "dist", "index.js");
  if (existsSync(nmServer)) return nmServer;
  throw new Error(
    "Could not find server entrypoint. Ensure the server is built (pnpm run build).",
  );
}

// ---------------------------------------------------------------------------
// XML / shell helpers
// ---------------------------------------------------------------------------

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// macOS launchd helpers
// ---------------------------------------------------------------------------

const LAUNCHD_LABEL = "com.paperclipai.paperclip";
const LAUNCHD_PLIST_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const LAUNCHD_PLIST_PATH = path.join(LAUNCHD_PLIST_DIR, `${LAUNCHD_LABEL}.plist`);

export function generateLaunchdPlist(): string {
  const node = nodeExecPath();
  const server = serverEntryPath();
  const workDir = paperclipRootDir();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCHD_LABEL)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(server)}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${xmlEscape(workDir)}</string>

  <key>KeepAlive</key>
  <true/>

  <key>RunAtLoad</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${xmlEscape(SERVICE_LOG_PATH)}</string>

  <key>StandardErrorPath</key>
  <string>${xmlEscape(SERVICE_LOG_PATH)}</string>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// Linux systemd helpers
// ---------------------------------------------------------------------------

const SYSTEMD_UNIT_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const SYSTEMD_UNIT_PATH = path.join(SYSTEMD_UNIT_DIR, "paperclip.service");

export function generateSystemdUnit(): string {
  const node = nodeExecPath();
  const server = serverEntryPath();
  const workDir = paperclipRootDir();

  return `[Unit]
Description=Paperclip Agent Orchestration Server
After=network.target

[Service]
Type=simple
ExecStart="${node}" "${server}"
WorkingDirectory="${workDir}"
Restart=always
RestartSec=10
StandardOutput=append:%h/.paperclip/logs/service.log
StandardError=append:%h/.paperclip/logs/service.log

[Install]
WantedBy=default.target
`;
}

// ---------------------------------------------------------------------------
// OS detection
// ---------------------------------------------------------------------------

export type SupportedPlatform = "darwin" | "linux";

export function detectPlatform(): SupportedPlatform {
  const plat = process.platform;
  if (plat === "darwin") return "darwin";
  if (plat === "linux") return "linux";
  throw new Error(
    `Platform ${plat} is not supported. Paperclip service management is available on macOS (launchd) and Linux (systemd).`,
  );
}

// ---------------------------------------------------------------------------
// UID helper
// ---------------------------------------------------------------------------

function getUid(): number {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) {
    p.log.error("Cannot determine user ID on this platform.");
    process.exit(1);
  }
  return uid;
}

// ---------------------------------------------------------------------------
// Ensure log directory
// ---------------------------------------------------------------------------

function ensureLogDir(): void {
  if (!existsSync(PAPERCLIP_LOG_DIR)) {
    mkdirSync(PAPERCLIP_LOG_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function serviceInstall(): void {
  let platform: SupportedPlatform;
  try {
    platform = detectPlatform();
  } catch (err) {
    p.log.error((err as Error).message);
    process.exit(1);
  }
  ensureLogDir();

  p.intro(pc.bgCyan(pc.black(" paperclipai service install ")));

  if (platform === "darwin") {
    if (!existsSync(LAUNCHD_PLIST_DIR)) {
      mkdirSync(LAUNCHD_PLIST_DIR, { recursive: true });
    }

    const uid = getUid();

    // Unload any existing service before re-installing
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}`, LAUNCHD_PLIST_PATH], { stdio: "pipe" });
    } catch {
      // Not loaded — that's fine
    }

    const plist = generateLaunchdPlist();
    writeFileSync(LAUNCHD_PLIST_PATH, plist, "utf8");
    p.log.success(`Wrote plist to ${pc.dim(LAUNCHD_PLIST_PATH)}`);

    try {
      execFileSync("launchctl", ["bootstrap", `gui/${uid}`, LAUNCHD_PLIST_PATH], {
        stdio: "pipe",
      });
    } catch (err) {
      const stderr = String((err as { stderr?: Buffer | string }).stderr ?? "");
      const status = (err as { status?: number }).status;
      // error code 37 = "service already registered" — safe to ignore on re-install
      if (status === 37 || stderr.includes("already registered")) {
        // already running — fine
      } else {
        p.log.error(`launchctl bootstrap failed: ${stderr || String(err)}`);
        process.exit(1);
      }
    }
    p.log.success("Service loaded via launchd");
  } else {
    if (!existsSync(SYSTEMD_UNIT_DIR)) {
      mkdirSync(SYSTEMD_UNIT_DIR, { recursive: true });
    }
    const unit = generateSystemdUnit();
    writeFileSync(SYSTEMD_UNIT_PATH, unit, "utf8");
    p.log.success(`Wrote unit file to ${pc.dim(SYSTEMD_UNIT_PATH)}`);

    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
      execFileSync("systemctl", ["--user", "enable", "--now", "paperclip.service"], { stdio: "pipe" });
    } catch (err) {
      p.log.error(
        `systemctl failed: ${String((err as { stderr?: Buffer | string }).stderr ?? (err as Error).message)}`,
      );
      process.exit(1);
    }
    p.log.success("Service enabled and started via systemd");
  }

  p.outro(pc.green("Paperclip service installed and running."));
  p.log.warn(
    `Note: The service path is baked in at install time. After upgrading Paperclip, ` +
    `run ${pc.bold("paperclipai service install")} again to update the service unit.`,
  );
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

function serviceUninstall(): void {
  let platform: SupportedPlatform;
  try {
    platform = detectPlatform();
  } catch (err) {
    p.log.error((err as Error).message);
    process.exit(1);
  }

  p.intro(pc.bgCyan(pc.black(" paperclipai service uninstall ")));

  if (platform === "darwin") {
    const uid = getUid();
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}`, LAUNCHD_PLIST_PATH], {
        stdio: "pipe",
      });
    } catch {
      // Already removed
    }
    if (existsSync(LAUNCHD_PLIST_PATH)) {
      unlinkSync(LAUNCHD_PLIST_PATH);
    }
    p.log.success("Plist removed and service unloaded");
  } else {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", "paperclip.service"], { stdio: "pipe" });
    } catch {
      // May not exist
    }
    if (existsSync(SYSTEMD_UNIT_PATH)) {
      unlinkSync(SYSTEMD_UNIT_PATH);
    }
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
    } catch (err) {
      p.log.warn(`daemon-reload failed: ${String((err as { stderr?: Buffer | string }).stderr ?? (err as Error).message)}`);
      // Non-fatal — unit is already removed
    }
    p.log.success("Systemd unit removed and daemon reloaded");
  }

  p.outro(pc.green("Paperclip service uninstalled."));
}

// ---------------------------------------------------------------------------
// Start / Stop / Restart
// ---------------------------------------------------------------------------

function serviceStart(): void {
  let platform: SupportedPlatform;
  try {
    platform = detectPlatform();
  } catch (err) {
    p.log.error((err as Error).message);
    process.exit(1);
  }
  try {
    if (platform === "darwin") {
      execFileSync("launchctl", ["start", LAUNCHD_LABEL], { stdio: "pipe" });
    } else {
      execFileSync("systemctl", ["--user", "start", "paperclip.service"], { stdio: "pipe" });
    }
    p.log.success("Paperclip service started.");
  } catch {
    p.log.error("Failed to start service. Is it installed? Run `paperclipai service install` first.");
    process.exit(1);
  }
}

function serviceStop(): void {
  let platform: SupportedPlatform;
  try {
    platform = detectPlatform();
  } catch (err) {
    p.log.error((err as Error).message);
    process.exit(1);
  }
  try {
    if (platform === "darwin") {
      execFileSync("launchctl", ["stop", LAUNCHD_LABEL], { stdio: "pipe" });
    } else {
      execFileSync("systemctl", ["--user", "stop", "paperclip.service"], { stdio: "pipe" });
    }
    p.log.success("Paperclip service stopped.");
  } catch {
    p.log.error("Failed to stop service. Is it installed? Run `paperclipai service install` first.");
    process.exit(1);
  }
}

function serviceRestart(): void {
  let platform: SupportedPlatform;
  try {
    platform = detectPlatform();
  } catch (err) {
    p.log.error((err as Error).message);
    process.exit(1);
  }
  try {
    if (platform === "darwin") {
      const uid = getUid();
      execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: "pipe" });
    } else {
      execFileSync("systemctl", ["--user", "restart", "paperclip.service"], { stdio: "pipe" });
    }
    p.log.success("Paperclip service restarted.");
  } catch (err) {
    p.log.error(`Failed to restart service: ${String((err as { stderr?: Buffer | string }).stderr ?? (err as Error).message)}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function serviceStatus(opts: ServiceStatusOptions): void {
  let platform: SupportedPlatform;
  try {
    platform = detectPlatform();
  } catch (err) {
    p.log.error((err as Error).message);
    process.exit(1);
  }

  if (platform === "darwin") {
    try {
      const raw = execFileSync("launchctl", ["list", LAUNCHD_LABEL], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (opts.json) {
        console.log(JSON.stringify({ platform: "darwin", label: LAUNCHD_LABEL, raw: raw.trim() }));
        return;
      }

      p.log.info(pc.bold("Paperclip service status (launchd)"));
      // Parse PID and status from launchctl list output
      const pidMatch = raw.match(/"PID"\s*=\s*(\d+)/);
      const statusMatch = raw.match(/"LastExitStatus"\s*=\s*(\d+)/);
      if (pidMatch) p.log.message(`PID: ${pc.green(pidMatch[1])}`);
      if (statusMatch) p.log.message(`Last exit status: ${statusMatch[1]}`);
      p.log.message(pc.dim(raw.trim()));
    } catch {
      p.log.warn("Service is not loaded. Run " + pc.bold("paperclipai service install") + " first.");
    }
  } else {
    try {
      const raw = execFileSync("systemctl", ["--user", "status", "paperclip.service"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (opts.json) {
        console.log(JSON.stringify({ platform: "linux", unit: "paperclip.service", raw: raw.trim() }));
        return;
      }

      p.log.info(pc.bold("Paperclip service status (systemd)"));
      p.log.message(raw.trim());
    } catch (err: unknown) {
      // systemctl status exits with code 3 when inactive — still has output
      const output = (err as { stdout?: string }).stdout;
      if (output) {
        if (opts.json) {
          console.log(JSON.stringify({ platform: "linux", unit: "paperclip.service", raw: output.trim() }));
          return;
        }
        p.log.info(pc.bold("Paperclip service status (systemd)"));
        p.log.message(output.trim());
      } else {
        p.log.warn("Service is not installed. Run " + pc.bold("paperclipai service install") + " first.");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

function serviceLogs(opts: ServiceLogsOptions): void {
  let platform: SupportedPlatform;
  try {
    platform = detectPlatform();
  } catch (err) {
    p.log.error((err as Error).message);
    process.exit(1);
  }

  const lines = opts.lines ?? 50;

  if (platform === "linux") {
    const args = ["--user", "-u", "paperclip.service", "-n", String(lines)];
    if (opts.follow) args.push("-f");
    try {
      execFileSync("journalctl", args, { stdio: "inherit" });
    } catch {
      // User hit Ctrl-C or journalctl not available
    }
  } else {
    if (!existsSync(SERVICE_LOG_PATH)) {
      p.log.warn(`No log file found at ${pc.dim(SERVICE_LOG_PATH)}`);
      return;
    }

    if (opts.follow) {
      try {
        execFileSync("tail", ["-n", String(lines), "-f", SERVICE_LOG_PATH], {
          stdio: "inherit",
        });
      } catch {
        // User hit Ctrl-C
      }
    } else {
      const output = execFileSync("tail", ["-n", String(lines), SERVICE_LOG_PATH], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      console.log(output);
    }
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerServiceCommands(program: Command): void {
  const service = program.command("service").description("Manage Paperclip as a persistent OS service");

  service
    .command("install")
    .description("Generate and install the OS service unit, then start it")
    .action(serviceInstall);

  service
    .command("uninstall")
    .description("Stop and remove the OS service unit")
    .action(serviceUninstall);

  service
    .command("start")
    .description("Start the Paperclip service")
    .action(serviceStart);

  service
    .command("stop")
    .description("Stop the Paperclip service")
    .action(serviceStop);

  service
    .command("restart")
    .description("Restart the Paperclip service")
    .action(serviceRestart);

  service
    .command("status")
    .description("Show service running state, PID, and uptime")
    .option("--json", "Output raw JSON")
    .action(serviceStatus);

  service
    .command("logs")
    .description("Tail the service log")
    .option("-f, --follow", "Follow log output in real time")
    .option("-n, --lines <count>", "Number of lines to show", (v) => Number(v), 50)
    .action(serviceLogs);
}
