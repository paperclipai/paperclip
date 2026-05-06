import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { readAdapterExecutionTarget, adapterExecutionTargetSessionIdentity } from "@paperclipai/adapter-utils/execution-target";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  applyPaperclipWorkspaceEnv,
  asNumber,
  asString,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  materializePaperclipSkillCopy,
  parseObject,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolvePaperclipDesiredSkillNames,
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
  type AcpRuntimeTurn,
  type AcpRuntimeTurnResult,
} from "acpx/runtime";
import {
  DEFAULT_ACPX_LOCAL_AGENT,
  DEFAULT_ACPX_LOCAL_MODE,
  DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACPX_LOCAL_PERMISSION_MODE,
  DEFAULT_ACPX_LOCAL_TIMEOUT_SEC,
  DEFAULT_ACPX_LOCAL_WARM_HANDLE_IDLE_MS,
} from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER_CLEANUP_RETENTION_MS = 15 * 60 * 1000;
const PAPERCLIP_MANAGED_CODEX_SKILLS_MANIFEST = ".paperclip-managed-skills.json";

type AcpxRuntimeFactory = (options: AcpRuntimeOptions) => AcpRuntime;

interface RuntimeCacheEntry {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  fingerprint: string;
  lastUsedAt: number;
  cleanupTimer?: NodeJS.Timeout;
}

interface ExecuteDeps {
  createRuntime?: AcpxRuntimeFactory;
  now?: () => number;
  warmHandles?: Map<string, RuntimeCacheEntry>;
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
  sessionKey: string;
  fingerprint: string;
  agentCommand: string | null;
  agentRegistry: AcpAgentRegistry;
  remoteExecutionIdentity: Record<string, unknown> | null;
  skillPromptInstructions: string;
  skillsIdentity: Record<string, unknown>;
}

const defaultWarmHandles = new Map<string, RuntimeCacheEntry>();

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
  return path.join(home, "instances", instanceId);
}

function defaultStateDir(companyId: string, agentId: string): string {
  return path.join(defaultPaperclipInstanceDir(), "companies", companyId, "acpx-local", "agents", agentId);
}

function resolveManagedCodexHomeDir(companyId: string): string {
  return path.join(defaultPaperclipInstanceDir(), "companies", companyId, "codex-home");
}

function packageRootDir(): string {
  return path.resolve(__moduleDir, "../..");
}

function resolveBuiltInAgentCommand(agent: string): string | null {
  const binName =
    agent === "claude"
      ? "claude-agent-acp"
      : agent === "codex"
        ? "codex-acp"
        : null;
  if (!binName) return null;
  return path.join(packageRootDir(), "node_modules", ".bin", binName);
}

