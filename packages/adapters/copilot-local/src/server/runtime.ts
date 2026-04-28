import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterModel, UsageSummary } from "@paperclipai/adapter-utils";
import {
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  resolveCommandForLogs,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_COPILOT_LOCAL_MODEL } from "../index.js";
import type {
  CopilotClientOptions,
  ModelInfo,
  SessionConfig,
  SessionEvent,
} from "./sdk-client.js";

const SDK_COMMAND_LABEL = "@github/copilot-sdk";
const WRITE_LIKE_TOOL_NAME_RE =
  /(?:^|[_-])(create|write|edit|replace|insert|append|delete|move|rename|remove)(?:[_-]|$)/i;
const PATH_ARG_KEY_RE = /(path|file|source|target|destination|old|new|from|to)/i;

export const COPILOT_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|sign[- ]?in|sign[- ]?up|please\s+log\s*in|not\s+logged\s+in|unauthorized|invalid\s+token|401\b|gh[_\s-]?token|github[_\s-]?token|copilot\s+(?:requires|login)|authentication)/i;

export interface CopilotClientBootstrap {
  clientOptions: CopilotClientOptions;
  command: string;
  commandArgs: string[];
  resolvedCommand: string | null;
  commandNotes: string[];
}

export interface CopilotInstructionsMessage {
  systemMessage: SessionConfig["systemMessage"];
  resolvedInstructionsFilePath: string;
  notes: string[];
  chars: number;
}

interface CopilotShutdownSummary {
  premiumRequests: number;
  totalApiDurationMs: number;
  sessionStartTime: number;
  codeChanges: { linesAdded: number; linesRemoved: number; filesModified: string[] };
  usage: UsageSummary;
  currentModel: string | null;
}

export interface CopilotTurnSummary {
  summary: string;
  usage: UsageSummary;
  premiumRequests: number;
  totalApiDurationMs: number;
  codeChanges: { linesAdded: number; linesRemoved: number; filesModified: string[] } | null;
  model: string | null;
  toolErrors: string[];
  sessionError: Extract<SessionEvent, { type: "session.error" }>["data"] | null;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({
      id,
      label: model.label.trim() || id,
    });
  }
  return deduped;
}

function mergeUniqueStrings(...lists: Array<string[] | null | undefined>): string[] {
  const values = new Set<string>();
  for (const list of lists) {
    for (const value of list ?? []) {
      const trimmed = value.trim();
      if (!trimmed) continue;
      values.add(trimmed);
    }
  }
  return Array.from(values).sort((left, right) =>
    left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }),
  );
}

function usageFromShutdownModelMetrics(
  modelMetrics: Record<
    string,
    {
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
      };
    }
  >,
): UsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  for (const metric of Object.values(modelMetrics)) {
    inputTokens += metric.usage.inputTokens ?? 0;
    outputTokens += metric.usage.outputTokens ?? 0;
    cachedInputTokens += metric.usage.cacheReadTokens ?? 0;
  }
  return { inputTokens, outputTokens, cachedInputTokens };
}

function extractLatestShutdownSummary(events: SessionEvent[]): CopilotShutdownSummary | null {
  let latest: Extract<SessionEvent, { type: "session.shutdown" }> | null = null;
  for (const event of events) {
    if (event.type === "session.shutdown") latest = event;
  }
  if (!latest) return null;
  return {
    premiumRequests: latest.data.totalPremiumRequests,
    totalApiDurationMs: latest.data.totalApiDurationMs,
    sessionStartTime: latest.data.sessionStartTime,
    codeChanges: {
      linesAdded: latest.data.codeChanges.linesAdded,
      linesRemoved: latest.data.codeChanges.linesRemoved,
      filesModified: latest.data.codeChanges.filesModified,
    },
    usage: usageFromShutdownModelMetrics(latest.data.modelMetrics),
    currentModel:
      typeof latest.data.currentModel === "string" && latest.data.currentModel.trim().length > 0
        ? latest.data.currentModel.trim()
        : null,
  };
}

