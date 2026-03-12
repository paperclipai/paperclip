import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PROFILE_RELATIVE_PATH = path.join(".paperclip", "local-start.json");
const READY_STATE_DIR = path.join(".paperclip", "launch-state");
const DEFAULT_INSTANCE_ID = "default";

export class StartupContextError extends Error {}

export function expandHomePrefix(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

function normalizePath(value) {
  return path.resolve(expandHomePrefix(value.trim()));
}

function defaultPaperclipHome() {
  return path.resolve(os.homedir(), ".paperclip");
}

function defaultInstanceId(env = process.env) {
  return env.PAPERCLIP_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
}

function resolveDefaultConfigPath(paperclipHome, instanceId) {
  return path.resolve(paperclipHome, "instances", instanceId, "config.json");
}

function inferFromConfigPath(configPath) {
  const normalized = normalizePath(configPath);
  const segments = normalized.split(path.sep).filter(Boolean);
  const configIndex = segments.lastIndexOf("config.json");
  const instancesIndex = segments.lastIndexOf("instances");
  if (configIndex === -1 || instancesIndex === -1 || configIndex !== segments.length - 1) {
    return null;
  }
  if (instancesIndex + 2 !== configIndex) return null;
  const instanceId = segments[instancesIndex + 1];
  const homeSegments = segments.slice(0, instancesIndex);
  const prefix = path.isAbsolute(normalized) ? path.sep : "";
  const paperclipHome = path.resolve(prefix, ...homeSegments);
  return {
    paperclipHome,
    instanceId,
    configPath: normalized,
  };
}

export function resolveStartupProfilePath(repoRoot) {
  return path.resolve(repoRoot, PROFILE_RELATIVE_PATH);
}

export async function readStartupProfile(repoRoot) {
  const filePath = resolveStartupProfilePath(repoRoot);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (
      typeof parsed.paperclipHome !== "string" ||
      typeof parsed.instanceId !== "string" ||
      typeof parsed.configPath !== "string"
    ) {
      return null;
    }
    return {
      paperclipHome: normalizePath(parsed.paperclipHome),
      instanceId: parsed.instanceId.trim() || DEFAULT_INSTANCE_ID,
      configPath: normalizePath(parsed.configPath),
      lastUsedAt: typeof parsed.lastUsedAt === "string" ? parsed.lastUsedAt : null,
      filePath,
    };
  } catch {
    return null;
  }
}

