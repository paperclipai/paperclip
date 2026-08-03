import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrapCeoInvite } from "./auth-bootstrap-ceo.js";
import { onboard } from "./onboard.js";
import { doctor } from "./doctor.js";
import { loadPaperclipEnvFile } from "../config/env.js";
import { configExists, resolveConfigPath } from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";
import { readConfig } from "../config/store.js";
import {
  describeLocalInstancePaths,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";
import { assertForegroundRunAllowed } from "../services/service-manager.js";
import { printUpdateNotice } from "../update-notice.js";
import { ensureWorktreeSeeded } from "./worktree.js";

interface RunOptions {
  config?: string;
  instance?: string;
  repair?: boolean;
  yes?: boolean;
  bind?: "loopback" | "lan" | "tailnet";
  force?: boolean;
}

interface StartedServer {
  apiUrl: string;
  databaseUrl: string;
  host: string;
  listenPort: number;
}

type WindowsRunShutdownSignal = "SIGINT" | "SIGTERM" | "SIGBREAK";
type WindowsRunSupervisorMessage = {
  type: "paperclip-windows-run-shutdown";
  signal: WindowsRunShutdownSignal;
};

const WINDOWS_RUN_CHILD_ENV = "PAPERCLIP_WINDOWS_RUN_CHILD";
const WINDOWS_RUN_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK"] as const;
let windowsRunShutdownListenerInstalled = false;
let pendingWindowsRunShutdownSignal: WindowsRunShutdownSignal | null = null;
let windowsRunShutdownRequest: ((signal: WindowsRunShutdownSignal) => boolean) | null = null;

function isWindowsRunSupervisorMessage(message: unknown): message is WindowsRunSupervisorMessage {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return record.type === "paperclip-windows-run-shutdown"
    && WINDOWS_RUN_SHUTDOWN_SIGNALS.includes(record.signal as WindowsRunShutdownSignal);
}

function installWindowsRunChildShutdownListener(): void {
  if (windowsRunShutdownListenerInstalled || process.env[WINDOWS_RUN_CHILD_ENV] !== "1") return;
  windowsRunShutdownListenerInstalled = true;
  const requestOrQueue = (signal: WindowsRunShutdownSignal) => {
    if (!windowsRunShutdownRequest?.(signal)) pendingWindowsRunShutdownSignal = signal;
  };
  process.on("message", (message: unknown) => {
    if (!isWindowsRunSupervisorMessage(message)) return;
    requestOrQueue(message.signal);
  });
  // Windows .cmd launchers may be terminated by a console-control broadcast
  // before their Node signal listener can forward it. The detached server child
  // observes that loss through IPC and still enters the normal shutdown path.
  process.on("disconnect", () => requestOrQueue("SIGBREAK"));
}

function attachWindowsRunShutdownRequest(request: (signal: WindowsRunShutdownSignal) => boolean): void {
  windowsRunShutdownRequest = request;
  if (!pendingWindowsRunShutdownSignal) return;
  const signal = pendingWindowsRunShutdownSignal;
  if (request(signal)) pendingWindowsRunShutdownSignal = null;
}

type WindowsRunSupervisorProcess = Pick<
  NodeJS.Process,
  "argv" | "execArgv" | "execPath" | "env" | "on" | "off"
>;

export async function superviseWindowsRun(
  input: {
    process?: WindowsRunSupervisorProcess;
    spawnChild?: typeof spawn;
  } = {},
): Promise<void> {
  const supervisorProcess = input.process ?? process;
  const spawnChild = input.spawnChild ?? spawn;
  const child = spawnChild(
    supervisorProcess.execPath,
    [...supervisorProcess.execArgv, ...supervisorProcess.argv.slice(1)],
    {
      detached: true,
      windowsHide: true,
      env: { ...supervisorProcess.env, [WINDOWS_RUN_CHILD_ENV]: "1" },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    },
  );

  await new Promise<void>((resolve, reject) => {
    const handlers = new Map<WindowsRunShutdownSignal, () => void>();
    const cleanup = () => {
      for (const [signal, handler] of handlers) supervisorProcess.off(signal, handler);
    };
    for (const signal of WINDOWS_RUN_SHUTDOWN_SIGNALS) {
      const handler = () => {
        if (!child.connected || typeof child.send !== "function") return;
        child.send({ type: "paperclip-windows-run-shutdown", signal } satisfies WindowsRunSupervisorMessage);
      };
      handlers.set(signal, handler);
      supervisorProcess.on(signal, handler);
    }
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`Windows Paperclip run child exited with ${signal ?? `code ${code ?? "unknown"}`}`));
    });
  });
}