function normalizeAgent(config: Record<string, unknown>): string {
  const agent = asString(config.agent, DEFAULT_ACPX_LOCAL_AGENT).trim();
  return agent || DEFAULT_ACPX_LOCAL_AGENT;
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
): Promise<{ allSkills: PaperclipSkillEntry[]; selectedSkills: PaperclipSkillEntry[]; desiredSkillNames: string[] }> {
  const allSkills = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
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
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{
  identity: Record<string, unknown>;
  promptInstructions: string;
  commandNotes: string[];
}> {
  const { selectedSkills, desiredSkillNames } = await resolveSelectedRuntimeSkills(input.config);
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
  const { allSkills, selectedSkills, desiredSkillNames } = await resolveSelectedRuntimeSkills(input.config);
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

function normalizeMode(config: Record<string, unknown>): "persistent" | "oneshot" {
  return asString(config.mode, DEFAULT_ACPX_LOCAL_MODE) === "oneshot" ? "oneshot" : "persistent";
}

function normalizePermissionMode(config: Record<string, unknown>): "approve-all" | "approve-reads" | "deny-all" {
  const value = asString(config.permissionMode, DEFAULT_ACPX_LOCAL_PERMISSION_MODE).trim();
  if (value === "approve-reads" || value === "deny-all") return value;
  if (value === "default") return "approve-reads";
  return "approve-all";
}

function normalizeNonInteractivePermissions(config: Record<string, unknown>): "deny" | "fail" {
  return asString(config.nonInteractivePermissions, DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS) === "fail"
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
    ...(prepared.workspaceId ? { workspaceId: prepared.workspaceId } : {}),
    ...(prepared.workspaceRepoUrl ? { repoUrl: prepared.workspaceRepoUrl } : {}),
    ...(prepared.workspaceRepoRef ? { repoRef: prepared.workspaceRepoRef } : {}),
    ...(prepared.remoteExecutionIdentity ? { remoteExecution: prepared.remoteExecutionIdentity } : {}),
  };
}

async function writeAgentWrapper(input: {
  stateDir: string;
  acpxAgent: string;
  agentCommandShell: string;
  env: Record<string, string>;
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
}): Promise<AcpxPreparedRuntime> {
  const { runId, agent, config, context, authToken } = input.ctx;
  const workspaceContext = parseObject(context.paperclipWorkspace);
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
  const shapedWorkspaceEnv = shapePaperclipWorkspaceEnvForExecution({
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceWorktreePath,
    executionTargetIsRemote: remoteExecutionIdentity !== null,
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
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_ACPX_LOCAL_TIMEOUT_SEC);
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
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) env.PAPERCLIP_API_KEY = authToken;

  let skillPromptInstructions = "";
  let skillsIdentity: Record<string, unknown> = { mode: "unsupported" };
  const skillCommandNotes: string[] = [];
  if (acpxAgent === "claude") {
    const preparedSkills = await prepareClaudeSkillRuntime({
      stateDir,
      config,
      onLog: input.ctx.onLog,
    });
    skillPromptInstructions = preparedSkills.promptInstructions;
    skillsIdentity = preparedSkills.identity;
    skillCommandNotes.push(...preparedSkills.commandNotes);
  } else if (acpxAgent === "codex") {
    const preparedSkills = await prepareCodexSkillRuntime({
      companyId: agent.companyId,
      config,
      env,
      onLog: input.ctx.onLog,
    });
    skillsIdentity = preparedSkills.identity;
    skillCommandNotes.push(...preparedSkills.commandNotes);
  } else {
    const desired = resolvePaperclipDesiredSkillNames(config, await readPaperclipRuntimeSkillEntries(config, __moduleDir));
    skillsIdentity = { mode: "custom_unsupported", desiredSkillNames: desired };
    if (desired.length > 0) {
      skillCommandNotes.push("Selected Paperclip skills are tracked only; ACPX custom commands do not expose a runtime skill contract yet.");
    }
  }

  const configuredCommand = asString(config.agentCommand, "").trim();
  const builtInCommand = resolveBuiltInAgentCommand(acpxAgent);
  const agentCommand = configuredCommand || builtInCommand || null;
  const agentCommandShell = configuredCommand || (builtInCommand ? shellQuote(builtInCommand) : "");
  const wrapper = agentCommand
    ? await writeAgentWrapper({
        stateDir,
        acpxAgent,
        agentCommandShell,
        env,
      })
    : null;
  const wrapperPath = wrapper?.wrapperPath ?? null;
  const overrides = wrapperPath ? { [acpxAgent]: wrapperPath } : undefined;
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
  });
  const taskKey = asString(input.ctx.runtime.taskKey, "") || wakeTaskId || workspaceId || "default";
  const sessionKey = `paperclip:${agent.companyId}:${agent.id}:${taskKey}:${fingerprint}`;
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
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
    sessionKey,
    fingerprint,
    agentCommand,
    agentRegistry,
    remoteExecutionIdentity,
    skillPromptInstructions,
    skillsIdentity: {
      ...skillsIdentity,
      commandNotes: skillCommandNotes,
    },
  };
}

