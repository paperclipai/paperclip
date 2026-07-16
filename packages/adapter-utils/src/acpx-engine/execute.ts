import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  AdapterBillingType,
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetSessionIdentity,
  formatAdapterExecutionTimeoutErrorMessage,
  formatAdapterExecutionTimeoutStartLogLine,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeout,
  startAdapterExecutionTargetPaperclipBridge,
  startAdapterExecutionTargetProcessSessionBridge,
  type AdapterExecutionTargetPaperclipBridgeHandle,
  type AdapterExecutionTargetProcessSessionBridgeHandle,
  type AdapterExecutionTargetTimeoutResolution,
} from "@paperclipai/adapter-utils/execution-target";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  applyPaperclipWorkspaceEnv,
  asNumber,
  asString,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  ensurePaperclipSkillSymlink,
  isPaperclipRuntimeEnvKey,
  joinPromptSections,
  materializePaperclipSkillCopy,
  parseObject,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolvePaperclipInstanceRootForAdapter,
  resolvePaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  rewriteWorkspaceCwdEnvVarsForExecution,
  shapePaperclipWorkspaceEnvForExecution,
  stringifyPaperclipWakePayload,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  isAcpRuntimeError,
  type AcpAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
  type AcpRuntimeTurn,
  type AcpRuntimeTurnResult,
  type AcpRuntimeUsageBreakdown,
  type AcpRuntimeUsageCost,
} from "acpx/runtime";
import {
  DEFAULT_ACP_ENGINE_AGENT,
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_PERMISSION_MODE,
  DEFAULT_ACP_ENGINE_TIMEOUT_SEC,
  DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
} from "./constants.js";

const defaultModuleDir = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER_CLEANUP_RETENTION_MS = 15 * 60 * 1000;
const PAPERCLIP_MANAGED_CODEX_SKILLS_MANIFEST = ".paperclip-managed-skills.json";

type AcpxRuntimeFactory = (options: AcpRuntimeOptions) => AcpRuntime;

export interface RuntimeCacheEntry {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  fingerprint: string;
  lastUsedAt: number;
  cleanupTimer?: NodeJS.Timeout;
}

interface AcpxEngineSettings {
  adapterType: string;
  moduleDir: string;
  packageRootDir: string;
}

export interface AcpxEngineBillingIdentity {
  provider?: string | null;
  biller?: string | null;
  billingType?: AdapterBillingType | null;
}

export interface AcpxEngineExecutorOptions {
  createRuntime?: AcpxRuntimeFactory;
  now?: () => number;
  warmHandles?: Map<string, RuntimeCacheEntry>;
  adapterType?: string;
  moduleDir?: string;
  packageRootDir?: string;
  /**
   * Adapter-specific billing classification (provider/biller/billingType) for
   * cost-ledger attribution. Without it, results fall back to the opaque
   * "acpx" provider and an "unknown" billing type.
   */
  resolveBillingIdentity?: (
    ctx: AdapterExecutionContext,
  ) => AcpxEngineBillingIdentity | null | Promise<AcpxEngineBillingIdentity | null>;
}

interface AcpxPreparedRuntime {
  acpxAgent: string;
  mode: "persistent" | "oneshot";
  cwd: string;
  workspaceId: string;
  workspaceRepoUrl: string;
  workspaceRepoRef: string;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  stateDir: string;
  permissionMode: "approve-all" | "approve-reads" | "deny-all";
  nonInteractivePermissions: "deny" | "fail";
  requestedModel: string;
  requestedThinkingEffort: string;
  fastMode: boolean;
  timeoutSec: number;
  timeoutResolution: AdapterExecutionTargetTimeoutResolution;
  sessionKey: string;
  fingerprint: string;
  agentCommand: string | null;
  agentRegistry: AcpAgentRegistry;
  processSessionBridge: AdapterExecutionTargetProcessSessionBridgeHandle | null;
  paperclipBridge: AdapterExecutionTargetPaperclipBridgeHandle | null;
  remoteExecutionIdentity: Record<string, unknown> | null;
  skillPromptInstructions: string;
  skillsIdentity: Record<string, unknown>;
  childStderrLogPath: string | null;
  paperclipClaudeSettings: PaperclipClaudeSettingsResult | null;
  mcpServers: NonNullable<AcpRuntimeOptions["mcpServers"]>;
  mcpIdentity: Array<{ name: string; url: string; connectionId: string }>;
}

const defaultWarmHandles = new Map<string, RuntimeCacheEntry>();

