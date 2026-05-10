import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  DEFAULT_PAPERCLIP_SPACE_ID,
  DEFAULT_SPACE_ADAPTER_LOCAL_PATH_NAMES,
  DEFAULT_SPACE_OWNED_PATH_NAMES,
  createDefaultSpaceRegistry,
  expandHomePrefix,
  isPaperclipRuntimeConfig,
  resolvePaperclipInstanceConfigPath,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
  resolvePaperclipSpacesRoot,
} from "@paperclipai/shared/space-paths";

type JsonObject = Record<string, unknown>;

export interface DefaultSpaceMigrationPlan {
  instanceId: string;
  sourceRoot: string;
  destinationRoot: string;
  legacyRuntimeConfig: boolean;
  sourcePathNames: string[];
  conflicts: Array<{ pathName: string; sourcePath: string; destinationPath: string }>;
}

export interface DefaultSpaceMigrationResult {
  status: "migrated" | "noop" | "dry_run";
  plan: DefaultSpaceMigrationPlan;
  movedPaths: string[];
  markerPath: string | null;
}

export interface MigrateDefaultSpaceOptions {
  instanceId?: string;
  dryRun?: boolean;
  skipServerCheck?: boolean;
  serverRunningCheck?: (plan: DefaultSpaceMigrationPlan) => Promise<boolean>;
}

const MIGRATION_PATH_NAMES = [
  ...DEFAULT_SPACE_OWNED_PATH_NAMES,
  ...DEFAULT_SPACE_ADAPTER_LOCAL_PATH_NAMES,
] as const;

function readJsonIfPresent(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rewriteSpaceRootString(value: string, sourceRoot: string, destinationRoot: string): string {
  const resolved = path.resolve(expandHomePrefix(value));
  if (!isPathWithin(sourceRoot, resolved)) return value;
  const relative = path.relative(path.resolve(sourceRoot), resolved);
  return path.resolve(destinationRoot, relative);
}

function rewriteConfigPaths(value: unknown, sourceRoot: string, destinationRoot: string): unknown {
  if (typeof value === "string") return rewriteSpaceRootString(value, sourceRoot, destinationRoot);
  if (Array.isArray(value)) return value.map((entry) => rewriteConfigPaths(entry, sourceRoot, destinationRoot));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, rewriteConfigPaths(entry, sourceRoot, destinationRoot)]),
  );
}