export async function writeStartupProfile(repoRoot, context) {
  const filePath = resolveStartupProfilePath(repoRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        paperclipHome: context.paperclipHome,
        instanceId: context.instanceId,
        configPath: context.configPath,
        lastUsedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return filePath;
}

export async function clearStartupProfile(repoRoot) {
  await rm(resolveStartupProfilePath(repoRoot), { force: true });
}

export function resolveExplicitStartupContext(env = process.env) {
  const explicitHome = env.PAPERCLIP_HOME?.trim();
  const explicitConfig = env.PAPERCLIP_CONFIG?.trim();
  const explicitInstance = env.PAPERCLIP_INSTANCE_ID?.trim();
  if (!explicitHome && !explicitConfig && !explicitInstance) return null;

  if (explicitConfig) {
    const inferred = inferFromConfigPath(explicitConfig);
    return {
      paperclipHome: normalizePath(explicitHome || inferred?.paperclipHome || defaultPaperclipHome()),
      instanceId: explicitInstance || inferred?.instanceId || DEFAULT_INSTANCE_ID,
      configPath: normalizePath(explicitConfig),
      source: "env",
    };
  }

  const paperclipHome = normalizePath(explicitHome || defaultPaperclipHome());
  const instanceId = explicitInstance || DEFAULT_INSTANCE_ID;
  return {
    paperclipHome,
    instanceId,
    configPath: resolveDefaultConfigPath(paperclipHome, instanceId),
    source: "env",
  };
}

function defaultChoice(env = process.env) {
  const paperclipHome = defaultPaperclipHome();
  const instanceId = defaultInstanceId(env);
  return {
    paperclipHome,
    instanceId,
    configPath: resolveDefaultConfigPath(paperclipHome, instanceId),
  };
}

function formatContextCommand(context, modeLabel) {
  const envPrefix = [
    `PAPERCLIP_HOME=${JSON.stringify(context.paperclipHome)}`,
    `PAPERCLIP_INSTANCE_ID=${JSON.stringify(context.instanceId)}`,
    `PAPERCLIP_CONFIG=${JSON.stringify(context.configPath)}`,
  ].join(" ");
  return `${envPrefix} pnpm ${modeLabel}`;
}

function formatPreflightFailure({ modeLabel, repoRoot }) {
  const chooseCommand = `pnpm ${modeLabel} --choose-startup`;
  return [
    `[paperclip] Startup context is ambiguous for ${repoRoot}.`,
    `Run ${chooseCommand} in a TTY to save the correct repo-local startup profile,`,
    "or start once with explicit PAPERCLIP_HOME / PAPERCLIP_INSTANCE_ID / PAPERCLIP_CONFIG.",
  ].join("\n");
}

async function promptForInput(rl, message, initialValue = "") {
  const answer = (await rl.question(initialValue ? `${message} [${initialValue}]: ` : `${message}: `)).trim();
  return answer || initialValue;
}

async function promptForStartupContext({ env = process.env, modeLabel, repoRoot }) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new StartupContextError(formatPreflightFailure({ modeLabel, repoRoot }));
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const defaultContext = defaultChoice(env);
    for (;;) {
      stdout.write(
        [
          "",
          `[paperclip] Choose startup context for ${repoRoot}`,
          `1) Default instance (${defaultContext.configPath})`,
          "2) Custom PAPERCLIP_HOME",
          "3) Custom PAPERCLIP_CONFIG",
          "4) Cancel",
          "",
        ].join("\n"),
      );
      const choice = (await rl.question("Select 1-4: ")).trim();

      if (choice === "1") {
        return defaultContext;
      }

      if (choice === "2") {
        const homeValue = await promptForInput(rl, "PAPERCLIP_HOME", "~/paperclip");
        const instanceId = await promptForInput(rl, "PAPERCLIP_INSTANCE_ID", defaultInstanceId(env));
        const paperclipHome = normalizePath(homeValue);
        const configPath = resolveDefaultConfigPath(paperclipHome, instanceId);
        if (!existsSync(configPath)) {
          stdout.write(`[paperclip] Config not found at ${configPath}\n`);
          continue;
        }
        return { paperclipHome, instanceId, configPath };
      }

      if (choice === "3") {
        const configValue = await promptForInput(
          rl,
          "PAPERCLIP_CONFIG",
          path.resolve(os.homedir(), "paperclip", "instances", DEFAULT_INSTANCE_ID, "config.json"),
        );
        const configPath = normalizePath(configValue);
        if (!existsSync(configPath)) {
          stdout.write(`[paperclip] Config not found at ${configPath}\n`);
          continue;
        }
        const inferred = inferFromConfigPath(configPath);
        if (inferred) return inferred;

        const homeValue = await promptForInput(rl, "PAPERCLIP_HOME", "~/paperclip");
        const instanceId = await promptForInput(rl, "PAPERCLIP_INSTANCE_ID", defaultInstanceId(env));
        return {
          paperclipHome: normalizePath(homeValue),
          instanceId,
          configPath,
        };
      }

      if (choice === "4") {
        throw new StartupContextError("Startup cancelled.");
      }

      stdout.write("[paperclip] Choose 1, 2, 3, or 4.\n");
    }
  } finally {
    rl.close();
  }
}

export function consumeStartupFlags(args) {
  let chooseStartup = false;
  let clearStartup = false;
  const forwarded = [];
  for (const arg of args) {
    if (arg === "--choose-startup") {
      chooseStartup = true;
      continue;
    }
    if (arg === "--clear-startup-profile") {
      clearStartup = true;
      continue;
    }
    forwarded.push(arg);
  }
  return {
    chooseStartup,
    clearStartup,
    forwarded,
  };
}

