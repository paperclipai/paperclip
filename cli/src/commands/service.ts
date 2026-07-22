import fs from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { cliVersion } from "../version.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { resolvePaperclipHomeDir, resolvePaperclipInstanceId } from "../config/home.js";
import { detectServiceManager, type ServiceManager, type ServiceStatus } from "../services/service-manager.js";

type CommonOptions = { instance?: string; json?: boolean };
type HealthResult = { ok: boolean; serverVersion: string | null; error?: string };

function output(value: unknown, json: boolean | undefined): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

async function resolveManager(opts: CommonOptions): Promise<ServiceManager | null> {
  const detection = await detectServiceManager({ instanceId: opts.instance });
  if (detection.supported) return detection.manager;
  output({ supported: false, message: detection.reason }, opts.json);
  return null;
}

function healthUrl(instanceId: string): string {
  process.env.PAPERCLIP_INSTANCE_ID = instanceId;
  const config = readConfig(resolveConfigPath());
  const port = config?.server.port ?? 3100;
  const configuredHost = config?.server.host?.trim();
  const host = !configuredHost || configuredHost === "0.0.0.0" || configuredHost === "::" ? "127.0.0.1" : configuredHost;
  return `http://${host}:${port}/api/health`;
}

async function probeHealth(instanceId: string): Promise<HealthResult> {
  try {
    const response = await fetch(healthUrl(instanceId), { signal: AbortSignal.timeout(2_000) });
    const body = await response.json() as { status?: unknown; serverVersion?: unknown; version?: unknown };
    return { ok: response.ok && body.status === "ok", serverVersion: typeof body.serverVersion === "string" ? body.serverVersion : typeof body.version === "string" ? body.version : null };
  } catch (error) {
    return { ok: false, serverVersion: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function waitForHealth(instanceId: string, expectedVersion: string | null, timeoutMs = 60_000): Promise<HealthResult> {
  const deadline = Date.now() + timeoutMs;
  let last: HealthResult = { ok: false, serverVersion: null };
  while (Date.now() < deadline) {
    last = await probeHealth(instanceId);
    if (last.ok && (!expectedVersion || last.serverVersion === expectedVersion)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Paperclip service did not become healthy${expectedVersion ? ` at version ${expectedVersion}` : ""}: ${last.error ?? `reported ${last.serverVersion ?? "no version"}`}`);
}

async function writeHotRestartIntent(status: ServiceStatus, instanceId: string, drainRequired: boolean): Promise<{ requestedAt: string; previousVersion: string }> {
  if (!status.pid) throw new Error(`Cannot restart ${status.serviceName}: supervisor did not report a server pid.`);
  const health = await probeHealth(instanceId);
  const homeDir = resolvePaperclipHomeDir();
  const requestedAt = new Date().toISOString();
  await fs.mkdir(homeDir, { recursive: true });
  await fs.rm(path.join(homeDir, "hot-restart-report.json"), { force: true });
  await fs.writeFile(path.join(homeDir, "hot-restart-intent.json"), `${JSON.stringify({
    version: 1,
    requestedAt,
    previousServerPid: status.pid,
    previousServerVersion: health.serverVersion,
    drainRequired,
    requestedByRunId: process.env.PAPERCLIP_RUN_ID?.trim() || null,
  }, null, 2)}\n`, "utf8");
  return { requestedAt, previousVersion: health.serverVersion ?? cliVersion };
}

async function waitForRestartReport(requestedAt: string, timeoutMs = 10_000): Promise<unknown | null> {
  const reportPath = path.join(resolvePaperclipHomeDir(), "hot-restart-report.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as { requestedAt?: unknown };
      if (report.requestedAt === requestedAt) return report;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

export async function restartManagedService(input: { instanceId?: string; expectedVersion?: string | null; waitForDrain?: boolean } = {}): Promise<{ status: ServiceStatus; health: HealthResult; report: unknown | null }> {
  const instanceId = resolvePaperclipInstanceId(input.instanceId);
  const detection = await detectServiceManager({ instanceId });
  if (!detection.supported) throw new Error(detection.reason);
  const before = await detection.manager.status();
  const intent = await writeHotRestartIntent(before, instanceId, input.waitForDrain ?? false);
  await detection.manager.restart();
  const health = await waitForHealth(instanceId, input.expectedVersion ?? intent.previousVersion);
  return { status: await detection.manager.status(), health, report: await waitForRestartReport(intent.requestedAt) };
}

export function registerServiceCommands(program: Command): void {
  const service = program.command("service").description("Manage Paperclip as a background service");
  const common = (command: Command) => command.option("-i, --instance <id>", "Local instance id (default: default)").option("--json", "Print machine-readable JSON", false);

  common(service.command("install").description("Install and register the background service"))
    .option("--no-start-now", "Install without starting now")
    .option("--no-start-on-login", "Install without enabling start on login")
    .option("--enable-linger", "Allow systemd startup without an active login session", false)
    .action(async (opts) => {
      const manager = await resolveManager(opts); if (!manager) return;
      const result = await manager.install({ startNow: opts.startNow, startOnLogin: opts.startOnLogin });
      let lingerEnabled = false;
      if (manager.enableLinger) {
        let consent = opts.enableLinger === true;
        if (!consent && process.stdin.isTTY && process.stdout.isTTY) {
          consent = await p.confirm({ message: "Allow Paperclip to run without an active login session? This runs 'loginctl enable-linger' for your user and may request system authorization.", initialValue: false }) === true;
        }
        if (consent) { await manager.enableLinger(); lingerEnabled = true; }
      }
      output({ installed: true, changed: result.changed, platform: manager.platform, serviceName: manager.serviceName, definitionPath: manager.definitionPath, lingerEnabled }, opts.json);
    });

  common(service.command("uninstall").description("Stop, disable, and remove the background service")).action(async (opts) => {
    const manager = await resolveManager(opts); if (!manager) return;
    await manager.uninstall();
    const status = await manager.status();
    if (status.installed || status.active) throw new Error(`${manager.serviceName} is still loaded after uninstall.`);
    output({ uninstalled: true, serviceName: manager.serviceName }, opts.json);
  });

  for (const verb of ["start", "stop"] as const) {
    common(service.command(verb).description(`${verb === "start" ? "Start" : "Stop"} the background service`)).action(async (opts) => {
      const manager = await resolveManager(opts); if (!manager) return;
      await manager[verb]();
      output(await manager.status(), opts.json);
    });
  }

  common(service.command("restart").description("Hot-restart the service while preserving active agent runs"))
    .option("--wait", "Wait for active runs to drain instead of adopting them", false)
    .option("--expected-version <version>", "Require the restarted server to report this version")
    .action(async (opts) => output(await restartManagedService({ instanceId: opts.instance, expectedVersion: opts.expectedVersion, waitForDrain: opts.wait }), opts.json));

  common(service.command("status").description("Show supervisor and health status")).action(async (opts) => {
    const manager = await resolveManager(opts); if (!manager) return;
    const instanceId = resolvePaperclipInstanceId(opts.instance);
    output({ ...await manager.status(), health: await probeHealth(instanceId) }, opts.json);
  });

  common(service.command("logs").description("Show service logs"))
    .option("-f, --follow", "Follow new log output", false)
    .option("-n, --lines <count>", "Number of recent lines", "100")
    .action(async (opts) => {
      const manager = await resolveManager(opts); if (!manager) return;
      const lines = Number.parseInt(opts.lines, 10);
      if (!Number.isInteger(lines) || lines < 1) throw new Error("--lines must be a positive integer.");
      await manager.logs(opts.follow, lines);
    });
}
