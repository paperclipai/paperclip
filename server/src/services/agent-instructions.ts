import { inspectAgentFile, fileHash, agentFilePath, MAX_AGENT_FILE_BYTES } from "./agent-file-store.js";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agentInstructionHeads, agents, type Db } from "@paperclipai/db";
import { instructionPath, assertInstructionPathSafe, instructionBytes, readInstructionBytes } from "./agent-instruction-files.js";
import { notFound, unprocessable } from "../errors.js";
import { resolveHomeAwarePath, resolvePaperclipInstanceRoot } from "../home-paths.js";

const ENTRY_FILE_DEFAULT = "AGENTS.md";
const MODE_KEY = "instructionsBundleMode";
const ROOT_KEY = "instructionsRootPath";
const ENTRY_KEY = "instructionsEntryFile";
const FILE_KEY = "instructionsFilePath";
const PROMPT_KEY = "promptTemplate";
/** @deprecated Use the managed instructions bundle system instead. */
const BOOTSTRAP_PROMPT_KEY = "bootstrapPromptTemplate";
const LEGACY_PROMPT_TEMPLATE_PATH = "promptTemplate.legacy.md";
const IGNORED_INSTRUCTIONS_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);
const IGNORED_INSTRUCTIONS_DIRECTORY_NAMES = new Set([
  ".git",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);

type BundleMode = "managed" | "external";

type AgentLike = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: unknown;
};

type AgentInstructionsFileSummary = {
  path: string;
  contentHash?: string;
  binary?: boolean;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
};

type AgentInstructionsFileDetail = AgentInstructionsFileSummary & {
  content: string;
  editable: boolean;
};

type AgentInstructionsBundle = {
  agentId: string;
  companyId: string;
  persistence?: "agent_files";
  mode: BundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
};

type BundleState = {
  config: Record<string, unknown>;
  mode: BundleMode | null;
  rootPath: string | null;
  entryFile: string;
  resolvedEntryPath: string | null;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isBundleMode(value: unknown): value is BundleMode {
  return value === "managed" || value === "external";
}

function inferLanguage(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  if (lower.endsWith(".sh")) return "bash";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".txt")) return "text";
  return "text";
}

function isMarkdown(relativePath: string) {
  return relativePath.toLowerCase().endsWith(".md");
}

function normalizeRelativeFilePath(candidatePath: string): string {
  return instructionPath(candidatePath);
}

function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativeFilePath(relativePath);
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return absolutePath;
}

export function resolveManagedInstructionsRoot(agent: AgentLike): string {
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "companies",
    agent.companyId,
    "agents",
    agent.id,
    "instructions",
  );
}

function resolveLegacyInstructionsPath(candidatePath: string, config: Record<string, unknown>): string {
  if (path.isAbsolute(candidatePath)) return candidatePath;
  const cwd = asString(config.cwd);
  if (!cwd || !path.isAbsolute(cwd)) {
    throw unprocessable(
      "Legacy relative instructionsFilePath requires adapterConfig.cwd to be set to an absolute path",
    );
  }
  return path.resolve(cwd, candidatePath);
}

async function statIfExists(targetPath: string) {
  return fs.lstat(targetPath).catch(() => null);
}

function shouldIgnoreInstructionsEntry(entry: { name: string; isDirectory(): boolean; isFile(): boolean }) {
  if (entry.name === "." || entry.name === "..") return true;
  if (entry.isDirectory()) {
    return IGNORED_INSTRUCTIONS_DIRECTORY_NAMES.has(entry.name);
  }
  if (!entry.isFile()) return false;
  return (
    IGNORED_INSTRUCTIONS_FILE_NAMES.has(entry.name)
    || entry.name.startsWith("._")
    || entry.name.endsWith(".pyc")
    || entry.name.endsWith(".pyo")
  );
}