export async function resolveStartupContext({
  repoRoot,
  env = process.env,
  modeLabel,
  chooseStartup = false,
  clearStartup = false,
}) {
  if (clearStartup) {
    await clearStartupProfile(repoRoot);
  }

  const explicit = resolveExplicitStartupContext(env);
  if (explicit) {
    return {
      ...explicit,
      profilePath: resolveStartupProfilePath(repoRoot),
    };
  }

  // Repo-local startup profiles keep dual-repo workflows deterministic after
  // the first explicit selection.
  const existingProfile = !chooseStartup ? await readStartupProfile(repoRoot) : null;
  if (existingProfile && existsSync(existingProfile.configPath)) {
    return {
      paperclipHome: existingProfile.paperclipHome,
      instanceId: existingProfile.instanceId,
      configPath: existingProfile.configPath,
      source: "repo_profile",
      profilePath: existingProfile.filePath,
    };
  }

  const chosen = await promptForStartupContext({ env, modeLabel, repoRoot });
  const profilePath = await writeStartupProfile(repoRoot, chosen);
  return {
    ...chosen,
    source: "interactive",
    profilePath,
  };
}

export function formatStartupContextSummary(context) {
  return [
    `[paperclip] startup source: ${context.source}`,
    `[paperclip] PAPERCLIP_HOME=${context.paperclipHome}`,
    `[paperclip] PAPERCLIP_INSTANCE_ID=${context.instanceId}`,
    `[paperclip] PAPERCLIP_CONFIG=${context.configPath}`,
  ].join("\n");
}

function resolveLaunchHistoryPath(context) {
  return path.resolve(
    context.paperclipHome,
    "instances",
    context.instanceId,
    "logs",
    "launch-history.jsonl",
  );
}

function resolveReadyFilePath(repoRoot, launchId) {
  return path.resolve(repoRoot, READY_STATE_DIR, `${launchId}.json`);
}

async function appendLaunchHistoryRecord(filePath, record) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`);
}

export function createLaunchAttempt({ repoRoot, context, modeLabel, rawArgs }) {
  const launchId = randomUUID();
  const historyFilePath = resolveLaunchHistoryPath(context);
  const readyFilePath = resolveReadyFilePath(repoRoot, launchId);
  // Keep the recorded command operator-facing so doctor output matches what
  // the user actually typed at the repo root.
  const command = `pnpm ${modeLabel}${rawArgs.length > 0 ? ` ${rawArgs.join(" ")}` : ""}`;
  const baseRecord = {
    launchId,
    command,
    cwd: process.cwd(),
    repoPath: repoRoot,
    paperclipHome: context.paperclipHome,
    instanceId: context.instanceId,
    configPath: context.configPath,
    startupSource: context.source,
  };
  return {
    launchId,
    historyFilePath,
    readyFilePath,
    baseRecord,
  };
}

export async function recordPreflightFailure(attempt, error) {
  await appendLaunchHistoryRecord(attempt.historyFilePath, {
    ...attempt.baseRecord,
    recordedAt: new Date().toISOString(),
    databaseRef: null,
    result: "failed",
    failureMessage: error instanceof Error ? error.message : String(error),
  });
}

export async function recordStartupFailureIfNeeded(attempt, error) {
  if (existsSync(attempt.readyFilePath)) return;
  await recordPreflightFailure(attempt, error);
}

export function buildLaunchEnv(attempt) {
  return {
    PAPERCLIP_LAUNCH_ID: attempt.launchId,
    PAPERCLIP_LAUNCH_HISTORY_FILE: attempt.historyFilePath,
    PAPERCLIP_LAUNCH_READY_FILE: attempt.readyFilePath,
    PAPERCLIP_LAUNCH_CONTEXT: JSON.stringify(attempt.baseRecord),
  };
}

export function formatStartupRepairHint({ modeLabel, context }) {
  return [
    formatPreflightFailure({ modeLabel, repoRoot: process.cwd() }),
    context ? `Example: ${formatContextCommand(context, modeLabel)}` : null,
  ].filter(Boolean).join("\n");
}