function sessionConfigOptions(prepared: AcpxPreparedRuntime): Array<{ key: string; value: string }> {
  const options: Array<{ key: string; value: string }> = [];
  if (prepared.requestedModel) options.push({ key: "model", value: prepared.requestedModel });
  if (prepared.requestedThinkingEffort) {
    options.push({
      key: prepared.acpxAgent === "codex" ? "reasoning_effort" : "effort",
      value: prepared.requestedThinkingEffort,
    });
  }
  if (prepared.fastMode) {
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

async function buildPrompt(ctx: AdapterExecutionContext, resumedSession: boolean): Promise<{
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
  const prompt = joinPromptSections([
    promptInstructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
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
    await emitAcpxLog(ctx, {
      type: "acpx.tool_call",
      name: event.title ?? "acp_tool",
      toolCallId: event.toolCallId,
      status: event.status,
      text: event.text,
      tag: event.tag,
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

function classifyError(err: unknown): Pick<AdapterExecutionResult, "errorCode" | "errorMeta"> {
  const message = err instanceof Error ? err.message : String(err);
  const maybeCode =
    err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : null;
  const acpCode = isAcpRuntimeError(err) || (maybeCode?.startsWith("ACP_") ?? false) ? maybeCode : null;
  const lower = message.toLowerCase();
  const authLike = lower.includes("auth") || lower.includes("login") || lower.includes("credential");
  if (authLike) {
    return {
      errorCode: "acpx_auth_required",
      errorMeta: { category: "auth", ...(acpCode ? { acpCode } : {}) },
    };
  }
  if (acpCode) {
    return {
      errorCode: "acpx_protocol_error",
      errorMeta: { category: "protocol", acpCode },
    };
  }
  return {
    errorCode: "acpx_runtime_error",
    errorMeta: { category: "runtime" },
  };
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
  return entry?.runtime === runtime && entry.handle === handle;
}

export function createAcpxLocalExecutor(deps: ExecuteDeps = {}) {
  const createRuntime = deps.createRuntime ?? createAcpRuntime;
  const now = deps.now ?? (() => Date.now());
  const warmHandles = deps.warmHandles ?? defaultWarmHandles;

  return async function executeAcpxLocal(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const prepared = await buildRuntime({ ctx });
    const warmIdleMs = asNumber(ctx.config.warmHandleIdleMs, DEFAULT_ACPX_LOCAL_WARM_HANDLE_IDLE_MS);
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
      timeoutMs: prepared.timeoutSec > 0 ? prepared.timeoutSec * 1000 : undefined,
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
      const classified = classifyError(err);
      const message = err instanceof Error ? err.message : String(err);
      await emitAcpxLog(ctx, { type: "acpx.error", message, ...classified.errorMeta });
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
        ...classified,
        provider: "acpx",
        model: prepared.requestedModel || null,
        clearSession,
        resultJson: { phase: "ensure_session" },
        summary: message,
      };
    }

    if (!handle) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "ACPX did not return a runtime session handle.",
        errorCode: "acpx_runtime_error",
        provider: "acpx",
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
      const classified = classifyError(err);
      const message = err instanceof Error ? err.message : String(err);
      await emitAcpxLog(ctx, { type: "acpx.error", message, ...classified.errorMeta });
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
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
        ...classified,
        provider: "acpx",
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
    const { prompt, promptMetrics, commandNotes } = await buildPrompt(ctx, resumedSession);
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
        adapterType: "acpx_local",
        command: prepared.agentCommand ?? prepared.acpxAgent,
        cwd: prepared.cwd,
        commandNotes: [
          `ACPX runtime embedded in Paperclip with ${prepared.mode} session mode.`,
          `Effective ACPX permission mode: ${prepared.permissionMode}.`,
          ...(prepared.requestedModel ? [`Requested ACPX model: ${prepared.requestedModel}.`] : []),
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
    try {
      const timeoutMs = prepared.timeoutSec > 0 ? prepared.timeoutSec * 1000 : undefined;
      controller = new AbortController();
      if (timeoutMs) {
        timeout = setTimeout(() => {
          timedOut = true;
          controller?.abort();
          void cancelActiveTurn?.(`Timed out after ${prepared.timeoutSec}s`).catch(() => {});
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
        await emitRuntimeEvent(ctx, event);
      }
      const terminal = await turn.result;
      if (timeout) clearTimeout(timeout);
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
      } else if (prepared.mode === "persistent" && warmIdleMs > 0) {
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
        ? `Timed out after ${prepared.timeoutSec}s`
        : resultErrorMessage(terminal);
      const terminalStopReason = terminal.status === "failed" ? terminal.error.message : terminal.stopReason;
      await emitAcpxLog(ctx, {
        type: terminal.status === "completed" ? "acpx.result" : "acpx.error",
        summary: terminal.status,
        stopReason: terminalStopReason,
        message: errorMessage,
      });
      return {
        exitCode: terminal.status === "completed" ? 0 : 1,
        signal: timedOut ? "SIGTERM" : null,
        timedOut,
        errorMessage,
        errorCode: terminal.status === "failed" ? "acpx_turn_failed" : timedOut ? "acpx_timeout" : null,
        sessionId: sessionHandle.backendSessionId ?? sessionHandle.runtimeSessionName,
        sessionParams: buildSessionParams({ prepared, handle: sessionHandle }),
        sessionDisplayId: sessionHandle.agentSessionId ?? sessionHandle.backendSessionId ?? sessionHandle.runtimeSessionName,
        provider: "acpx",
        model: prepared.requestedModel || null,
        billingType: "unknown",
        costUsd: null,
        resultJson: {
          status: terminal.status,
          stopReason: terminalStopReason,
          permissionMode: prepared.permissionMode,
          mode: prepared.mode,
          requestedModel: prepared.requestedModel || null,
          requestedThinkingEffort: prepared.requestedThinkingEffort || null,
          fastMode: prepared.fastMode,
        },
        summary: textParts.join("").trim() || terminalStopReason || terminal.status,
        clearSession,
      };
    } catch (err) {
      if (timeout) clearTimeout(timeout);
      const classified = classifyError(err);
      const message = timedOut ? `Timed out after ${prepared.timeoutSec}s` : err instanceof Error ? err.message : String(err);
      const cancel = cancelActiveTurn as ((reason: string) => Promise<void>) | null;
      if (cancel) await cancel(message).catch(() => {});
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
      await emitAcpxLog(ctx, { type: "acpx.error", message, ...classified.errorMeta });
      return {
        exitCode: 1,
        signal: timedOut ? "SIGTERM" : null,
        timedOut,
        errorMessage: message,
        errorCode: timedOut ? "acpx_timeout" : classified.errorCode,
        errorMeta: classified.errorMeta,
        provider: "acpx",
        model: prepared.requestedModel || null,
        clearSession: clearSession || timedOut,
        resultJson: { phase: "turn" },
        summary: message,
      };
    }
  };
}

export const execute = createAcpxLocalExecutor();