async function listFilesRecursive(
  rootPath: string,
  options?: { rejectSymlinks?: boolean; legacyExcludes?: boolean },
): Promise<string[]> {
  const output: string[] = [];

  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (options?.legacyExcludes && shouldIgnoreInstructionsEntry(entry)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = normalizeRelativeFilePath(
        relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name,
      );
      if (entry.isSymbolicLink()) {
        if (options?.rejectSymlinks) {
          throw unprocessable(`Instructions bundle may not contain symlinks: ${relativePath}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      output.push(relativePath);
    }
  }

  await walk(rootPath, "");
  return output.sort((left, right) => left.localeCompare(right));
}

async function readFileSummary(rootPath: string, relativePath: string, entryFile: string): Promise<AgentInstructionsFileSummary> {
  const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
  const stat = await fs.stat(absolutePath);
  // External bundles may contain large assets; listing must not read them.
  const file = stat.size > MAX_AGENT_FILE_BYTES ? null : await inspectAgentFile(rootPath, relativePath);
  return summarizeFile(relativePath, entryFile, file?.size ?? stat.size, file?.bytes ?? null, file?.hash);
}

function summarizeFile(relativePath: string, entryFile: string, size: number, bytes: Buffer | null, hash?: string): AgentInstructionsFileSummary {
  let binary = bytes === null;
  try { if (bytes?.includes(0)) binary = true; new TextDecoder("utf-8", { fatal: true }).decode(bytes ?? undefined); } catch { binary = true; }
  return {
    path: relativePath,
    size,
    language: inferLanguage(relativePath),
    markdown: isMarkdown(relativePath),
    isEntryFile: relativePath === entryFile,
    editable: !binary, binary, contentHash: hash,
    deprecated: false,
    virtual: false,
  };
}

async function readLegacyInstructions(agent: AgentLike, config: Record<string, unknown>): Promise<string> {
  const instructionsFilePath = asString(config[FILE_KEY]);
  if (instructionsFilePath) {
    try {
      const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, config);
      return await fs.readFile(resolvedPath, "utf8");
    } catch {
      // Fall back to promptTemplate below.
    }
  }
  return asString(config[PROMPT_KEY]) ?? "";
}

export function deriveBundleState(agent: AgentLike): BundleState {
  const config = asRecord(agent.adapterConfig);
  const warnings: string[] = [];
  const storedModeRaw = config[MODE_KEY];
  const storedRootRaw = asString(config[ROOT_KEY]);
  const legacyInstructionsPath = asString(config[FILE_KEY]);

  let mode: BundleMode | null = isBundleMode(storedModeRaw) ? storedModeRaw : null;
  let rootPath = storedRootRaw ? resolveHomeAwarePath(storedRootRaw) : null;
  let entryFile = ENTRY_FILE_DEFAULT;

  const storedEntryRaw = asString(config[ENTRY_KEY]);
  if (storedEntryRaw) {
    try {
      // Historical config accepted normalized relative paths. Keep that read
      // compatibility; new API writes still use strict instructionPath validation.
      entryFile = normalizeRelativeFilePath(path.posix.normalize(storedEntryRaw.replaceAll("\\", "/")).replace(/^\/+/, ""));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!rootPath && legacyInstructionsPath) {
    try {
      const resolvedLegacyPath = resolveLegacyInstructionsPath(legacyInstructionsPath, config);
      const managedRoot = resolveManagedInstructionsRoot(agent);
      const managedRelative = path.relative(managedRoot, resolvedLegacyPath);
      const inManagedRoot = managedRelative !== ".." && !managedRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(managedRelative);
      rootPath = inManagedRoot ? managedRoot : path.dirname(resolvedLegacyPath);
      entryFile = inManagedRoot ? instructionPath(managedRelative.split(path.sep).join("/")) : path.basename(resolvedLegacyPath);
      mode = inManagedRoot ? "managed" : "external";
      if (!path.isAbsolute(legacyInstructionsPath)) {
        warnings.push("Using legacy relative instructionsFilePath; migrate this agent to a managed or absolute external bundle.");
      }
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  const resolvedEntryPath = rootPath ? path.resolve(rootPath, entryFile) : null;

  return {
    config,
    mode,
    rootPath,
    entryFile,
    resolvedEntryPath,
    warnings,
    legacyPromptTemplateActive: Boolean(asString(config[PROMPT_KEY])),
    legacyBootstrapPromptTemplateActive: Boolean(asString(config[BOOTSTRAP_PROMPT_KEY])),
  };
}

/** Classify the configured bundle without touching the filesystem. */
export function agentInstructionsBundleMode(agent: AgentLike): BundleMode | null {
  const state = deriveBundleState(agent);
  if (state.mode === "external") return "external";
  if (
    state.rootPath
    && path.resolve(state.rootPath) !== resolveManagedInstructionsRoot(agent)
  ) {
    return "external";
  }
  return state.mode;
}

async function recoverManagedBundleState(agent: AgentLike, state: BundleState): Promise<BundleState> {
  const managedRootPath = resolveManagedInstructionsRoot(agent);
  const stat = await statIfExists(managedRootPath);
  if (!stat?.isDirectory()) return state;

  const files = await listFilesRecursive(managedRootPath);
  if (files.length === 0) return state;

  const recoveredEntryFile = asString(state.config[ENTRY_KEY]) ? state.entryFile : files.includes(state.entryFile)
    ? state.entryFile
    : files.includes(ENTRY_FILE_DEFAULT)
      ? ENTRY_FILE_DEFAULT
      : files[0]!;

  if (!state.rootPath) {
    return {
      ...state,
      mode: "managed",
      rootPath: managedRootPath,
      entryFile: recoveredEntryFile,
      resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
    };
  }

  if (state.mode === "external") return state;

  const resolvedConfiguredRoot = path.resolve(state.rootPath);
  const configuredRootMatchesManaged = resolvedConfiguredRoot === managedRootPath;
  const hasEntryMismatch = recoveredEntryFile !== state.entryFile;

  if (configuredRootMatchesManaged && !hasEntryMismatch) {
    return state;
  }

  const warnings = [...state.warnings];
  if (!configuredRootMatchesManaged) {
    warnings.push(
      `Recovered managed instructions from disk at ${managedRootPath}; ignoring stale configured root ${state.rootPath}.`,
    );
  }
  if (hasEntryMismatch) {
    warnings.push(
      `Recovered managed instructions entry file from disk as ${recoveredEntryFile}; previous entry ${state.entryFile} was missing.`,
    );
  }

  return {
    ...state,
    mode: "managed",
    rootPath: managedRootPath,
    entryFile: recoveredEntryFile,
    resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
    warnings,
  };
}

function toBundle(agent: AgentLike, state: BundleState, files: AgentInstructionsFileSummary[]): AgentInstructionsBundle {
  const nextFiles = [...files];
  if (state.legacyPromptTemplateActive && !nextFiles.some((file) => file.path === LEGACY_PROMPT_TEMPLATE_PATH)) {
    const legacyPromptTemplate = asString(state.config[PROMPT_KEY]) ?? "";
    nextFiles.push({
      path: LEGACY_PROMPT_TEMPLATE_PATH,
      size: legacyPromptTemplate.length,
      language: "markdown",
      markdown: true,
      isEntryFile: false,
      editable: true,
      deprecated: true,
      virtual: true,
    });
  }
  nextFiles.sort((left, right) => left.path.localeCompare(right.path));
  return {
    agentId: agent.id,
    companyId: agent.companyId,
    ...(state.mode === "managed" ? { persistence: "agent_files" as const } : {}),
    mode: state.mode,
    rootPath: state.rootPath,
    managedRootPath: resolveManagedInstructionsRoot(agent),
    entryFile: state.entryFile,
    resolvedEntryPath: state.resolvedEntryPath,
    editable: Boolean(state.rootPath),
    warnings: state.warnings,
    legacyPromptTemplateActive: state.legacyPromptTemplateActive,
    legacyBootstrapPromptTemplateActive: state.legacyBootstrapPromptTemplateActive,
    files: nextFiles,
  };
}

function applyBundleConfig(
  config: Record<string, unknown>,
  input: {
    mode: BundleMode;
    rootPath: string;
    entryFile: string;
    clearLegacyPromptTemplate?: boolean;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...config,
    [MODE_KEY]: input.mode,
    [ROOT_KEY]: input.rootPath,
    [ENTRY_KEY]: input.entryFile,
    [FILE_KEY]: path.resolve(input.rootPath, input.entryFile),
  };
  if (input.clearLegacyPromptTemplate) {
    delete next[PROMPT_KEY];
    delete next[BOOTSTRAP_PROMPT_KEY];
  }
  return next;
}

function buildPersistedBundleConfig(
  derived: BundleState,
  current: BundleState,
  options?: { clearLegacyPromptTemplate?: boolean },
): Record<string, unknown> {
  const currentRootPath = current.rootPath ? path.resolve(current.rootPath) : null;
  const derivedRootPath = derived.rootPath ? path.resolve(derived.rootPath) : null;
  const configMatchesRecoveredState =
    derived.mode === current.mode
    && derivedRootPath !== null
    && currentRootPath !== null
    && derivedRootPath === currentRootPath
    && derived.entryFile === current.entryFile;

  if (configMatchesRecoveredState && !options?.clearLegacyPromptTemplate) {
    return current.config;
  }

  if (!current.rootPath || !current.mode) {
    return current.config;
  }

  return applyBundleConfig(current.config, {
    mode: current.mode,
    rootPath: current.rootPath,
    entryFile: current.entryFile,
    clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
  });
}

async function writeBundleFiles(
  rootPath: string,
  files: Record<string, string>,
  options?: { overwriteExisting?: boolean },
) {
  for (const [relativePath, content] of Object.entries(files)) {
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    instructionBytes(content);
    const absolutePath = await assertInstructionPathSafe(rootPath, normalizedPath);
    const existingStat = await statIfExists(absolutePath);
    if (existingStat?.isFile() && !options?.overwriteExisting) continue;
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
}

export function syncInstructionsBundleConfigFromFilePath(
  agent: AgentLike,
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  const instructionsFilePath = asString(adapterConfig[FILE_KEY]);
  const next = { ...adapterConfig };
  if (!instructionsFilePath) {
    delete next[MODE_KEY];
    delete next[ROOT_KEY];
    delete next[ENTRY_KEY];
    return next;
  }
  const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, adapterConfig);
  const managedRoot = resolveManagedInstructionsRoot(agent);
  const relative = path.relative(managedRoot, resolvedPath);
  const managed = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const rootPath = managed ? managedRoot : path.dirname(resolvedPath);
  const entryFile = managed ? instructionPath(relative.split(path.sep).join("/")) : path.basename(resolvedPath);
  const mode: BundleMode = managed ? "managed" : "external";
  return applyBundleConfig(next, { mode, rootPath, entryFile });
}

export function agentInstructionsService(db?: Db) {
  async function assertUnversionedEntry(agent: AgentLike, entryFile: string, connection: Db | Parameters<Parameters<Db["transaction"]>[0]>[0] | undefined = db) {
    if (!connection) throw unprocessable("Bundle initialization requires the database-backed instructions service");
    const [head] = await connection.select().from(agentInstructionHeads).where(and(eq(agentInstructionHeads.companyId, agent.companyId),
      eq(agentInstructionHeads.agentId, agent.id), eq(agentInstructionHeads.entryFile, entryFile)));
    if (head) throw unprocessable("This entry has revision history. Use the instruction content API with its baseRevisionId to update it.", { code: "INSTRUCTION_REVISION_REQUIRED" });
  }
  async function getBundle(agent: AgentLike): Promise<AgentInstructionsBundle> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (!state.rootPath) return toBundle(agent, state, []);
    await assertInstructionPathSafe(state.rootPath, state.entryFile);
    const stat = await statIfExists(state.rootPath);
    if (!stat?.isDirectory()) {
      return toBundle(agent, {
        ...state,
        warnings: [...state.warnings, `Instructions root does not exist: ${state.rootPath}`],
      }, []);
    }
    const files = await listFilesRecursive(state.rootPath, { legacyExcludes: state.mode === "external" });
    const summaries: AgentInstructionsFileSummary[] = [];
    // Bound open descriptors and text buffers even for a large personal folder.
    for (let index = 0; index < files.length; index += 8) {
      summaries.push(...await Promise.all(files.slice(index, index + 8).map(relativePath => readFileSummary(state.rootPath!, relativePath, state.entryFile))));
    }
    return toBundle(agent, state, summaries);
  }

  async function readFile(agent: AgentLike, relativePath: string): Promise<AgentInstructionsFileDetail> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const content = asString(state.config[PROMPT_KEY]);
      if (content === null) throw notFound("Instructions file not found");
      return {
        path: LEGACY_PROMPT_TEMPLATE_PATH,
        size: content.length,
        language: "markdown",
        markdown: true,
        isEntryFile: false,
        editable: true,
        deprecated: true,
        virtual: true,
        content,
      };
    }
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");
    await assertInstructionPathSafe(state.rootPath, relativePath);
    const file = await inspectAgentFile(state.rootPath, relativePath);
    if (file === null) throw notFound("Instructions file not found");
    const summary = summarizeFile(relativePath, state.entryFile, file.size, file.bytes, file.hash);
    return { ...summary, content: summary.binary ? "" : file.bytes!.toString("utf8") };
  }

  async function ensureWritableBundle(
    agent: AgentLike,
    options?: { clearLegacyPromptTemplate?: boolean },
  ): Promise<{ adapterConfig: Record<string, unknown>; state: BundleState }> {
    const derived = deriveBundleState(agent);
    const current = await recoverManagedBundleState(agent, derived);
    if (current.rootPath && current.mode) {
      const adapterConfig = buildPersistedBundleConfig(derived, current, options);
      return {
        adapterConfig,
        state: deriveBundleState({ ...agent, adapterConfig }),
      };
    }

    const managedRoot = resolveManagedInstructionsRoot(agent);
    const entryFile = current.entryFile || ENTRY_FILE_DEFAULT;
    const nextConfig = applyBundleConfig(current.config, {
      mode: "managed",
      rootPath: managedRoot,
      entryFile,
      clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
    });
    await fs.mkdir(managedRoot, { recursive: true });

    const entryPath = await assertInstructionPathSafe(managedRoot, entryFile);
    const entryStat = await statIfExists(entryPath);
    if (!entryStat?.isFile()) {
      const legacyInstructions = await readLegacyInstructions(agent, current.config);
      if (legacyInstructions.trim().length > 0) {
        await assertUnversionedEntry(agent, entryFile);
        await fs.mkdir(path.dirname(entryPath), { recursive: true });
        await fs.writeFile(entryPath, legacyInstructions, "utf8");
      }
    }

    return {
      adapterConfig: nextConfig,
      state: deriveBundleState({ ...agent, adapterConfig: nextConfig }),
    };
  }

  async function updateBundle(
    agent: AgentLike,
    input: {
      mode?: BundleMode;
      rootPath?: string | null;
      entryFile?: string;
      clearLegacyPromptTemplate?: boolean;
    },
  ): Promise<{ bundle: AgentInstructionsBundle; adapterConfig: Record<string, unknown> }> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    const nextMode = input.mode ?? state.mode ?? "managed";
    const nextEntryFile = input.entryFile ? normalizeRelativeFilePath(input.entryFile) : state.entryFile;
    let nextRootPath: string;

    if (nextMode === "managed") {
      nextRootPath = resolveManagedInstructionsRoot(agent);
    } else {
      const rootPath = asString(input.rootPath) ?? state.rootPath;
      if (!rootPath) {
        throw unprocessable("External instructions bundles require an absolute rootPath");
      }
      const resolvedRoot = resolveHomeAwarePath(rootPath);
      if (!path.isAbsolute(resolvedRoot)) {
        throw unprocessable("External instructions bundles require an absolute rootPath");
      }
      nextRootPath = resolvedRoot;
    }

    await assertInstructionPathSafe(nextRootPath, nextEntryFile);
    await fs.mkdir(nextRootPath, { recursive: true });

    const existingFiles = await listFilesRecursive(nextRootPath);
    if (nextMode === "managed" && !existingFiles.includes(nextEntryFile)) {
      await assertUnversionedEntry(agent, nextEntryFile);
    }
    const exported = await exportFiles(agent);
    if (existingFiles.length === 0) {
      await writeBundleFiles(nextRootPath, exported.files);
    }
    const refreshedFiles = existingFiles.length === 0 ? await listFilesRecursive(nextRootPath) : existingFiles;
    if (!refreshedFiles.includes(nextEntryFile)) {
      const nextEntryContent = exported.files[nextEntryFile] ?? exported.files[exported.entryFile] ?? "";
      await writeBundleFiles(nextRootPath, { [nextEntryFile]: nextEntryContent });
    }

    const nextConfig = applyBundleConfig(state.config, {
      mode: nextMode,
      rootPath: nextRootPath,
      entryFile: nextEntryFile,
      clearLegacyPromptTemplate: input.clearLegacyPromptTemplate,
    });
    const nextBundle = await getBundle({ ...agent, adapterConfig: nextConfig });
    return { bundle: nextBundle, adapterConfig: nextConfig };
  }

  async function writeFileUnversioned(
    agent: AgentLike,
    relativePath: string,
    content: string,
    options?: { clearLegacyPromptTemplate?: boolean },
  ): Promise<{
    bundle: AgentInstructionsBundle;
    file: AgentInstructionsFileDetail;
    adapterConfig: Record<string, unknown>;
  }> {
    const current = deriveBundleState(agent);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const adapterConfig: Record<string, unknown> = {
        ...current.config,
        [PROMPT_KEY]: content,
      };
      const nextAgent = { ...agent, adapterConfig };
      const [bundle, file] = await Promise.all([
        getBundle(nextAgent),
        readFile(nextAgent, LEGACY_PROMPT_TEMPLATE_PATH),
      ]);
      return { bundle, file, adapterConfig };
    }

    const configured = await recoverManagedBundleState(agent, current);
    if (normalizeRelativeFilePath(relativePath) === configured.entryFile) {
      throw unprocessable("Entry edits require the canonical instruction commit service and baseRevisionId", { code: "INSTRUCTION_REVISION_REQUIRED" });
    }
    if (configured.mode !== "external") agentFilePath(relativePath);
    const prepared = await ensureWritableBundle(agent, options);
    instructionBytes(content);
    await assertInstructionPathSafe(prepared.state.rootPath!, relativePath);
    const absolutePath = resolvePathWithinRoot(prepared.state.rootPath!, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    const nextAgent = { ...agent, adapterConfig: prepared.adapterConfig };
    const [bundle, file] = await Promise.all([
      getBundle(nextAgent),
      readFile(nextAgent, relativePath),
    ]);
    return { bundle, file, adapterConfig: prepared.adapterConfig };
  }

  async function deleteFileUnversioned(agent: AgentLike, relativePath: string): Promise<{
    bundle: AgentInstructionsBundle;
    adapterConfig: Record<string, unknown>;
  }> {
    const derived = deriveBundleState(agent);
    const state = await recoverManagedBundleState(agent, derived);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      throw unprocessable("Cannot delete the legacy promptTemplate pseudo-file");
    }
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    if (normalizedPath === state.entryFile) {
      throw unprocessable("Cannot delete the bundle entry file");
    }
    const absolutePath = await assertInstructionPathSafe(state.rootPath, normalizedPath);
    await fs.rm(absolutePath, { force: true });
    const adapterConfig = buildPersistedBundleConfig(derived, state);
    const bundle = await getBundle({ ...agent, adapterConfig });
    return { bundle, adapterConfig };
  }

  // Reload configuration under the commit lock: a previously supporting file
  // may have become the configured entry since the route loaded its agent.
  async function withCurrentAgent<T>(agent: AgentLike, relativePath: string, operation: (current: AgentLike) => Promise<T>) {
    if (!db) return operation(agent);
    return db.transaction(async (tx) => {
      const [current] = await tx.select().from(agents)
        .where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId))).for("update");
      if (!current) throw notFound("Agent not found");
      if (relativePath !== LEGACY_PROMPT_TEMPLATE_PATH) {
        // Historical entries also remain projections if the configured entry changes.
        await assertUnversionedEntry(current, normalizeRelativeFilePath(relativePath), tx);
      }
      return operation(current);
    });
  }
  async function writeFile(...args: Parameters<typeof writeFileUnversioned>) {
    return withCurrentAgent(args[0], args[1], (current) => writeFileUnversioned(current, args[1], args[2], args[3]));
  }
  async function deleteFile(...args: Parameters<typeof deleteFileUnversioned>) {
    return withCurrentAgent(args[0], args[1], (current) => deleteFileUnversioned(current, args[1]));
  }

  async function exportFiles(agent: AgentLike, options?: { rejectSymlinks?: boolean }): Promise<{
    files: Record<string, string>;
    entryFile: string;
    warnings: string[];
  }> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (state.rootPath) {
      const stat = await statIfExists(state.rootPath);
      if (stat?.isDirectory()) {
        const relativePaths = await listFilesRecursive(state.rootPath, { ...options, legacyExcludes: true });
        const files = Object.fromEntries(await Promise.all(relativePaths.map(async (relativePath) => {
          const absolutePath = resolvePathWithinRoot(state.rootPath!, relativePath);
          const content = await fs.readFile(absolutePath, "utf8");
          return [relativePath, content] as const;
        })));
        if (Object.keys(files).length > 0) {
          return { files, entryFile: state.entryFile, warnings: state.warnings };
        }
      }
    }

    const legacyBody = await readLegacyInstructions(agent, state.config);
    return {
      files: { [state.entryFile]: legacyBody || "_No AGENTS instructions were resolved from current agent config._" },
      entryFile: state.entryFile,
      warnings: state.warnings,
    };
  }

  async function materializeManagedBundleUnversioned(
    agent: AgentLike,
    files: Record<string, string>,
    options?: {
      clearLegacyPromptTemplate?: boolean;
      replaceExisting?: boolean;
      entryFile?: string;
    },
  ): Promise<{ bundle: AgentInstructionsBundle; adapterConfig: Record<string, unknown> }> {
    const rootPath = resolveManagedInstructionsRoot(agent);
    const entryFile = options?.entryFile ? normalizeRelativeFilePath(options.entryFile) : ENTRY_FILE_DEFAULT;

    for (const [relativePath, content] of Object.entries(files)) {
      instructionBytes(content);
      await assertInstructionPathSafe(rootPath, agentFilePath(relativePath));
    }
    const previous = await readInstructionBytes(rootPath, entryFile);
    if (previous && !previous.equals(instructionBytes(files[entryFile] ?? ""))) {
      throw unprocessable("Existing entry content must be saved through the canonical revision API before replacing a bundle", { code: "INSTRUCTION_REVISION_REQUIRED" });
    }
    if (options?.replaceExisting) {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
    await fs.mkdir(rootPath, { recursive: true });

    const normalizedEntries = Object.entries(files).map(([relativePath, content]) => [
      normalizeRelativeFilePath(relativePath),
      content,
    ] as const);
    for (const [relativePath, content] of normalizedEntries) {
      const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
    }
    if (!normalizedEntries.some(([relativePath]) => relativePath === entryFile)) {
      await fs.writeFile(resolvePathWithinRoot(rootPath, entryFile), "", "utf8");
    }

    const adapterConfig = applyBundleConfig(asRecord(agent.adapterConfig), {
      mode: "managed",
      rootPath,
      entryFile,
      clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
    });
    const bundle = await getBundle({ ...agent, adapterConfig });
    return { bundle, adapterConfig };
  }

  async function materializeManagedBundle(
    ...args: Parameters<typeof materializeManagedBundleUnversioned>
  ) {
    if (!db) throw unprocessable("Bundle initialization requires the database-backed instructions service");
    return db.transaction(async (tx) => {
      const agent = args[0];
      const [owner] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId))).for("update");
      if (!owner) throw notFound("Agent not found");
      await assertUnversionedEntry(agent, args[2]?.entryFile ? normalizeRelativeFilePath(args[2].entryFile) : ENTRY_FILE_DEFAULT, tx);
      if (args[2]?.replaceExisting) {
        const [existingHead] = await tx.select({ id: agentInstructionHeads.revisionId }).from(agentInstructionHeads)
          .where(and(eq(agentInstructionHeads.companyId, agent.companyId), eq(agentInstructionHeads.agentId, agent.id))).limit(1);
        if (existingHead) throw unprocessable("Replacing this bundle would remove a versioned entry. Use canonical content commits.", { code: "INSTRUCTION_REVISION_REQUIRED" });
      }
      return materializeManagedBundleUnversioned(...args);
    });
  }

  return {
    getBundle,
    readFile,
    updateBundle,
    writeFile,
    deleteFile,
    exportFiles,
    ensureManagedBundle: ensureWritableBundle,
    materializeManagedBundle,
  };
}