function resolveEngineSettings(options: AcpxEngineExecutorOptions): AcpxEngineSettings {
  const moduleDir = path.resolve(options.moduleDir ?? defaultModuleDir);
  return {
    adapterType: options.adapterType?.trim() || "acp_engine",
    moduleDir,
    packageRootDir: path.resolve(options.packageRootDir ?? path.resolve(moduleDir, "../..")),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

function defaultPaperclipInstanceDir(): string {
  const home = process.env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip");
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  return resolvePaperclipInstanceRootForAdapter({
    homeDir: home,
    instanceId,
  });
}

function defaultStateDir(companyId: string, agentId: string): string {
  return path.join(defaultPaperclipInstanceDir(), "companies", companyId, "acp-engine", "agents", agentId);
}

function resolveManagedCodexHomeDir(companyId: string): string {
  return path.join(defaultPaperclipInstanceDir(), "companies", companyId, "codex-home");
}

// Walk up from startDir looking for `node_modules/.bin/<binName>`. This matches
// npm/pnpm binary hoisting in packaged installs while preserving monorepo dev.
export async function findAncestorBin(startDir: string, binName: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, "node_modules", ".bin", binName);
    if (await pathExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

interface BuiltInAgentCommand {
  command: string;
  shellCommand: string;
}

async function resolveBuiltInAgentCommand(input: {
  agent: string;
  packageRootDir: string;
  executionTargetIsRemote: boolean;
}): Promise<BuiltInAgentCommand | null> {
  const { agent, packageRootDir, executionTargetIsRemote } = input;
  if (agent === "gemini") {
    return { command: "gemini --acp", shellCommand: "gemini --acp" };
  }
  const binName = agent === "claude" ? "claude-agent-acp" : agent === "codex" ? "codex-acp" : null;
  if (!binName) return null;
  if (executionTargetIsRemote) {
    return { command: binName, shellCommand: binName };
  }
  const resolved = (await findAncestorBin(packageRootDir, binName)) ?? binName;
  return { command: resolved, shellCommand: shellQuote(resolved) };
}

const execFileAsync = promisify(execFile);
// Gemini CLI renamed --experimental-acp to --acp in 0.33.0. acpx normally
// rewrites the flag itself, but the agent wrapper script hides the gemini
// command from acpx's detection, so the engine must downgrade it here.
const GEMINI_NATIVE_ACP_FLAG_MIN_VERSION = [0, 33, 0] as const;
const GEMINI_VERSION_PROBE_TIMEOUT_MS = 2000;

export function parseGeminiVersionParts(output: string | null | undefined): number[] | null {
  const match = output?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function geminiVersionSupportsNativeAcpFlag(parts: number[] | null): boolean {
  if (!parts) return true;
  for (let index = 0; index < GEMINI_NATIVE_ACP_FLAG_MIN_VERSION.length; index += 1) {
    const diff = (parts[index] ?? 0) - GEMINI_NATIVE_ACP_FLAG_MIN_VERSION[index];
    if (diff !== 0) return diff > 0;
  }
  return true;
}

export function rewriteGeminiAcpFlagForVersion(commandShell: string, versionParts: number[] | null): string {
  if (geminiVersionSupportsNativeAcpFlag(versionParts)) return commandShell;
  return commandShell
    .trim()
    .split(/\s+/)
    .map((token) => (token === "--acp" ? "--experimental-acp" : token))
    .join(" ");
}

function geminiAcpCommandTokens(commandShell: string): string[] | null {
  const tokens = commandShell.trim().split(/\s+/);
  const bin = tokens[0];
  if (!bin || bin.startsWith("'") || bin.startsWith('"')) return null;
  if (path.basename(bin) !== "gemini") return null;
  if (!tokens.includes("--acp")) return null;
  return tokens;
}

async function normalizeGeminiAcpCommandShell(commandShell: string, env: NodeJS.ProcessEnv): Promise<string> {
  const tokens = geminiAcpCommandTokens(commandShell);
  if (!tokens) return commandShell;
  let versionParts: number[] | null = null;
  try {
    const { stdout } = await execFileAsync(tokens[0], ["--version"], {
      timeout: GEMINI_VERSION_PROBE_TIMEOUT_MS,
      encoding: "utf8",
      env,
    });
    versionParts = parseGeminiVersionParts(stdout);
  } catch {
    return commandShell;
  }
  return rewriteGeminiAcpFlagForVersion(commandShell, versionParts);
}

function normalizeAgent(config: Record<string, unknown>): string {
  const agent = asString(config.agent, DEFAULT_ACP_ENGINE_AGENT).trim();
  return agent || DEFAULT_ACP_ENGINE_AGENT;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function writeFileAtomically(input: {
  target: string;
  contents: string;
  mode: number;
}): Promise<void> {
  await ensureParentDir(input.target);
  const tempPath = `${input.target}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await fs.open(tempPath, "wx", input.mode);
  try {
    await handle.writeFile(input.contents, "utf8");
    await handle.close();
    await fs.rename(tempPath, input.target);
    await fs.chmod(input.target, input.mode).catch(() => {});
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function ensureSymlink(target: string, source: string): Promise<void> {
  const resolvedSource = path.resolve(source);
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await fs.symlink(resolvedSource, target);
    return;
  }

  if (!existing.isSymbolicLink()) {
    await fs.rm(target, { recursive: true, force: true });
    await fs.symlink(resolvedSource, target);
    return;
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return;

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === resolvedSource) return;

  await fs.unlink(target);
  await fs.symlink(resolvedSource, target);
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  if (await pathExists(target)) return;
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

async function prepareManagedCodexHome(input: {
  companyId: string;
  sourceHome: string;
  targetHome: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<string> {
  const { sourceHome, targetHome, onLog } = input;
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return targetHome;

  await fs.mkdir(targetHome, { recursive: true });

  const authJson = path.join(sourceHome, "auth.json");
  if (await pathExists(authJson)) await ensureSymlink(path.join(targetHome, "auth.json"), authJson);

  for (const name of ["config.json", "config.toml", "instructions.md"]) {
    const source = path.join(sourceHome, name);
    if (await pathExists(source)) await ensureCopiedFile(path.join(targetHome, name), source);
  }

  await onLog(
    "stdout",
    `[paperclip] Using Paperclip-managed ACPX Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}

async function hashPathContents(
  candidate: string,
  hash: ReturnType<typeof createHash>,
  relativePath: string,
  seenDirectories: Set<string>,
): Promise<void> {
  const stat = await fs.lstat(candidate);

  if (stat.isSymbolicLink()) {
    hash.update(`symlink-skipped:${relativePath}\n`);
    return;
  }

  if (stat.isDirectory()) {
    const realDir = await fs.realpath(candidate).catch(() => candidate);
    hash.update(`dir:${relativePath}\n`);
    if (seenDirectories.has(realDir)) {
      hash.update("loop\n");
      return;
    }
    seenDirectories.add(realDir);
    const entries = await fs.readdir(candidate, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelativePath = relativePath.length > 0 ? `${relativePath}/${entry.name}` : entry.name;
      await hashPathContents(path.join(candidate, entry.name), hash, childRelativePath, seenDirectories);
    }
    return;
  }

  if (stat.isFile()) {
    hash.update(`file:${relativePath}\n`);
    hash.update(await fs.readFile(candidate));
    hash.update("\n");
    return;
  }

  hash.update(`other:${relativePath}:${stat.mode}\n`);
}

async function buildSkillSetKey(input: {
  skills: PaperclipSkillEntry[];
  label: string;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`paperclip-acpx-${input.label}-skills:v1\n`);
  const sorted = [...input.skills].sort((left, right) => left.runtimeName.localeCompare(right.runtimeName));
  for (const entry of sorted) {
    hash.update(`skill:${entry.key}:${entry.runtimeName}\n`);
    await hashPathContents(entry.source, hash, entry.runtimeName, new Set<string>());
  }
  return hash.digest("hex");
}

async function resolveSelectedRuntimeSkills(
  config: Record<string, unknown>,
  moduleDir: string,
): Promise<{ allSkills: PaperclipSkillEntry[]; selectedSkills: PaperclipSkillEntry[]; desiredSkillNames: string[] }> {
  const allSkills = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredSkillNames = resolvePaperclipDesiredSkillNames(config, allSkills);
  const desiredSet = new Set(desiredSkillNames);
  return {
    allSkills,
    selectedSkills: allSkills.filter((entry) => desiredSet.has(entry.key)),
    desiredSkillNames,
  };
}

async function prepareClaudeSkillRuntime(input: {
  stateDir: string;
  config: Record<string, unknown>;
  moduleDir: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{
  identity: Record<string, unknown>;
  promptInstructions: string;
  commandNotes: string[];
}> {
  const { allSkills, selectedSkills, desiredSkillNames } = await resolveSelectedRuntimeSkills(input.config, input.moduleDir);
  const skillSetKey = await buildSkillSetKey({ skills: selectedSkills, label: "claude" });
  const bundleRoot = path.join(input.stateDir, "runtime-skills", "claude", skillSetKey);
  const skillsHome = path.join(bundleRoot, ".claude", "skills");
  await fs.mkdir(skillsHome, { recursive: true });

  for (const entry of selectedSkills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await materializePaperclipSkillCopy(entry.source, target);
      if (result.skippedSymlinks.length > 0) {
        await input.onLog(
          "stdout",
          `[paperclip] Materialized ACPX Claude skill "${entry.runtimeName}" into ${skillsHome} and skipped ${result.skippedSymlinks.length} symlink(s).\n`,
        );
      }
    } catch (err) {
      await input.onLog(
        "stderr",
        `[paperclip] Failed to materialize ACPX Claude skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const selectedNames = selectedSkills.map((entry) => entry.runtimeName).sort();
  const promptInstructions = selectedSkills.length > 0
    ? [
        "Paperclip has materialized selected runtime skills for this ACPX Claude session.",
        `Skill root: ${skillsHome}`,
        selectedNames.length > 0 ? `Selected skills: ${selectedNames.join(", ")}` : "",
        "When a task calls for one of these skills, read its SKILL.md from that root and follow it.",
      ].filter(Boolean).join("\n")
    : "";

  return {
    identity: {
      mode: "claude",
      skillSetKey,
      desiredSkillNames,
      selectedSkills: selectedNames,
      skillRoot: selectedSkills.length > 0 ? skillsHome : null,
    },
    promptInstructions,
    commandNotes: selectedSkills.length > 0
      ? [`Materialized ${selectedSkills.length} Paperclip skill(s) for ACPX Claude at ${skillsHome}.`]
      : [],
  };
}

async function readManagedCodexSkillsManifest(skillsHome: string): Promise<Set<string>> {
  const manifestPath = path.join(skillsHome, PAPERCLIP_MANAGED_CODEX_SKILLS_MANIFEST);
  try {
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    const parsed = parseObject(raw);
    const skills = Array.isArray(parsed.managedSkillNames)
      ? parsed.managedSkillNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    return new Set(skills);
  } catch {
    return new Set();
  }
}

async function writeManagedCodexSkillsManifest(skillsHome: string, skillNames: Iterable<string>): Promise<void> {
  const managedSkillNames = Array.from(new Set(skillNames)).sort();
  await fs.writeFile(
    path.join(skillsHome, PAPERCLIP_MANAGED_CODEX_SKILLS_MANIFEST),
    `${JSON.stringify({ version: 1, managedSkillNames }, null, 2)}\n`,
    "utf8",
  );
}

async function removeSkillTarget(target: string): Promise<boolean> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) return false;
  await fs.rm(target, { recursive: true, force: true });
  return true;
}

async function reconcileManagedCodexSkills(input: {
  skillsHome: string;
  allSkills: PaperclipSkillEntry[];
  selectedSkills: PaperclipSkillEntry[];
  onLog: AdapterExecutionContext["onLog"];
}): Promise<void> {
  const desired = new Set(input.selectedSkills.map((entry) => entry.runtimeName));
  const managed = await readManagedCodexSkillsManifest(input.skillsHome);
  const availableByRuntimeName = new Map(input.allSkills.map((entry) => [entry.runtimeName, entry]));

  for (const name of managed) {
    if (desired.has(name)) continue;
    if (await removeSkillTarget(path.join(input.skillsHome, name))) {
      await input.onLog("stdout", `[paperclip] Revoked ACPX Codex skill "${name}" from ${input.skillsHome}\n`);
    }
  }

  for (const entry of input.allSkills) {
    if (desired.has(entry.runtimeName) || managed.has(entry.runtimeName)) continue;
    const target = path.join(input.skillsHome, entry.runtimeName);
    const existing = await fs.lstat(target).catch(() => null);
    if (!existing?.isSymbolicLink()) continue;
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (!linkedPath) continue;
    const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
    if (resolvedLinkedPath !== path.resolve(entry.source)) continue;
    if (await removeSkillTarget(target)) {
      await input.onLog("stdout", `[paperclip] Revoked legacy ACPX Codex skill "${entry.runtimeName}" from ${input.skillsHome}\n`);
    }
  }

  for (const name of managed) {
    if (desired.has(name) || availableByRuntimeName.has(name)) continue;
    if (await removeSkillTarget(path.join(input.skillsHome, name))) {
      await input.onLog("stdout", `[paperclip] Revoked unavailable ACPX Codex skill "${name}" from ${input.skillsHome}\n`);
    }
  }
}

async function prepareCodexSkillRuntime(input: {
  companyId: string;
  config: Record<string, unknown>;
  env: Record<string, string>;
  moduleDir: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ identity: Record<string, unknown>; commandNotes: string[] }> {
  const envConfig = parseObject(input.config.env);
  const configuredCodexHome =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  const sourceCodexHome =
    typeof process.env.CODEX_HOME === "string" && process.env.CODEX_HOME.trim().length > 0
      ? path.resolve(process.env.CODEX_HOME.trim())
      : path.join(os.homedir(), ".codex");
  const managedCodexHome = resolveManagedCodexHomeDir(input.companyId);
  const effectiveCodexHome = configuredCodexHome ??
    await prepareManagedCodexHome({
      companyId: input.companyId,
      sourceHome: sourceCodexHome,
      targetHome: managedCodexHome,
      onLog: input.onLog,
    });
  const { allSkills, selectedSkills, desiredSkillNames } = await resolveSelectedRuntimeSkills(input.config, input.moduleDir);
  const skillSetKey = await buildSkillSetKey({ skills: selectedSkills, label: "codex" });
  const skillsHome = path.join(effectiveCodexHome, "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  await reconcileManagedCodexSkills({
    skillsHome,
    allSkills,
    selectedSkills,
    onLog: input.onLog,
  });

  for (const entry of selectedSkills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await materializePaperclipSkillCopy(entry.source, target);
      if (result.skippedSymlinks.length > 0) {
        await input.onLog(
          "stdout",
          `[paperclip] Materialized ACPX Codex skill "${entry.runtimeName}" into ${skillsHome} and skipped ${result.skippedSymlinks.length} symlink(s).\n`,
        );
      }
    } catch (err) {
      await input.onLog(
        "stderr",
        `[paperclip] Failed to inject ACPX Codex skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  await writeManagedCodexSkillsManifest(skillsHome, selectedSkills.map((entry) => entry.runtimeName));

  input.env.CODEX_HOME = effectiveCodexHome;

  return {
    identity: {
      mode: "codex",
      skillSetKey,
      desiredSkillNames,
      selectedSkills: selectedSkills.map((entry) => entry.runtimeName).sort(),
      codexHome: effectiveCodexHome,
      skillsHome,
    },
    commandNotes: [`Prepared ACPX Codex skill home at ${skillsHome}.`],
  };
}

function resolveGeminiSkillsHome(config: Record<string, unknown>): string {
  const envConfig = parseObject(config.env);
  const configuredHome =
    typeof envConfig.HOME === "string" && envConfig.HOME.trim().length > 0
      ? path.resolve(envConfig.HOME.trim())
      : os.homedir();
  return path.join(configuredHome, ".gemini", "skills");
}

async function prepareGeminiSkillRuntime(input: {
  config: Record<string, unknown>;
  moduleDir: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ identity: Record<string, unknown>; commandNotes: string[] }> {
  const { selectedSkills, desiredSkillNames } = await resolveSelectedRuntimeSkills(input.config, input.moduleDir);
  const skillSetKey = await buildSkillSetKey({ skills: selectedSkills, label: "gemini" });
  const skillsHome = resolveGeminiSkillsHome(input.config);
  await fs.mkdir(skillsHome, { recursive: true });

  const allowedSkillNames = selectedSkills.map((entry) => entry.runtimeName);
  const removedSkills = await removeMaintainerOnlySkillSymlinks(skillsHome, allowedSkillNames);
  for (const skillName of removedSkills) {
    await input.onLog("stdout", `[paperclip] Removed maintainer-only ACPX Gemini skill "${skillName}" from ${skillsHome}\n`);
  }

  for (const entry of selectedSkills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "created" || result === "repaired") {
        await input.onLog(
          "stdout",
          `[paperclip] ${result === "repaired" ? "Repaired" : "Linked"} ACPX Gemini skill "${entry.runtimeName}" into ${skillsHome}\n`,
        );
      }
    } catch (err) {
      await input.onLog(
        "stderr",
        `[paperclip] Failed to link ACPX Gemini skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return {
    identity: {
      mode: "gemini",
      skillSetKey,
      desiredSkillNames,
      selectedSkills: selectedSkills.map((entry) => entry.runtimeName).sort(),
      skillsHome,
    },
    commandNotes: selectedSkills.length > 0
      ? [`Prepared ${selectedSkills.length} ACPX Gemini skill(s) at ${skillsHome}.`]
      : [],
  };
}

function normalizeMode(config: Record<string, unknown>): "persistent" | "oneshot" {
  return asString(config.mode, DEFAULT_ACP_ENGINE_MODE) === "oneshot" ? "oneshot" : "persistent";
}

function normalizePermissionMode(config: Record<string, unknown>): "approve-all" | "approve-reads" | "deny-all" {
  const value = asString(config.permissionMode, DEFAULT_ACP_ENGINE_PERMISSION_MODE).trim();
  if (value === "approve-reads" || value === "deny-all") return value;
  if (value === "default") return "approve-reads";
  return "approve-all";
}

function normalizeNonInteractivePermissions(config: Record<string, unknown>): "deny" | "fail" {
  return asString(config.nonInteractivePermissions, DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS) === "fail"
    ? "fail"
    : "deny";
}

function normalizeRequestedThinkingEffort(config: Record<string, unknown>): string {
  return (
    asString(config.modelReasoningEffort, "") ||
    asString(config.reasoningEffort, "") ||
    asString(config.thinkingEffort, "") ||
    asString(config.effort, "")
  ).trim();
}

function buildCodexStartupConfig(input: {
  existingConfig: string | undefined;
  requestedModel: string;
  requestedThinkingEffort: string;
  fastMode: boolean;
}): { value: string | null; invalidExistingConfig: boolean } {
  const hasRuntimeConfig = Boolean(
    input.requestedModel || input.requestedThinkingEffort || input.fastMode,
  );
  if (!hasRuntimeConfig) return { value: null, invalidExistingConfig: false };

  let existing: Record<string, unknown> = {};
  let invalidExistingConfig = false;
  if (input.existingConfig) {
    try {
      existing = parseObject(JSON.parse(input.existingConfig));
    } catch {
      invalidExistingConfig = true;
      existing = {};
    }
  }

  return {
    value: JSON.stringify({
      ...existing,
      ...(input.requestedModel ? { model: input.requestedModel } : {}),
      ...(input.requestedThinkingEffort
        ? { model_reasoning_effort: input.requestedThinkingEffort }
        : {}),
      ...(input.fastMode
        ? {
            service_tier: "fast",
            features: {
              ...parseObject(existing.features),
              fast_mode: true,
            },
          }
        : {}),
    }),
    invalidExistingConfig,
  };
}

function isCompatibleSession(
  params: Record<string, unknown>,
  runtime: Pick<AcpxPreparedRuntime, "fingerprint" | "sessionKey" | "cwd" | "mode" | "acpxAgent" | "remoteExecutionIdentity">,
): boolean {
  if (asString(params.configFingerprint, "") !== runtime.fingerprint) return false;
  if (asString(params.sessionKey, "") !== runtime.sessionKey) return false;
  if (asString(params.agent, "") !== runtime.acpxAgent) return false;
  if (asString(params.mode, "") !== runtime.mode) return false;
  const savedCwd = asString(params.cwd, "");
  if (!savedCwd || path.resolve(savedCwd) !== path.resolve(runtime.cwd)) return false;
  const savedRemote = parseObject(params.remoteExecution);
  return stableJson(savedRemote) === stableJson(runtime.remoteExecutionIdentity ?? {});
}

function buildSessionParams(input: {
  prepared: AcpxPreparedRuntime;
  handle: AcpRuntimeHandle;
}): Record<string, unknown> {
  const { prepared, handle } = input;
  return {
    sessionKey: prepared.sessionKey,
    runtimeSessionName: handle.runtimeSessionName,
    acpxRecordId: handle.acpxRecordId,
    acpSessionId: handle.backendSessionId,
    agentSessionId: handle.agentSessionId,
    agent: prepared.acpxAgent,
    cwd: prepared.cwd,
    mode: prepared.mode,
    stateDir: prepared.stateDir,
    configFingerprint: prepared.fingerprint,
    ...(prepared.requestedModel ? { model: prepared.requestedModel } : {}),
    ...(prepared.requestedThinkingEffort ? { thinkingEffort: prepared.requestedThinkingEffort } : {}),
    ...(prepared.fastMode ? { fastMode: true } : {}),
    skills: prepared.skillsIdentity,
    mcpServers: prepared.mcpIdentity,
    ...(prepared.workspaceId ? { workspaceId: prepared.workspaceId } : {}),
    ...(prepared.workspaceRepoUrl ? { repoUrl: prepared.workspaceRepoUrl } : {}),
    ...(prepared.workspaceRepoRef ? { repoRef: prepared.workspaceRepoRef } : {}),
    ...(prepared.remoteExecutionIdentity ? { remoteExecution: prepared.remoteExecutionIdentity } : {}),
  };
}

interface PaperclipClaudeSettingsResult {
  filePath: string;
  allow: string[];
  additionalDirectories: string[];
  defaultMode: string;
  overrodeDontAsk: boolean;
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

// The Claude Code SDK that `claude-agent-acp` runs uses
// `settingSources: ["user", "project", "local"]`. By writing a per-worktree
// `.claude/settings.local.json` we override the user's potentially-restrictive
// `~/.claude/settings.json` (e.g. `defaultMode: "dontAsk"`, which silently
// denies every non-allowlisted tool and never reaches `canUseTool`), and we
// widen the SDK's Read sandbox to include the Paperclip state dirs the agent
// needs to talk to its own control plane.
async function writePaperclipClaudeSettings(input: {
  cwd: string;
  stateDir: string;
  agentHome: string;
  companyId: string;
}): Promise<PaperclipClaudeSettingsResult> {
  const filePath = path.join(input.cwd, ".claude", "settings.local.json");
  const instanceRoot = defaultPaperclipInstanceDir();
  const companyRoot = path.join(instanceRoot, "companies", input.companyId);
  const paperclipAdditionalDirectories = uniqueSorted([
    input.stateDir,
    input.agentHome,
    companyRoot,
  ]);
  const paperclipAllow = uniqueSorted([
    "Bash(curl:*)",
    "Bash(env:*)",
    "Bash(env)",
    `Bash(${input.cwd}/scripts/paperclip-issue-update.sh:*)`,
    `Bash(${input.cwd}/scripts/paperclip:*)`,
  ]);

  let existing: Record<string, unknown> = {};
  const existingRaw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
    } catch {
      // Malformed settings file — leave it alone in `existing` and our merge will replace it with a valid one.
    }
  }
  const existingPerms =
    existing.permissions && typeof existing.permissions === "object" && !Array.isArray(existing.permissions)
      ? (existing.permissions as Record<string, unknown>)
      : {};
  const existingAllow = Array.isArray(existingPerms.allow)
    ? (existingPerms.allow as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const existingAdditionalDirectories = Array.isArray(existingPerms.additionalDirectories)
    ? (existingPerms.additionalDirectories as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const mergedAllow = uniqueSorted([...existingAllow, ...paperclipAllow]);
  const mergedAdditionalDirectories = uniqueSorted([
    ...existingAdditionalDirectories,
    ...paperclipAdditionalDirectories,
  ]);
  const existingDefaultMode =
    typeof existingPerms.defaultMode === "string" ? (existingPerms.defaultMode as string) : "";
  const defaultMode =
    existingDefaultMode && existingDefaultMode !== "dontAsk" ? existingDefaultMode : "default";
  const overrodeDontAsk = existingDefaultMode === "dontAsk";

  const nextPermissions: Record<string, unknown> = {
    ...existingPerms,
    allow: mergedAllow,
    additionalDirectories: mergedAdditionalDirectories,
    defaultMode,
  };
  const next: Record<string, unknown> = { ...existing, permissions: nextPermissions };
  await writeFileAtomically({
    target: filePath,
    contents: `${JSON.stringify(next, null, 2)}\n`,
    mode: 0o600,
  });
  return {
    filePath,
    allow: mergedAllow,
    additionalDirectories: mergedAdditionalDirectories,
    defaultMode,
    overrodeDontAsk,
  };
}

async function writeAgentWrapper(input: {
  stateDir: string;
  acpxAgent: string;
  agentCommandShell: string;
  env: Record<string, string>;
  childStderrDir: string;
}): Promise<{ wrapperPath: string; envFilePath: string }> {
  const wrappersDir = path.join(input.stateDir, "wrappers");
  await fs.mkdir(wrappersDir, { recursive: true });
  const envLines = Object.entries(input.env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const wrapperHash = shortHash({
    agent: input.acpxAgent,
    command: input.agentCommandShell,
    env: envLines,
    childStderrDir: input.childStderrDir,
  });
  const wrapperPath = path.join(wrappersDir, `${input.acpxAgent}-${wrapperHash}.sh`);
  const envFilePath = path.join(wrappersDir, `${input.acpxAgent}-${wrapperHash}.env`);
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `env_file=${shellQuote(envFilePath)}`,
    "if [[ -f \"$env_file\" ]]; then",
    "  set -a",
    "  source \"$env_file\"",
    "  set +a",
    "fi",
    `stderr_dir=${shellQuote(input.childStderrDir)}`,
    "if [[ -n \"${PAPERCLIP_RUN_ID:-}\" ]]; then",
    "  mkdir -p \"$stderr_dir\"",
    // Keep the run-stderr file unfiltered, but do not forward the known-benign
    // ACP nes/close cleanup RPC error to Paperclip's live stderr stream.
    "  exec 2> >(tee -a \"$stderr_dir/$PAPERCLIP_RUN_ID.log\" | grep -Ev \"method: ['\\\"]nes/close['\\\"].*-32601\" >&2 || true)",
    "fi",
    `exec ${input.agentCommandShell} "$@"`,
    "",
  ].join("\n");
  await writeFileAtomically({
    target: envFilePath,
    contents: `${envLines.join("\n")}\n`,
    mode: 0o600,
  });
  await writeFileAtomically({
    target: wrapperPath,
    contents: script,
    mode: 0o700,
  });
  await cleanupStaleAgentWrappers({
    wrappersDir,
    currentFileNames: new Set([path.basename(wrapperPath), path.basename(envFilePath)]),
  });
  return { wrapperPath, envFilePath };
}

async function cleanupStaleAgentWrappers(input: { wrappersDir: string; currentFileNames: Set<string> }) {
  const wrappers = await fs.readdir(input.wrappersDir).catch(() => []);
  const now = Date.now();
  await Promise.all(
    wrappers.map(async (name) => {
      const isManagedWrapperFile = name.endsWith(".sh") || name.endsWith(".env");
      if (!isManagedWrapperFile || input.currentFileNames.has(name)) return;
      const wrapperPath = path.join(input.wrappersDir, name);
      const stats = await fs.stat(wrapperPath).catch(() => null);
      if (!stats || now - stats.mtimeMs < WRAPPER_CLEANUP_RETENTION_MS) return;
      await fs.rm(wrapperPath, { force: true });
    }),
  );
}

async function buildRuntime(input: {
  ctx: AdapterExecutionContext;
  engine: AcpxEngineSettings;
}): Promise<AcpxPreparedRuntime> {
  const { runId, agent, config, context, authToken } = input.ctx;
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const secretsContext = parseObject(context.paperclipSecrets);
  const secretManifest = Array.isArray(secretsContext.manifest) ? secretsContext.manifest : [];
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceBranch = asString(workspaceContext.branchName, "");
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: input.ctx.executionTarget,
    legacyRemoteExecution: input.ctx.executionTransport?.remoteExecution,
  });
  const remoteExecutionIdentity = adapterExecutionTargetSessionIdentity(executionTarget);
  const effectiveExecutionCwd =
    remoteExecutionIdentity && typeof remoteExecutionIdentity.remoteCwd === "string"
      ? remoteExecutionIdentity.remoteCwd
      : cwd;
  const executionTargetIsRemote = remoteExecutionIdentity !== null;
  const shapedWorkspaceEnv = shapePaperclipWorkspaceEnvForExecution({
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceWorktreePath,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const acpxAgent = normalizeAgent(config);
  const mode = normalizeMode(config);
  const permissionMode = normalizePermissionMode(config);
  const nonInteractivePermissions = normalizeNonInteractivePermissions(config);
  const requestedModel = asString(config.model, "").trim();
  const requestedThinkingEffort = normalizeRequestedThinkingEffort(config);
  const fastMode = acpxAgent === "codex" && config.fastMode === true;
  const runtimeMcpServers = input.ctx.runtimeMcp?.getServers() ?? [];
  const mcpIdentity = runtimeMcpServers.map(({ name, url, connectionId }) => ({
    name,
    url,
    connectionId,
  }));
  const mcpServers: NonNullable<AcpRuntimeOptions["mcpServers"]> = runtimeMcpServers.map((server) => ({
    type: "http",
    name: server.name,
    url: server.url,
    headers: [{ name: "Authorization", value: `Bearer ${server.token}` }],
  }));
  // Resolve the wall-clock timeout through the shared execution-target
  // resolver so sandbox-backed runs pick up the 4h backstop default while
  // local/SSH runs keep the historical "0 = no adapter timeout" behavior.
  const timeoutResolution = resolveAdapterExecutionTargetTimeout(
    executionTarget,
    asNumber(config.timeoutSec, DEFAULT_ACP_ENGINE_TIMEOUT_SEC),
  );
  const timeoutSec = timeoutResolution.timeoutSec;
  const stateDir = path.resolve(asString(config.stateDir, "") || defaultStateDir(agent.companyId, agent.id));
  await fs.mkdir(stateDir, { recursive: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent), PAPERCLIP_RUN_ID: runId };
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    "";
  const wakeReason = typeof context.wakeReason === "string" ? context.wakeReason.trim() : "";
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    "";
  const approvalId = typeof context.approvalId === "string" ? context.approvalId.trim() : "";
  const approvalStatus = typeof context.approvalStatus === "string" ? context.approvalStatus.trim() : "";
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: shapedWorkspaceEnv.workspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath: shapedWorkspaceEnv.workspaceWorktreePath,
    agentHome,
  });
  const shapedEnvConfig = rewriteWorkspaceCwdEnvVarsForExecution({
    env: envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    executionCwd: shapedWorkspaceEnv.workspaceCwd,
    executionTargetIsRemote,
  });
  // Resolved adapter env (plain + server-resolved secret_ref values) that we
  // forward to the spawned agent process. Captured so a stable hash of it can be
  // folded into the session fingerprint below — a change here must invalidate a
  // warm/resumable session so the next launch picks up the latest env. Only
  // user/adapter-configured env flows through this loop; per-wake PAPERCLIP_*
  // runtime vars (PAPERCLIP_RUN_ID, wake/approval ids, ...) were assigned to
  // `env` above and are never present in shapedEnvConfig, so they inherently
  // stay out of the hash and don't reset the session every heartbeat.
  const resolvedAdapterEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(shapedEnvConfig)) {
    if (typeof value !== "string") continue;
    // Runtime PAPERCLIP_* always wins over config: skip a PAPERCLIP_* key that
    // Paperclip has already assigned this run. A PAPERCLIP_* key Paperclip did
    // NOT set (e.g. an explicitly configured PAPERCLIP_API_KEY, applied here) is
    // stable per-run config, so it applies and feeds the fingerprint hash below.
    if (isPaperclipRuntimeEnvKey(key) && key in env) continue;
    env[key] = value;
    resolvedAdapterEnv[key] = value;
  }
  if (!hasExplicitApiKey && authToken) env.PAPERCLIP_API_KEY = authToken;
  // For the claude agent, set model via ANTHROPIC_MODEL at startup rather than
  // via session/set_config_option — the ACP server's set_config_option handler
  // validates the value against its internal available-models list and rejects
  // bare model IDs (e.g. "claude-opus-4-7") that don't exactly match a model
  // entry in some versions. ANTHROPIC_MODEL is read during initialization, so
  // it reliably sets the model before any turns are run.
  if (requestedModel && acpxAgent === "claude" && !env.ANTHROPIC_MODEL) {
    env.ANTHROPIC_MODEL = requestedModel;
  }
  if (acpxAgent === "codex") {
    const codexStartupConfig = buildCodexStartupConfig({
      existingConfig: env.CODEX_CONFIG,
      requestedModel,
      requestedThinkingEffort,
      fastMode,
    });
    if (codexStartupConfig.invalidExistingConfig) {
      await input.ctx.onLog(
        "stderr",
        "[paperclip] Ignoring invalid user CODEX_CONFIG while applying runtime Codex settings; expected a JSON object.\n",
      );
    }
    if (codexStartupConfig.value) env.CODEX_CONFIG = codexStartupConfig.value;
  }

  let skillPromptInstructions = "";
  let skillsIdentity: Record<string, unknown> = { mode: "unsupported" };
  const skillCommandNotes: string[] = [];
  let paperclipClaudeSettings: PaperclipClaudeSettingsResult | null = null;
  if (acpxAgent === "claude") {
    const preparedSkills = await prepareClaudeSkillRuntime({
      stateDir,
      config,
      moduleDir: input.engine.moduleDir,
      onLog: input.ctx.onLog,
    });
    skillPromptInstructions = preparedSkills.promptInstructions;
    skillsIdentity = preparedSkills.identity;
    skillCommandNotes.push(...preparedSkills.commandNotes);
    paperclipClaudeSettings = await writePaperclipClaudeSettings({
      cwd,
      stateDir,
      agentHome,
      companyId: agent.companyId,
    });
    skillCommandNotes.push(
      `Wrote Paperclip-managed Claude settings to ${paperclipClaudeSettings.filePath} (defaultMode=${paperclipClaudeSettings.defaultMode}${
        paperclipClaudeSettings.overrodeDontAsk ? "; overrode user dontAsk" : ""
      }, +${paperclipClaudeSettings.additionalDirectories.length} read root(s), +${paperclipClaudeSettings.allow.length} allow rule(s)).`,
    );
  } else if (acpxAgent === "codex") {
    const preparedSkills = await prepareCodexSkillRuntime({
      companyId: agent.companyId,
      config,
      env,
      moduleDir: input.engine.moduleDir,
      onLog: input.ctx.onLog,
    });
    skillsIdentity = preparedSkills.identity;
    skillCommandNotes.push(...preparedSkills.commandNotes);
  } else if (acpxAgent === "gemini") {
    const preparedSkills = await prepareGeminiSkillRuntime({
      config,
      moduleDir: input.engine.moduleDir,
      onLog: input.ctx.onLog,
    });
    skillsIdentity = preparedSkills.identity;
    skillCommandNotes.push(...preparedSkills.commandNotes);
  } else {
    const desired = resolvePaperclipDesiredSkillNames(
      config,
      await readPaperclipRuntimeSkillEntries(config, input.engine.moduleDir),
    );
    skillsIdentity = { mode: "custom_unsupported", desiredSkillNames: desired };
    if (desired.length > 0) {
      skillCommandNotes.push("Selected Paperclip skills are tracked only; ACPX custom commands do not expose a runtime skill contract yet.");
    }
  }

  const configuredCommand = asString(config.agentCommand, "").trim();
  const builtInCommand = await resolveBuiltInAgentCommand({
    agent: acpxAgent,
    packageRootDir: input.engine.packageRootDir,
    executionTargetIsRemote,
  });
  let agentCommand = configuredCommand || builtInCommand?.command || null;
  let agentCommandShell = configuredCommand || builtInCommand?.shellCommand || "";
  if (acpxAgent === "gemini" && agentCommandShell) {
    const normalized = await normalizeGeminiAcpCommandShell(
      agentCommandShell,
      ensurePathInEnv({ ...process.env, ...env }),
    );
    if (normalized !== agentCommandShell) {
      agentCommandShell = normalized;
      agentCommand = normalized;
    }
  }
  const childStderrDir = path.join(stateDir, "run-stderr");
  const childStderrLogPath = agentCommand ? path.join(childStderrDir, `${runId}.log`) : null;
  const wrapper = agentCommand
    ? await writeAgentWrapper({
        stateDir,
        acpxAgent,
        agentCommandShell,
        env,
        childStderrDir,
      })
    : null;
  const wrapperPath = wrapper?.wrapperPath ?? null;
  let paperclipBridge: AdapterExecutionTargetPaperclipBridgeHandle | null = null;
  if (
    executionTarget?.kind === "remote" &&
    executionTarget.transport === "sandbox" &&
    Boolean(executionTarget.runner) &&
    agentCommandShell
  ) {
    paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId,
      target: { ...executionTarget, streamRunLogs: false },
      runtimeRootDir: null,
      adapterKey: input.engine.adapterType,
      timeoutSec,
      hostApiToken: env.PAPERCLIP_API_KEY,
      onLog: input.ctx.onLog,
    });
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
      await input.ctx.onLog("stdout", "[paperclip] Sandbox ACP API callback bridge enabled for this run.\n");
    }
  }
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  let processSessionBridge: AdapterExecutionTargetProcessSessionBridgeHandle | null = null;
  try {
    processSessionBridge =
      executionTarget?.kind === "remote" &&
      executionTarget.transport === "sandbox" &&
      Boolean(executionTarget.runner) &&
      agentCommandShell
        ? await startAdapterExecutionTargetProcessSessionBridge({
            runId,
            target: executionTarget,
            runtimeRootDir: null,
            adapterKey: input.engine.adapterType,
            command: "sh",
            args: ["-lc", `exec ${agentCommandShell}`],
            cwd: effectiveExecutionCwd,
            env: runtimeEnv,
            timeoutSec,
            onLog: input.ctx.onLog,
          })
        : null;
  } catch (err) {
    await paperclipBridge?.stop().catch(() => {});
    throw err;
  }
  const overrideCommand = processSessionBridge?.agentCommand ?? wrapperPath;
  const overrides = overrideCommand ? { [acpxAgent]: overrideCommand } : undefined;
  const agentRegistry = createAgentRegistry({ overrides });
  const fingerprint = shortHash({
    acpxAgent,
    agentCommand: agentCommand ?? acpxAgent,
    cwd: path.resolve(cwd),
    mode,
    permissionMode,
    nonInteractivePermissions,
    requestedModel,
    requestedThinkingEffort,
    fastMode,
    remoteExecutionIdentity,
    skillsIdentity,
    skillPromptInstructions,
    paperclipClaudeSettings: paperclipClaudeSettings
      ? {
          allow: paperclipClaudeSettings.allow,
          additionalDirectories: paperclipClaudeSettings.additionalDirectories,
          defaultMode: paperclipClaudeSettings.defaultMode,
        }
      : null,
    mcpServers: mcpIdentity,
    secretManifestHash: shortHash(secretManifest),
    // Fold the resolved adapter env (all applied user-configured values —
    // plain, secret_ref, and stable PAPERCLIP_* config such as an explicit
    // PAPERCLIP_API_KEY) into the fingerprint so a change to any forwarded value
    // invalidates a warm handle / resumable session and forces a fresh launch
    // that sources the latest env. secretManifestHash alone misses plain-value
    // edits and same-version secret rotations. Per-wake runtime vars never enter
    // resolvedAdapterEnv, so they don't churn the fingerprint every heartbeat.
    adapterEnvHash: shortHash(resolvedAdapterEnv),
  });
  const taskKey = asString(input.ctx.runtime.taskKey, "") || wakeTaskId || workspaceId || "default";
  const sessionKey = `paperclip:${agent.companyId}:${agent.id}:${taskKey}:${fingerprint}`;
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand: wrapperPath ?? agentCommand ?? acpxAgent,
  });

  return {
    acpxAgent,
    mode,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv,
    stateDir,
    permissionMode,
    nonInteractivePermissions,
    requestedModel,
    requestedThinkingEffort,
    fastMode,
    timeoutSec,
    timeoutResolution,
    sessionKey,
    fingerprint,
    agentCommand,
    agentRegistry,
    processSessionBridge,
    paperclipBridge,
    remoteExecutionIdentity,
    skillPromptInstructions,
    skillsIdentity: {
      ...skillsIdentity,
      commandNotes: skillCommandNotes,
    },
    childStderrLogPath,
    paperclipClaudeSettings,
    mcpServers,
    mcpIdentity,
  };
}

function sessionConfigOptions(prepared: AcpxPreparedRuntime): Array<{ key: string; value: string }> {
  const options: Array<{ key: string; value: string }> = [];
  // Claude and Codex runtime config is pre-set via startup env vars; skip
  // set_config_option to avoid ACP-server picker validation rejecting valid
  // backend model IDs that are not advertised by the local ACP server.
  if (
    prepared.requestedModel &&
    prepared.acpxAgent !== "claude" &&
    prepared.acpxAgent !== "codex"
  ) {
    options.push({ key: "model", value: prepared.requestedModel });
  }
  if (prepared.requestedThinkingEffort && prepared.acpxAgent !== "codex") {
    options.push({
      key: "effort",
      value: prepared.requestedThinkingEffort,
    });
  }
  if (prepared.fastMode && prepared.acpxAgent !== "codex") {
    options.push(
      { key: "service_tier", value: "fast" },
      { key: "features.fast_mode", value: "true" },
    );
  }
  return options;
}

async function applySessionConfigOptions(input: {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  prepared: AcpxPreparedRuntime;
  onLog: AdapterExecutionContext["onLog"];
}) {
  const options = sessionConfigOptions(input.prepared);
  if (options.length === 0) return;
  if (!input.runtime.setConfigOption) {
    const message =
      "ACPX runtime does not expose session config controls; upgrade ACPX or remove configured model, effort, and fast mode overrides.";
    await input.onLog("stderr", `[paperclip] ${message}\n`);
    throw new Error(message);
  }
  for (const option of options) {
    await input.runtime.setConfigOption({
      handle: input.handle,
      key: option.key,
      value: option.value,
    });
    await input.onLog(
      "stdout",
      `[paperclip] Applied ACPX ${input.prepared.acpxAgent} config ${option.key}=${option.value}\n`,
    );
  }
}

async function cleanupRemoteBridges(prepared: AcpxPreparedRuntime): Promise<void> {
  await Promise.allSettled([
    prepared.processSessionBridge?.stop(),
    prepared.paperclipBridge?.stop(),
  ]);
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!env.PAPERCLIP_API_URL || !env.PAPERCLIP_API_KEY) return "";
  const lines = [
    "Paperclip API access note:",
    "Use terminal commands with curl to make Paperclip API requests.",
    "Normalize the base URL before adding API paths:",
    `  PAPERCLIP_API_BASE="\${PAPERCLIP_API_URL%/}"; PAPERCLIP_API_BASE="\${PAPERCLIP_API_BASE%/api}"`,
    "GET example:",
    `  curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_BASE/api/agents/me"`,
  ];
  if (env.PAPERCLIP_TASK_ID) {
    lines.push(
      "Scoped issue comment example:",
      `  curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -d '{"body":"Status update from agent."}' "$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID/comments"`,
    );
  } else {
    lines.push("Use a real issue id from the current context before making issue write requests.");
  }
  return lines.join("\n");
}

async function buildPrompt(ctx: AdapterExecutionContext, resumedSession: boolean, env: Record<string, string>): Promise<{
  prompt: string;
  promptMetrics: Record<string, number>;
  commandNotes: string[];
}> {
  const { agent, runId, config, context, onLog } = ctx;
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  const commandNotes: string[] = [];
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      commandNotes.push(
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to the ACPX prompt (relative references from ${instructionsDir}).`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
      commandNotes.push(`Configured instructionsFilePath ${instructionsFilePath}, but file could not be read.`);
    }
  }

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !resumedSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession });
  const shouldUseResumeDeltaPrompt = resumedSession && wakePrompt.length > 0;
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();
  const paperclipEnvNote = renderPaperclipEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);
  const prompt = joinPromptSections([
    promptInstructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    paperclipEnvNote,
    apiAccessNote,
    renderedPrompt,
  ]);

  return {
    prompt,
    commandNotes,
    promptMetrics: {
      promptChars: prompt.length,
      instructionsChars: promptInstructionsPrefix.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      taskContextChars: taskContextNote.length,
      runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    },
  };
}

async function emitAcpxLog(ctx: AdapterExecutionContext, payload: Record<string, unknown>) {
  await ctx.onLog("stdout", `${JSON.stringify(payload)}\n`);
}

async function emitRuntimeEvent(ctx: AdapterExecutionContext, event: AcpRuntimeEvent) {
  if (event.type === "text_delta") {
    await emitAcpxLog(ctx, {
      type: "acpx.text_delta",
      text: event.text,
      channel: event.stream === "thought" ? "thought" : "output",
      tag: event.tag,
    });
    return;
  }
  if (event.type === "tool_call") {
    const eventRecord = event as Record<string, unknown>;
    const toolInput = eventRecord.input;
    await emitAcpxLog(ctx, {
      type: "acpx.tool_call",
      name: event.title ?? "acp_tool",
      toolCallId: event.toolCallId,
      status: event.status,
      text: event.text,
      tag: event.tag,
      ...(toolInput !== undefined ? { input: toolInput } : {}),
    });
    return;
  }
  if (event.type === "status") {
    await emitAcpxLog(ctx, {
      type: "acpx.status",
      text: event.text,
      tag: event.tag,
      used: event.used,
      size: event.size,
      ...(event.cost ? { cost: event.cost } : {}),
      ...(event.breakdown ? { breakdown: event.breakdown } : {}),
    });
    return;
  }
  if (event.type === "done") {
    await emitAcpxLog(ctx, {
      type: "acpx.result",
      summary: event.stopReason ?? "completed",
      stopReason: event.stopReason,
    });
    return;
  }
  if (event.type === "error") {
    await emitAcpxLog(ctx, {
      type: "acpx.error",
      message: event.message,
      code: event.code,
      retryable: event.retryable,
    });
  }
}

function resultErrorMessage(result: AcpRuntimeTurnResult): string | null {
  if (result.status !== "failed") return null;
  return result.error.message;
}

function usageBreakdownsEqual(
  left: AcpRuntimeUsageBreakdown,
  right: AcpRuntimeUsageBreakdown,
): boolean {
  return (
    asNumber(left.inputTokens, 0) === asNumber(right.inputTokens, 0) &&
    asNumber(left.outputTokens, 0) === asNumber(right.outputTokens, 0) &&
    asNumber(left.cachedReadTokens, 0) === asNumber(right.cachedReadTokens, 0) &&
    asNumber(left.cachedWriteTokens, 0) === asNumber(right.cachedWriteTokens, 0) &&
    asNumber(left.thoughtTokens, 0) === asNumber(right.thoughtTokens, 0) &&
    asNumber(left.totalTokens, 0) === asNumber(right.totalTokens, 0)
  );
}

function usdCostAmount(cost: AcpRuntimeUsageCost | null | undefined): number | null {
  if (!cost || typeof cost.amount !== "number" || !Number.isFinite(cost.amount)) return null;
  if (cost.currency && cost.currency.trim().toUpperCase() !== "USD") return null;
  return cost.amount;
}

async function readRuntimeStatus(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
): Promise<AcpRuntimeStatus | null> {
  if (!runtime.getStatus) return null;
  try {
    return (await runtime.getStatus({ handle })) ?? null;
  } catch {
    return null;
  }
}

/**
 * Fold the ACP runtime's post-turn usage into the adapter execution result
 * shape. The runtime persists the latest turn's token breakdown (adapters like
 * claude-agent-acp report per-turn accumulated usage in the prompt response),
 * so tokens are per-run. Cost is reported by agents as a cumulative session
 * amount, so the per-run cost is the delta against the pre-turn snapshot; a
 * decrease means the agent process restarted and its counter reset, in which
 * case the post-turn amount alone covers this run.
 */
export function summarizeAcpxTurnUsage(input: {
  preStatus: AcpRuntimeStatus | null;
  postStatus: AcpRuntimeStatus | null;
  eventBreakdown: AcpRuntimeUsageBreakdown | null;
  eventCostUsd: number | null;
}): {
  usage: UsageSummary | null;
  usageDetail: Record<string, number> | null;
  costUsd: number | null;
  cumulativeCostUsd: number | null;
} {
  // The persisted breakdown is overwritten per turn, so an unchanged value
  // is stale for this turn. Prefer an in-turn event breakdown when available;
  // otherwise suppress the stale value so it cannot be double-counted.
  const preBreakdown = input.preStatus?.usage?.cumulative ?? null;
  const postBreakdown = input.postStatus?.usage?.cumulative ?? null;
  const postBreakdownIsStale =
    preBreakdown != null &&
    postBreakdown != null &&
    usageBreakdownsEqual(preBreakdown, postBreakdown);
  const breakdown = postBreakdownIsStale
    ? input.eventBreakdown
    : postBreakdown ?? input.eventBreakdown ?? null;
  const inputTokens = Math.max(0, Math.floor(asNumber(breakdown?.inputTokens, 0)));
  const outputTokens = Math.max(0, Math.floor(asNumber(breakdown?.outputTokens, 0)));
  const cachedReadTokens = Math.max(0, Math.floor(asNumber(breakdown?.cachedReadTokens, 0)));
  const cachedWriteTokens = Math.max(0, Math.floor(asNumber(breakdown?.cachedWriteTokens, 0)));
  const hasTokens = inputTokens > 0 || outputTokens > 0 || cachedReadTokens > 0 || cachedWriteTokens > 0;
  // Cache-write tokens are prompt tokens the provider billed to create cache
  // entries; UsageSummary has no dedicated field, so count them as input.
  const usage: UsageSummary | null = hasTokens
    ? {
        inputTokens: inputTokens + cachedWriteTokens,
        outputTokens,
        cachedInputTokens: cachedReadTokens,
      }
    : null;
  const usageDetail = breakdown
    ? Object.fromEntries(
        Object.entries({
          inputTokens: breakdown.inputTokens,
          outputTokens: breakdown.outputTokens,
          cachedReadTokens: breakdown.cachedReadTokens,
          cachedWriteTokens: breakdown.cachedWriteTokens,
          thoughtTokens: breakdown.thoughtTokens,
          totalTokens: breakdown.totalTokens,
        }).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      )
    : null;

  const previousCostUsd = usdCostAmount(input.preStatus?.usage?.cost);
  const postCostUsd = usdCostAmount(input.postStatus?.usage?.cost);
  const postCostIsStale =
    input.eventCostUsd != null &&
    previousCostUsd != null &&
    postCostUsd != null &&
    postCostUsd === previousCostUsd;
  const cumulativeCostUsd = postCostIsStale ? input.eventCostUsd : postCostUsd ?? input.eventCostUsd;
  let costUsd: number | null = null;
  if (cumulativeCostUsd != null) {
    costUsd =
      previousCostUsd != null && cumulativeCostUsd >= previousCostUsd
        ? cumulativeCostUsd - previousCostUsd
        : cumulativeCostUsd;
  }

  return { usage, usageDetail, costUsd, cumulativeCostUsd };
}

type AcpxExecutionPhase = "ensure_session" | "configure_session" | "turn";

function describeErrorDiagnostics(err: unknown): {
  errorName: string;
  acpCode: string | null;
  causeMessage: string | null;
  retryable: boolean | null;
  stackPreview: string | null;
} {
  const errorName =
    err instanceof Error ? err.name || err.constructor.name : typeof err;
  const maybeCode =
    err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : null;
  const acpCode =
    isAcpRuntimeError(err) || (maybeCode?.startsWith("ACP_") ?? false) ? maybeCode : null;
  const cause =
    err && typeof err === "object" && (err as { cause?: unknown }).cause !== undefined
      ? (err as { cause?: unknown }).cause
      : undefined;
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : null;
  const retryable =
    err && typeof err === "object" && typeof (err as { retryable?: unknown }).retryable === "boolean"
      ? (err as { retryable: boolean }).retryable
      : null;
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : "";
  const stackPreview = stack ? stack.split("\n").slice(0, 6).join("\n") : null;
  return { errorName, acpCode, causeMessage, retryable, stackPreview };
}

function classifyError(
  err: unknown,
  phase?: AcpxExecutionPhase,
): Pick<AdapterExecutionResult, "errorCode" | "errorMeta"> {
  const message = err instanceof Error ? err.message : String(err);
  const diagnostics = describeErrorDiagnostics(err);
  const { acpCode, errorName, causeMessage, retryable, stackPreview } = diagnostics;
  const baseMeta: Record<string, unknown> = {
    errorName,
    ...(acpCode ? { acpCode } : {}),
    ...(causeMessage ? { causeMessage } : {}),
    ...(retryable !== null ? { retryable } : {}),
    ...(stackPreview ? { stackPreview } : {}),
    ...(phase ? { phase } : {}),
  };
  const lower = message.toLowerCase();
  const authLike = lower.includes("auth") || lower.includes("login") || lower.includes("credential");
  if (authLike) {
    return {
      errorCode: "acpx_auth_required",
      errorMeta: { category: "auth", ...baseMeta },
    };
  }
  const phaseCode = (() => {
    if (acpCode === "ACP_SESSION_INIT_FAILED") return "acpx_session_init_failed";
    if (acpCode === "ACP_TURN_FAILED") return "acpx_turn_failed";
    if (acpCode === "ACP_BACKEND_MISSING") return "acpx_backend_missing";
    if (acpCode === "ACP_BACKEND_UNAVAILABLE") return "acpx_backend_unavailable";
    if (phase === "ensure_session") return "acpx_session_init_failed";
    if (phase === "configure_session") return "acpx_session_config_failed";
    if (phase === "turn") return "acpx_turn_failed";
    return null;
  })();
  if (phaseCode) {
    return {
      errorCode: phaseCode,
      errorMeta: { category: acpCode ? "protocol" : "runtime", ...baseMeta },
    };
  }
  if (acpCode) {
    return {
      errorCode: "acpx_protocol_error",
      errorMeta: { category: "protocol", ...baseMeta },
    };
  }
  return {
    errorCode: "acpx_runtime_error",
    errorMeta: { category: "runtime", ...baseMeta },
  };
}

async function readChildStderrTail(input: {
  logPath: string | null;
  maxBytes?: number;
}): Promise<string | null> {
  if (!input.logPath) return null;
  const maxBytes = input.maxBytes ?? 4096;
  let handle: fs.FileHandle | null = null;
  try {
    const stat = await fs.stat(input.logPath);
    if (stat.size === 0) return null;
    handle = await fs.open(input.logPath, "r");
    const readBytes = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
    const tail = buffer.toString("utf8").trim();
    return tail.length > 0 ? tail : null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function emitAcpxFailure(input: {
  ctx: AdapterExecutionContext;
  prepared: AcpxPreparedRuntime;
  err: unknown;
  phase: AcpxExecutionPhase;
  // Replace the err-derived message in both the stderr-tail log header and the
  // acpx.error payload. Used by the turn path to surface the self-describing
  // adapter execution timeout message instead of the raw underlying error.
  messageOverride?: string;
}): Promise<{
  classified: Pick<AdapterExecutionResult, "errorCode" | "errorMeta">;
  message: string;
  childStderrTail: string | null;
}> {
  const { ctx, prepared, err, phase, messageOverride } = input;
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = messageOverride ?? rawMessage;
  const classified = classifyError(err, phase);
  const childStderrTail = await readChildStderrTail({ logPath: prepared.childStderrLogPath });
  if (childStderrTail) {
    await ctx.onLog(
      "stderr",
      `[paperclip] ACPX child stderr tail (${phase}):\n${childStderrTail}\n`,
    );
  }
  await emitAcpxLog(ctx, {
    type: "acpx.error",
    message,
    phase,
    ...classified.errorMeta,
    ...(childStderrTail ? { childStderrTail } : {}),
  });
  return { classified, message, childStderrTail };
}

function isResumeFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /resume|load|not found|no session|unknown session|conversation/i.test(message);
}

async function cleanupIdleHandles(input: {
  handles: Map<string, RuntimeCacheEntry>;
  now: number;
  idleMs: number;
}) {
  if (input.idleMs <= 0) return;

  const stale: Array<[string, RuntimeCacheEntry]> = [];
  for (const entry of input.handles.entries()) {
    if (input.now - entry[1].lastUsedAt >= input.idleMs) stale.push(entry);
  }
  for (const [key, entry] of stale) {
    await closeWarmHandle({
      handles: input.handles,
      key,
      entry,
      reason: "paperclip idle cleanup",
    });
  }
}

function clearWarmHandleTimer(entry: RuntimeCacheEntry) {
  if (!entry.cleanupTimer) return;
  clearTimeout(entry.cleanupTimer);
  entry.cleanupTimer = undefined;
}

async function closeWarmHandle(input: {
  handles: Map<string, RuntimeCacheEntry>;
  key: string;
  entry: RuntimeCacheEntry;
  reason: string;
  discardPersistentState?: boolean;
}) {
  if (input.handles.get(input.key) === input.entry) {
    input.handles.delete(input.key);
  }
  clearWarmHandleTimer(input.entry);
  await input.entry.runtime.close({
    handle: input.entry.handle,
    reason: input.reason,
    discardPersistentState: input.discardPersistentState ?? false,
  }).catch(() => {});
}

function scheduleIdleHandleCleanup(input: {
  handles: Map<string, RuntimeCacheEntry>;
  key: string;
  entry: RuntimeCacheEntry;
  idleMs: number;
  now: () => number;
}) {
  clearWarmHandleTimer(input.entry);
  if (input.idleMs <= 0) return;

  const delayMs = Math.max(1, input.entry.lastUsedAt + input.idleMs - input.now());
  input.entry.cleanupTimer = setTimeout(() => {
    void (async () => {
      const current = input.handles.get(input.key);
      if (current !== input.entry) return;
      const idleForMs = input.now() - input.entry.lastUsedAt;
      if (idleForMs < input.idleMs) {
        scheduleIdleHandleCleanup(input);
        return;
      }
      await closeWarmHandle({
        handles: input.handles,
        key: input.key,
        entry: input.entry,
        reason: "paperclip idle cleanup",
      });
    })();
  }, delayMs);
  input.entry.cleanupTimer.unref?.();
}

function warmHandleMatches(
  entry: RuntimeCacheEntry | undefined,
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
): boolean {
  return entry !== undefined && entry.runtime === runtime && entry.handle === handle;
}

export function createAcpxEngineExecutor(deps: AcpxEngineExecutorOptions = {}) {
  const createRuntime = deps.createRuntime ?? createAcpRuntime;
  const now = deps.now ?? (() => Date.now());
  const warmHandles = deps.warmHandles ?? defaultWarmHandles;
  const engine = resolveEngineSettings(deps);

  return async function executeAcpxEngine(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    let billingIdentity: AcpxEngineBillingIdentity | null = null;
    try {
      billingIdentity = (await deps.resolveBillingIdentity?.(ctx)) ?? null;
    } catch {
      billingIdentity = null;
    }
    const billingFields = {
      provider: billingIdentity?.provider ?? "acpx",
      ...(billingIdentity?.biller ? { biller: billingIdentity.biller } : {}),
      billingType: billingIdentity?.billingType ?? ("unknown" as const),
    };
    const prepared = await buildRuntime({ ctx, engine });
    // State the effective wall-clock timeout and its source up front so a
    // later timeout is diagnosable from the run log alone. Goes to stderr:
    // the acpx stdout log stream carries JSON acpx.* event payloads and must
    // stay machine-parseable line by line.
    await ctx.onLog(
      "stderr",
      `[paperclip] ${formatAdapterExecutionTimeoutStartLogLine(prepared.timeoutResolution)}\n`,
    );
    const warmIdleMs = asNumber(ctx.config.warmHandleIdleMs, DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS);
    await cleanupIdleHandles({ handles: warmHandles, now: now(), idleMs: warmIdleMs });

    const previousParams = parseObject(ctx.runtime.sessionParams);
    const canResume = isCompatibleSession(previousParams, prepared);
    const resumeSessionId = canResume ? asString(previousParams.acpSessionId, "") || undefined : undefined;
    const cached = canResume ? warmHandles.get(prepared.sessionKey) : undefined;
    const runtimeOptions: AcpRuntimeOptions = {
      cwd: prepared.cwd,
      sessionStore: createRuntimeStore({ stateDir: prepared.stateDir }),
      agentRegistry: prepared.agentRegistry,
      permissionMode: prepared.permissionMode,
      nonInteractivePermissions: prepared.nonInteractivePermissions,
      mcpServers: prepared.mcpServers,
      timeoutMs: prepared.timeoutSec > 0 ? prepared.timeoutSec * 1000 : undefined,
      // Scope ACPX runtime verbose logs to the claude agent only. Codex
      // and custom agents already emit their own per-tool output and don't
      // benefit from doubling the log volume.
      verbose: prepared.acpxAgent === "claude",
    };
    const runtime = cached?.runtime ?? createRuntime(runtimeOptions);
    if (cached) clearWarmHandleTimer(cached);
    if (!canResume && asString(previousParams.runtimeSessionName, "")) {
      await ctx.onLog(
        "stdout",
        `[paperclip] ACPX session "${asString(previousParams.runtimeSessionName, "")}" does not match the current agent/cwd/mode/runtime identity; starting fresh in "${prepared.cwd}".\n`,
      );
    }

    let handle = cached?.handle ?? null;
    let resumedSession = Boolean(handle ?? resumeSessionId);
    let clearSession = false;

    try {
      if (!handle) {
        try {
          handle = await runtime.ensureSession({
            sessionKey: prepared.sessionKey,
            agent: prepared.acpxAgent,
            mode: prepared.mode,
            cwd: prepared.cwd,
            resumeSessionId,
          });
        } catch (err) {
          if (!resumeSessionId || !isResumeFailure(err)) throw err;
          clearSession = true;
          resumedSession = false;
          await ctx.onLog(
            "stdout",
            `[paperclip] ACPX resume session "${resumeSessionId}" is unavailable; retrying with a fresh session.\n`,
          );
          handle = await runtime.ensureSession({
            sessionKey: prepared.sessionKey,
            agent: prepared.acpxAgent,
            mode: prepared.mode,
            cwd: prepared.cwd,
          });
        }
      }
    } catch (err) {
      const { classified, message } = await emitAcpxFailure({
        ctx,
        prepared,
        err,
        phase: "ensure_session",
      });
      await cleanupRemoteBridges(prepared);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
        ...classified,
        ...billingFields,
        model: prepared.requestedModel || null,
        clearSession,
        resultJson: { phase: "ensure_session" },
        summary: message,
      };
    }

    if (!handle) {
      await cleanupRemoteBridges(prepared);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "ACPX did not return a runtime session handle.",
        errorCode: "acpx_runtime_error",
        ...billingFields,
        model: prepared.requestedModel || null,
        resultJson: { phase: "ensure_session" },
        summary: "ACPX did not return a runtime session handle.",
      };
    }
    const sessionHandle = handle;
    try {
      await applySessionConfigOptions({
        runtime,
        handle: sessionHandle,
        prepared,
        onLog: ctx.onLog,
      });
    } catch (err) {
      const { classified, message } = await emitAcpxFailure({
        ctx,
        prepared,
        err,
        phase: "configure_session",
      });
      await runtime.close({
        handle: sessionHandle,
        reason: "paperclip config cleanup",
        discardPersistentState: false,
      }).catch(() => {});
      const existing = warmHandles.get(prepared.sessionKey);
      if (warmHandleMatches(existing, runtime, sessionHandle) && existing) {
        clearWarmHandleTimer(existing);
        warmHandles.delete(prepared.sessionKey);
      }
      await cleanupRemoteBridges(prepared);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
        ...classified,
        ...billingFields,
        model: prepared.requestedModel || null,
        clearSession,
        resultJson: {
          phase: "configure_session",
          agent: prepared.acpxAgent,
          requestedModel: prepared.requestedModel || null,
          requestedThinkingEffort: prepared.requestedThinkingEffort || null,
          fastMode: prepared.fastMode,
        },
        summary: message,
      };
    }
    const { prompt, promptMetrics, commandNotes } = await buildPrompt(ctx, resumedSession, prepared.env);
    const runPrompt = joinPromptSections([prepared.skillPromptInstructions, prompt]);
    await emitAcpxLog(ctx, {
      type: "acpx.session",
      agent: prepared.acpxAgent,
      sessionId: sessionHandle.backendSessionId,
      acpSessionId: sessionHandle.backendSessionId,
      agentSessionId: sessionHandle.agentSessionId,
      runtimeSessionName: sessionHandle.runtimeSessionName,
      mode: prepared.mode,
      permissionMode: prepared.permissionMode,
      model: prepared.requestedModel || null,
      thinkingEffort: prepared.requestedThinkingEffort || null,
      fastMode: prepared.fastMode,
    });
    if (ctx.onMeta) {
      await ctx.onMeta({
        adapterType: engine.adapterType,
        command: prepared.agentCommand ?? prepared.acpxAgent,
        cwd: prepared.cwd,
        commandNotes: [
          `ACPX runtime embedded in Paperclip with ${prepared.mode} session mode.`,
          `Effective ACPX permission mode: ${prepared.permissionMode}.`,
          ...(prepared.requestedModel
            ? [
                prepared.acpxAgent === "claude"
                  ? `Requested ACPX model: ${prepared.requestedModel} (set via ANTHROPIC_MODEL env at startup).`
                  : prepared.acpxAgent === "codex"
                    ? `Requested ACPX model: ${prepared.requestedModel} (set via CODEX_CONFIG at startup).`
                  : `Requested ACPX model: ${prepared.requestedModel}.`,
              ]
            : []),
          ...(prepared.requestedThinkingEffort ? [`Requested ACPX thinking effort: ${prepared.requestedThinkingEffort}.`] : []),
          ...(prepared.fastMode ? ["Requested ACPX Codex fast mode."] : []),
          ...(Array.isArray(prepared.skillsIdentity.commandNotes)
            ? prepared.skillsIdentity.commandNotes.filter((note): note is string => typeof note === "string")
            : []),
          ...commandNotes,
        ],
        env: prepared.loggedEnv,
        prompt: runPrompt,
        promptMetrics,
        context: ctx.context,
      });
    }

    let cancelActiveTurn: ((reason: string) => Promise<void>) | null = null;
    let controller: AbortController | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let timedOut = false;
    const textParts: string[] = [];
    let eventBreakdown: AcpRuntimeUsageBreakdown | null = null;
    let eventCostUsd: number | null = null;
    try {
      // Snapshot pre-turn usage so cumulative agent-reported cost can be
      // attributed to this run alone.
      const preTurnStatus = await readRuntimeStatus(runtime, sessionHandle);
      const timeoutMs = prepared.timeoutSec > 0 ? prepared.timeoutSec * 1000 : undefined;
      controller = new AbortController();
      if (timeoutMs) {
        timeout = setTimeout(() => {
          timedOut = true;
          controller?.abort();
          void cancelActiveTurn?.(formatAdapterExecutionTimeoutErrorMessage(prepared.timeoutResolution)).catch(() => {});
        }, timeoutMs);
      }
      const turn = runtime.startTurn({
        handle: sessionHandle,
        text: runPrompt,
        mode: "prompt",
        requestId: ctx.runId,
        timeoutMs,
        signal: controller?.signal,
      });
      cancelActiveTurn = async (reason: string) => {
        await turn.cancel({ reason });
      };
      for await (const event of turn.events) {
        if (event.type === "text_delta") textParts.push(event.text);
        if (event.type === "status" && event.tag === "usage_update") {
          eventBreakdown = event.breakdown ?? eventBreakdown;
          eventCostUsd = usdCostAmount(event.cost) ?? eventCostUsd;
        }
        await emitRuntimeEvent(ctx, event);
      }
      const terminal = await turn.result;
      if (timeout) clearTimeout(timeout);
      // Read usage before the close/warm-handle paths below can discard state.
      const postTurnStatus = await readRuntimeStatus(runtime, sessionHandle);
      const turnUsage = summarizeAcpxTurnUsage({
        preStatus: preTurnStatus,
        postStatus: postTurnStatus,
        eventBreakdown,
        eventCostUsd,
      });
      if (terminal.status === "failed" || terminal.status === "cancelled" || timedOut) {
        const existing = warmHandles.get(prepared.sessionKey);
        if (warmHandleMatches(existing, runtime, sessionHandle) && existing) {
          await closeWarmHandle({
            handles: warmHandles,
            key: prepared.sessionKey,
            entry: existing,
            reason: timedOut ? "paperclip timeout cleanup" : `paperclip turn ${terminal.status}`,
            discardPersistentState: terminal.status === "cancelled" || timedOut,
          });
        } else {
          await runtime.close({
            handle: sessionHandle,
            reason: timedOut ? "paperclip timeout cleanup" : `paperclip turn ${terminal.status}`,
            discardPersistentState: terminal.status === "cancelled" || timedOut,
          }).catch(() => {});
        }
      } else if (prepared.mode === "persistent" && warmIdleMs > 0 && !prepared.processSessionBridge) {
        const existing = warmHandles.get(prepared.sessionKey);
        if (existing && !warmHandleMatches(existing, runtime, sessionHandle)) {
          await runtime.close({
            handle: sessionHandle,
            reason: "paperclip duplicate warm handle cleanup",
            discardPersistentState: false,
          }).catch(() => {});
        } else {
          const entry: RuntimeCacheEntry = {
            runtime,
            handle: sessionHandle,
            fingerprint: prepared.fingerprint,
            lastUsedAt: now(),
          };
          warmHandles.set(prepared.sessionKey, entry);
          scheduleIdleHandleCleanup({
            handles: warmHandles,
            key: prepared.sessionKey,
            entry,
            idleMs: warmIdleMs,
            now,
          });
        }
      } else {
        const existing = warmHandles.get(prepared.sessionKey);
        if (warmHandleMatches(existing, runtime, sessionHandle) && existing) {
          await closeWarmHandle({
            handles: warmHandles,
            key: prepared.sessionKey,
            entry: existing,
            reason: "paperclip completed turn cleanup",
          });
        } else {
          await runtime.close({
            handle: sessionHandle,
            reason: "paperclip completed turn cleanup",
            discardPersistentState: false,
          }).catch(() => {});
        }
      }

      const errorMessage = timedOut
        ? formatAdapterExecutionTimeoutErrorMessage(prepared.timeoutResolution)
        : resultErrorMessage(terminal);
      const terminalStopReason = terminal.status === "failed" ? terminal.error.message : terminal.stopReason;
      await emitAcpxLog(ctx, {
        type: terminal.status === "completed" ? "acpx.result" : "acpx.error",
        summary: terminal.status,
        stopReason: terminalStopReason,
        message: errorMessage,
      });
      await cleanupRemoteBridges(prepared);
      return {
        exitCode: terminal.status === "completed" ? 0 : 1,
        signal: timedOut ? "SIGTERM" : null,
        timedOut,
        errorMessage,
        errorCode: terminal.status === "failed" ? "acpx_turn_failed" : timedOut ? "acpx_timeout" : null,
        sessionId: sessionHandle.backendSessionId ?? sessionHandle.runtimeSessionName,
        sessionParams: buildSessionParams({ prepared, handle: sessionHandle }),
        sessionDisplayId: sessionHandle.agentSessionId ?? sessionHandle.backendSessionId ?? sessionHandle.runtimeSessionName,
        ...billingFields,
        model: prepared.requestedModel || null,
        ...(turnUsage.usage ? { usage: turnUsage.usage, usageBasis: "per_run" as const } : {}),
        costUsd: turnUsage.costUsd,
        resultJson: {
          status: terminal.status,
          stopReason: terminalStopReason,
          permissionMode: prepared.permissionMode,
          mode: prepared.mode,
          requestedModel: prepared.requestedModel || null,
          requestedThinkingEffort: prepared.requestedThinkingEffort || null,
          fastMode: prepared.fastMode,
          ...(turnUsage.usageDetail ? { usage: turnUsage.usageDetail } : {}),
          ...(turnUsage.cumulativeCostUsd != null
            ? { cumulativeCostUsd: turnUsage.cumulativeCostUsd }
            : {}),
        },
        summary: textParts.join("").trim() || terminalStopReason || terminal.status,
        clearSession,
      };
    } catch (err) {
      if (timeout) clearTimeout(timeout);
      const messageOverride = timedOut
        ? formatAdapterExecutionTimeoutErrorMessage(prepared.timeoutResolution)
        : undefined;
      const cancel = cancelActiveTurn as ((reason: string) => Promise<void>) | null;
      const preEmitMessage =
        messageOverride ?? (err instanceof Error ? err.message : String(err));
      if (cancel) await cancel(preEmitMessage).catch(() => {});
      await runtime.close({
        handle: sessionHandle,
        reason: timedOut ? "paperclip timeout cleanup" : "paperclip error cleanup",
        discardPersistentState: timedOut,
      }).catch(() => {});
      const existing = warmHandles.get(prepared.sessionKey);
      if (warmHandleMatches(existing, runtime, sessionHandle) && existing) {
        clearWarmHandleTimer(existing);
        warmHandles.delete(prepared.sessionKey);
      }
      const { classified, message } = await emitAcpxFailure({
        ctx,
        prepared,
        err,
        phase: "turn",
        messageOverride,
      });
      await cleanupRemoteBridges(prepared);
      return {
        exitCode: 1,
        signal: timedOut ? "SIGTERM" : null,
        timedOut,
        errorMessage: message,
        errorCode: timedOut ? "acpx_timeout" : classified.errorCode,
        errorMeta: classified.errorMeta,
        ...billingFields,
        model: prepared.requestedModel || null,
        clearSession: clearSession || timedOut,
        resultJson: { phase: "turn" },
        summary: message,
      };
    }
  };
}


export const execute = createAcpxEngineExecutor();