function diffShutdownSummaries(
  baseline: CopilotShutdownSummary | null,
  current: CopilotShutdownSummary,
): CopilotShutdownSummary {
  if (!baseline) return current;
  return {
    premiumRequests: Math.max(0, current.premiumRequests - baseline.premiumRequests),
    totalApiDurationMs: Math.max(0, current.totalApiDurationMs - baseline.totalApiDurationMs),
    sessionStartTime: current.sessionStartTime,
    codeChanges: {
      linesAdded: Math.max(0, current.codeChanges.linesAdded - baseline.codeChanges.linesAdded),
      linesRemoved: Math.max(0, current.codeChanges.linesRemoved - baseline.codeChanges.linesRemoved),
      filesModified: current.codeChanges.filesModified.filter(
        (file) => !baseline.codeChanges.filesModified.includes(file),
      ),
    },
    usage: {
      inputTokens: Math.max(0, current.usage.inputTokens - baseline.usage.inputTokens),
      outputTokens: Math.max(0, current.usage.outputTokens - baseline.usage.outputTokens),
      cachedInputTokens: Math.max(
        0,
        (current.usage.cachedInputTokens ?? 0) - (baseline.usage.cachedInputTokens ?? 0),
      ),
    },
    currentModel: current.currentModel,
  };
}

function collectArgumentPaths(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.add(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectArgumentPaths(entry, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string" && PATH_ARG_KEY_RE.test(key)) {
      const trimmed = nested.trim();
      if (trimmed) out.add(trimmed);
      continue;
    }
    if (nested && (typeof nested === "object" || Array.isArray(nested))) {
      collectArgumentPaths(nested, out, depth + 1);
    }
  }
}

function extractModifiedFilePaths(events: SessionEvent[]): string[] {
  const files = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool.execution_start") continue;
    if (!WRITE_LIKE_TOOL_NAME_RE.test(event.data.toolName)) continue;
    collectArgumentPaths(event.data.arguments, files);
  }
  return mergeUniqueStrings(Array.from(files));
}

function fallbackAssistantUsage(events: SessionEvent[]): UsageSummary {
  let outputTokens = 0;
  for (const event of events) {
    if (event.type !== "assistant.message") continue;
    outputTokens += event.data.outputTokens ?? 0;
  }
  return {
    inputTokens: 0,
    outputTokens,
    cachedInputTokens: 0,
  };
}

function fallbackAssistantUsageEvents(events: SessionEvent[]): {
  usage: UsageSummary;
  premiumRequests: number;
  totalApiDurationMs: number;
  model: string | null;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let premiumRequests = 0;
  let totalApiDurationMs = 0;
  let model: string | null = null;
  let usageEventCount = 0;

  for (const event of events) {
    if (event.type !== "assistant.usage") continue;
    usageEventCount += 1;
    inputTokens += event.data.inputTokens ?? 0;
    outputTokens += event.data.outputTokens ?? 0;
    cachedInputTokens += event.data.cacheReadTokens ?? 0;
    premiumRequests += event.data.cost ?? 0;
    totalApiDurationMs += event.data.duration ?? 0;
    if (!model && event.data.model.trim().length > 0) {
      model = event.data.model.trim();
    }
  }

  if (usageEventCount === 0) {
    return {
      usage: fallbackAssistantUsage(events),
      premiumRequests: 0,
      totalApiDurationMs: 0,
      model,
    };
  }

  return {
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens,
    },
    premiumRequests,
    totalApiDurationMs,
    model,
  };
}