export async function runCommand(opts: RunOptions): Promise<void> {
  if (process.platform === "win32" && process.env[WINDOWS_RUN_CHILD_ENV] !== "1") {
    await superviseWindowsRun();
    return;
  }
  installWindowsRunChildShutdownListener();
  const instanceId = resolvePaperclipInstanceId(opts.instance);
  process.env.PAPERCLIP_INSTANCE_ID = instanceId;
  await assertForegroundRunAllowed(instanceId, opts.force);

  const homeDir = resolvePaperclipHomeDir();
  fs.mkdirSync(homeDir, { recursive: true });

  const paths = describeLocalInstancePaths(instanceId);
  fs.mkdirSync(paths.instanceRoot, { recursive: true });

  const configPath = resolveConfigPath(opts.config);
  process.env.PAPERCLIP_CONFIG = configPath;
  loadPaperclipEnvFile(configPath);
  await printUpdateNotice(configPath);

  p.intro(pc.bgCyan(pc.black(" paperclipai run ")));
  p.log.message(pc.dim(`Home: ${paths.homeDir}`));
  p.log.message(pc.dim(`Instance: ${paths.instanceId}`));
  p.log.message(pc.dim(`Config: ${configPath}`));

  if (!configExists(configPath)) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      p.log.error("No config found and terminal is non-interactive.");
      p.log.message(`Run ${pc.cyan("paperclipai onboard")} once, then retry ${pc.cyan("paperclipai run")}.`);
      process.exit(1);
    }

    p.log.step("No config found. Starting onboarding...");
    await onboard({ config: configPath, invokedByRun: true, bind: opts.bind });
  }

  const seedResult = await ensureWorktreeSeeded({ config: configPath });
  if (seedResult.seeded) {
    p.log.success("Completed deferred worktree database seed.");
  }

  p.log.step("Running doctor checks...");
  const summary = await doctor({
    config: configPath,
    repair: opts.repair ?? true,
    yes: opts.yes ?? true,
  });

  if (summary.failed > 0) {
    p.log.error("Doctor found blocking issues. Not starting server.");
    process.exit(1);
  }

  const config = readConfig(configPath);
  if (!config) {
    p.log.error(`No config found at ${configPath}.`);
    process.exit(1);
  }

  p.log.step("Starting Paperclip server...");
  const startedServer = await importServerEntry();

  if (shouldGenerateBootstrapInviteAfterStart(config)) {
    p.log.step("Generating bootstrap CEO invite");
    await bootstrapCeoInvite({
      config: configPath,
      dbUrl: startedServer.databaseUrl,
      baseUrl: resolveBootstrapInviteBaseUrl(config, startedServer),
    });
  }
}

function resolveBootstrapInviteBaseUrl(
  config: PaperclipConfig,
  startedServer: StartedServer,
): string {
  const explicitBaseUrl =
    process.env.PAPERCLIP_PUBLIC_URL ??
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL ??
    (config.auth.baseUrlMode === "explicit" ? config.auth.publicBaseUrl : undefined);

  if (typeof explicitBaseUrl === "string" && explicitBaseUrl.trim().length > 0) {
    return explicitBaseUrl.trim().replace(/\/+$/, "");
  }

  return startedServer.apiUrl.replace(/\/api$/, "");
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message && err.message.trim().length > 0) return err.message;
    return err.name;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isModuleNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND") return true;
  return err.message.includes("Cannot find module");
}