function writeJson(filePath: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function atomicWriteJson(filePath: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  writeJson(tmpPath, value, mode);
  fs.renameSync(tmpPath, filePath);
}

export function buildDefaultSpaceMigrationPlan(options: Pick<MigrateDefaultSpaceOptions, "instanceId"> = {}): DefaultSpaceMigrationPlan {
  const instanceId = resolvePaperclipInstanceId(options.instanceId);
  const sourceRoot = resolvePaperclipInstanceRoot({ instanceId });
  const destinationRoot = path.resolve(resolvePaperclipSpacesRoot({ instanceId }), DEFAULT_PAPERCLIP_SPACE_ID);
  const instanceConfigPath = resolvePaperclipInstanceConfigPath({ instanceId });
  const legacyRuntimeConfig = isPaperclipRuntimeConfig(readJsonIfPresent(instanceConfigPath));

  const sourcePathNames = MIGRATION_PATH_NAMES.filter((pathName) => {
    if (pathName === "config.json" && !legacyRuntimeConfig) return false;
    return fs.existsSync(path.join(sourceRoot, pathName));
  });

  const conflicts = sourcePathNames
    .map((pathName) => ({
      pathName,
      sourcePath: path.join(sourceRoot, pathName),
      destinationPath: path.join(destinationRoot, pathName),
    }))
    .filter((entry) => fs.existsSync(entry.destinationPath));

  return {
    instanceId,
    sourceRoot,
    destinationRoot,
    legacyRuntimeConfig,
    sourcePathNames,
    conflicts,
  };
}

function readServerEndpointFromConfig(configPath: string): { host: string; port: number } | null {
  const parsed = readJsonIfPresent(configPath);
  if (!isObject(parsed)) return null;
  const server = parsed.server;
  if (!isObject(server)) return null;
  const rawHost = typeof server.host === "string" && server.host.trim().length > 0
    ? server.host.trim()
    : "127.0.0.1";
  const host = rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
  const port = typeof server.port === "number" && Number.isInteger(server.port) ? server.port : 3100;
  if (port <= 0 || port > 65535) return null;
  return { host, port };
}

export async function defaultServerRunningCheck(plan: DefaultSpaceMigrationPlan): Promise<boolean> {
  const endpoint =
    readServerEndpointFromConfig(path.join(plan.sourceRoot, "config.json")) ??
    readServerEndpointFromConfig(path.join(plan.destinationRoot, "config.json"));
  if (!endpoint) return false;

  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(`http://${host}:${endpoint.port}/api/health`, {
      signal: controller.signal,
    });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function assertMigrationPreflight(plan: DefaultSpaceMigrationPlan): void {
  if (plan.conflicts.length === 0) return;
  const details = plan.conflicts
    .map((conflict) => `- ${conflict.pathName}: ${conflict.sourcePath} -> ${conflict.destinationPath}`)
    .join("\n");
  throw new Error(`Cannot migrate default space because destination paths already exist:\n${details}`);
}

function moveConfigWithRewrittenPaths(sourcePath: string, destinationPath: string, sourceRoot: string, destinationRoot: string): void {
  const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown;
  const rewritten = rewriteConfigPaths(parsed, sourceRoot, destinationRoot);
  atomicWriteJson(destinationPath, rewritten);
  fs.unlinkSync(sourcePath);
}

function writeMigrationMarker(plan: DefaultSpaceMigrationPlan, movedPaths: string[]): string {
  const migratedAt = new Date().toISOString();
  const registry = createDefaultSpaceRegistry("system");
  registry.$meta.updatedAt = migratedAt;
  registry.defaultSpaceMigration = {
    migratedAt,
    sourceRoot: plan.sourceRoot,
    destinationRoot: plan.destinationRoot,
    movedPaths,
  };

  const markerPath = path.join(plan.sourceRoot, "config.json");
  writeJson(markerPath, registry);
  return markerPath;
}

export async function migrateDefaultSpaceInstall(
  options: MigrateDefaultSpaceOptions = {},
): Promise<DefaultSpaceMigrationResult> {
  const plan = buildDefaultSpaceMigrationPlan(options);

  if (plan.sourcePathNames.length === 0) {
    return { status: "noop", plan, movedPaths: [], markerPath: null };
  }

  assertMigrationPreflight(plan);

  const serverRunningCheck = options.serverRunningCheck ?? defaultServerRunningCheck;
  if (!options.skipServerCheck && await serverRunningCheck(plan)) {
    throw new Error(
      `Cannot migrate default space while a Paperclip server appears to be running for ${plan.sourceRoot}. Stop Paperclip and retry.`,
    );
  }

  if (options.dryRun) {
    return { status: "dry_run", plan, movedPaths: plan.sourcePathNames, markerPath: null };
  }

  fs.mkdirSync(plan.destinationRoot, { recursive: true });
  const movedPaths: string[] = [];

  for (const pathName of plan.sourcePathNames) {
    const sourcePath = path.join(plan.sourceRoot, pathName);
    const destinationPath = path.join(plan.destinationRoot, pathName);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

    if (pathName === "config.json") {
      moveConfigWithRewrittenPaths(sourcePath, destinationPath, plan.sourceRoot, plan.destinationRoot);
    } else {
      fs.renameSync(sourcePath, destinationPath);
    }
    movedPaths.push(pathName);
  }

  const markerPath = writeMigrationMarker(plan, movedPaths);
  return { status: "migrated", plan, movedPaths, markerPath };
}

function printMigrationResult(result: DefaultSpaceMigrationResult): void {
  if (result.status === "noop") {
    console.log(pc.dim(`No legacy default-space data found under ${result.plan.sourceRoot}.`));
    return;
  }

  const verb = result.status === "dry_run" ? "Would migrate" : "Migrated";
  console.log(`${pc.green(verb)} default space:`);
  console.log(`  ${pc.dim("from")} ${result.plan.sourceRoot}`);
  console.log(`  ${pc.dim("to")}   ${result.plan.destinationRoot}`);
  for (const pathName of result.movedPaths) {
    console.log(`  ${pc.dim("-")} ${pathName}`);
  }
  if (result.markerPath) {
    console.log(`  ${pc.dim("marker")} ${result.markerPath}`);
  }
}

export function registerSpacesCommands(program: Command): void {
  const spaces = program.command("spaces").description("Manage local Paperclip spaces");

  spaces
    .command("migrate-default")
    .description("Offline migration from legacy root-shaped instance data into spaces/default")
    .option("-i, --instance <id>", "Local instance id (default: default)")
    .option("--dry-run", "Show the migration plan without moving files", false)
    .option("--skip-server-check", "Skip the local /api/health preflight", false)
    .action(async (opts: { instance?: string; dryRun?: boolean; skipServerCheck?: boolean }) => {
      const result = await migrateDefaultSpaceInstall({
        instanceId: opts.instance,
        dryRun: opts.dryRun,
        skipServerCheck: opts.skipServerCheck,
      });
      printMigrationResult(result);
    });
}