export function summarizeCopilotTurn(
  events: SessionEvent[],
  baselineShutdown: SessionEvent[] = [],
): CopilotTurnSummary {
  const messages: string[] = [];
  const toolErrors: string[] = [];
  let sessionError: CopilotTurnSummary["sessionError"] = null;
  let latestModel: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case "assistant.message":
        if (event.data.content.trim().length > 0) {
          messages.push(event.data.content.trim());
        }
        break;
      case "tool.execution_complete":
        if (!event.data.success && event.data.error?.message.trim()) {
          toolErrors.push(event.data.error.message.trim());
        }
        if (!latestModel && typeof event.data.model === "string" && event.data.model.trim().length > 0) {
          latestModel = event.data.model.trim();
        }
        break;
      case "session.error":
        sessionError = event.data;
        break;
      case "session.start":
        if (
          !latestModel &&
          typeof event.data.selectedModel === "string" &&
          event.data.selectedModel.trim().length > 0
        ) {
          latestModel = event.data.selectedModel.trim();
        }
        break;
    }
  }

  const baseline = extractLatestShutdownSummary(baselineShutdown);
  const current = extractLatestShutdownSummary(events);
  const fallbackUsage = fallbackAssistantUsageEvents(events);
  const modifiedFilesFromTools = extractModifiedFilePaths(events);
  const shutdownDelta = current ? diffShutdownSummaries(baseline, current) : null;

  const summary = messages.join("\n\n").trim();
  const premiumRequests = shutdownDelta?.premiumRequests ?? fallbackUsage.premiumRequests;
  const effectiveSummary =
    summary || (premiumRequests > 0 ? `[Copilot used ${premiumRequests} premium requests]` : "");

  return {
    summary: effectiveSummary,
    usage: shutdownDelta?.usage ?? fallbackUsage.usage,
    premiumRequests,
    totalApiDurationMs: shutdownDelta?.totalApiDurationMs ?? fallbackUsage.totalApiDurationMs,
    codeChanges: shutdownDelta
      ? {
          linesAdded: shutdownDelta.codeChanges.linesAdded,
          linesRemoved: shutdownDelta.codeChanges.linesRemoved,
          filesModified: mergeUniqueStrings(
            shutdownDelta.codeChanges.filesModified,
            modifiedFilesFromTools,
          ),
        }
      : modifiedFilesFromTools.length > 0
        ? {
            linesAdded: 0,
            linesRemoved: 0,
            filesModified: modifiedFilesFromTools,
          }
        : null,
    model: shutdownDelta?.currentModel ?? latestModel ?? fallbackUsage.model,
    toolErrors,
    sessionError,
  };
}

export function normalizeRuntimeEnv(input: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export function normalizeEnvConfig(input: unknown): Record<string, string> {
  return normalizeRuntimeEnv(parseObject(input) as NodeJS.ProcessEnv);
}

export function resolveGithubToken(env: Record<string, string>): string | null {
  const token = (env.COPILOT_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "").trim();
  return token.length > 0 ? token : null;
}

export function extractCopilotStopErrors(result: unknown): Error[] {
  if (result instanceof Error) return [result];
  if (!Array.isArray(result)) return [];
  return result.filter((value): value is Error => value instanceof Error);
}

export async function buildCopilotClientBootstrap(input: {
  command?: unknown;
  args?: unknown;
  extraArgs?: unknown;
  cwd: string;
  runtimeEnv: Record<string, string>;
}): Promise<CopilotClientBootstrap> {
  const command = asString(input.command, "").trim();
  const commandArgs = (() => {
    const extraArgs = asStringArray(input.extraArgs);
    if (extraArgs.length > 0) return extraArgs;
    return asStringArray(input.args);
  })();

  const commandNotes = ["Using the GitHub Copilot SDK JSON-RPC runtime."];

  if (!command) {
    commandNotes.push("Using the bundled Copilot CLI from @github/copilot-sdk.");
    if (commandArgs.length > 0) {
      commandNotes.push(`Passing SDK CLI bootstrap args: ${commandArgs.join(" ")}`);
    }
    return {
      clientOptions: {
        cwd: input.cwd,
        env: input.runtimeEnv,
        logLevel: "error",
      },
      command: SDK_COMMAND_LABEL,
      commandArgs,
      resolvedCommand: null,
      commandNotes,
    };
  }

  await ensureCommandResolvable(command, input.cwd, ensurePathInEnv({ ...input.runtimeEnv }));
  const resolvedCommand = await resolveCommandForLogs(
    command,
    input.cwd,
    ensurePathInEnv({ ...input.runtimeEnv }),
  );
  commandNotes.push(`Using custom Copilot CLI command ${resolvedCommand}.`);
  if (commandArgs.length > 0) {
    commandNotes.push(`Passing SDK CLI bootstrap args: ${commandArgs.join(" ")}`);
  }

  return {
    clientOptions: {
      cliPath: resolvedCommand,
      cliArgs: commandArgs,
      cwd: input.cwd,
      env: input.runtimeEnv,
      logLevel: "error",
    },
    command: resolvedCommand,
    commandArgs,
    resolvedCommand,
    commandNotes,
  };
}

export function buildLoggedInvocationEnv(
  env: Record<string, string>,
  runtimeEnv: Record<string, string>,
  resolvedCommand: string | null,
): Record<string, string> {
  return buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });
}