function getMissingModuleSpecifier(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const packageMatch = err.message.match(/Cannot find package '([^']+)' imported from/);
  if (packageMatch?.[1]) return packageMatch[1];
  const moduleMatch = err.message.match(/Cannot find module '([^']+)'/);
  if (moduleMatch?.[1]) return moduleMatch[1];
  return null;
}

function maybeEnableUiDevMiddleware(entrypoint: string): void {
  if (process.env.PAPERCLIP_UI_DEV_MIDDLEWARE !== undefined) return;
  const normalized = entrypoint.replaceAll("\\", "/");
  if (normalized.endsWith("/server/src/index.ts") || normalized.endsWith("@paperclipai/server/src/index.ts")) {
    process.env.PAPERCLIP_UI_DEV_MIDDLEWARE = "true";
  }
}

function ensureDevWorkspaceBuildDeps(projectRoot: string): void {
  const buildScript = path.resolve(projectRoot, "scripts/ensure-plugin-build-deps.mjs");
  if (!fs.existsSync(buildScript)) return;

  const result = spawnSync(process.execPath, [buildScript], {
    cwd: projectRoot,
    stdio: "inherit",
    timeout: 120_000,
  });

  if (result.error) {
    throw new Error(
      `Failed to prepare workspace build artifacts before starting the Paperclip dev server.\n${formatError(result.error)}`,
    );
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(
      "Failed to prepare workspace build artifacts before starting the Paperclip dev server.",
    );
  }
}

async function importServerEntry(): Promise<StartedServer> {
  // Dev mode: try local workspace path (monorepo with tsx)
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const devEntry = path.resolve(projectRoot, "server/src/index.ts");
  if (fs.existsSync(devEntry)) {
    ensureDevWorkspaceBuildDeps(projectRoot);
    maybeEnableUiDevMiddleware(devEntry);
    const mod = await import(pathToFileURL(devEntry).href);
    return await startServerFromModule(mod, devEntry);
  }

  // Production mode: import the published @paperclipai/server package
  try {
    const mod = await import("@paperclipai/server");
    return await startServerFromModule(mod, "@paperclipai/server");
  } catch (err) {
    const missingSpecifier = getMissingModuleSpecifier(err);
    const missingServerEntrypoint = !missingSpecifier || missingSpecifier === "@paperclipai/server";
    if (isModuleNotFoundError(err) && missingServerEntrypoint) {
      throw new Error(
        `Could not locate a Paperclip server entrypoint.\n` +
          `Tried: ${devEntry}, @paperclipai/server\n` +
          `${formatError(err)}`,
      );
    }
    throw new Error(
      `Paperclip server failed to start.\n` +
        `${formatError(err)}`,
    );
  }
}

function shouldGenerateBootstrapInviteAfterStart(config: PaperclipConfig): boolean {
  return config.server.deploymentMode === "authenticated" && config.database.mode === "embedded-postgres";
}

async function startServerFromModule(mod: unknown, label: string): Promise<StartedServer> {
  const serverModule = mod as {
    startServer?: () => Promise<StartedServer>;
    requestServerShutdown?: (signal: WindowsRunShutdownSignal) => boolean;
  };
  const startServer = serverModule.startServer;
  if (typeof startServer !== "function") {
    throw new Error(`Paperclip server entrypoint did not export startServer(): ${label}`);
  }
  const startedServer = await startServer();
  if (process.env[WINDOWS_RUN_CHILD_ENV] === "1") {
    if (typeof serverModule.requestServerShutdown !== "function") {
      throw new Error(`Paperclip server entrypoint does not support Windows supervisor shutdown: ${label}`);
    }
    attachWindowsRunShutdownRequest(serverModule.requestServerShutdown);
  }
  return startedServer;
}