export function normalizeCopilotDiscoveredModels(models: ModelInfo[]): AdapterModel[] {
  return dedupeModels(
    models.map((model) => {
      const id = model.id.trim();
      const name = model.name.trim();
      const label =
        name.length > 0 && name !== id
          ? `${name}${id === DEFAULT_COPILOT_LOCAL_MODEL ? " (default)" : ""} (${id})`
          : `${id}${id === DEFAULT_COPILOT_LOCAL_MODEL ? " (default)" : ""}`;
      return {
        id,
        label,
      };
    }),
  );
}

export function resolveCopilotModelSelection(
  configuredModel: string,
  availableModels: AdapterModel[],
): { effectiveModel: string | null; errorMessage: string | null; warningMessage: string | null } {
  const explicitModel = configuredModel.trim();
  const candidate = explicitModel || DEFAULT_COPILOT_LOCAL_MODEL;
  const isAvailable = availableModels.some((model) => model.id === candidate);
  if (isAvailable) {
    return {
      effectiveModel: candidate,
      errorMessage: null,
      warningMessage: null,
    };
  }

  if (explicitModel) {
    const sample = availableModels.slice(0, 12).map((model) => model.id).join(", ");
    return {
      effectiveModel: null,
      errorMessage: sample
        ? `Configured Copilot model is unavailable: ${explicitModel}. Available models: ${sample}${availableModels.length > 12 ? ", ..." : ""}`
        : `Configured Copilot model is unavailable: ${explicitModel}.`,
      warningMessage: null,
    };
  }

  return {
    effectiveModel: null,
    errorMessage: null,
    warningMessage: `Default Copilot model "${DEFAULT_COPILOT_LOCAL_MODEL}" is unavailable; using the runtime default instead.`,
  };
}

export async function loadInstructionsSystemMessage(
  cwd: string,
  instructionsFilePath: string,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<CopilotInstructionsMessage | null> {
  const trimmed = instructionsFilePath.trim();
  if (!trimmed) return null;

  const resolvedInstructionsFilePath = path.resolve(cwd, trimmed);
  try {
    const contents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
    const instructionsDir = path.dirname(resolvedInstructionsFilePath);
    const content =
      `${contents}\n\n` +
      `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
      `Resolve any relative file references from ${instructionsDir}.`;

    return {
      systemMessage: {
        mode: "append",
        content,
      },
      resolvedInstructionsFilePath,
      notes: [`Loaded agent instructions from ${resolvedInstructionsFilePath}`],
      chars: content.length,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog(
      "stdout",
      `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
    );
    return {
      systemMessage: undefined,
      resolvedInstructionsFilePath,
      notes: [
        `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      ],
      chars: 0,
    };
  }
}

export async function materializeCopilotSkillDirectory(
  baseDir: string,
  runId: string,
  entries: PaperclipSkillEntry[],
  desiredNames: string[],
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<string | null> {
  const desiredSet = new Set(
    desiredNames.length > 0 ? desiredNames : entries.map((entry) => entry.runtimeName),
  );
  const selected = entries.filter(
    (entry) => desiredSet.has(entry.runtimeName) || desiredSet.has(entry.key),
  );
  if (selected.length === 0) return null;

  const skillsRoot = path.join(baseDir, ".paperclip-runtime", "copilot-local-skills", runId);
  await fs.mkdir(skillsRoot, { recursive: true });

  let copied = 0;
  for (const entry of selected) {
    const target = path.join(skillsRoot, entry.runtimeName);
    try {
      await fs.cp(entry.source, target, { recursive: true, force: true });
      copied += 1;
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to materialize Copilot skill "${entry.key}" into ${skillsRoot}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  if (copied === 0) {
    await removeDirSafe(skillsRoot);
    return null;
  }

  return skillsRoot;
}

export async function removeDirSafe(dir: string | null): Promise<void> {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

export function isCopilotUnknownSessionMessage(message: string): boolean {
  return /(unknown\s+session|session\b.*\bnot\s+found|no\s+such\s+session)/i.test(message);
}

export function isCopilotAuthRequiredMessage(message: string): boolean {
  return COPILOT_AUTH_REQUIRED_RE.test(message);
}

export function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}
