import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, chmod, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  CodexAppServerDriver,
  type CodexAppServerDriverOptions,
  prepareIsolatedCodexHome,
  resolveSourceCodexHome,
} from "../vendor/paperclip-runner/index.js";

type FormalQaSession = {
  startTurn: (input: { message: { role: "user"; text: string } }) => Promise<{ turnId: string }>;
  events: () => AsyncIterable<AdapterRuntimeEvent>;
  usage?: () => Promise<unknown>;
  interrupt?: (input: { turnId: string; reason: string }) => Promise<unknown>;
  close: (input: { reason: string; force: boolean }) => Promise<unknown>;
};

type FormalQaDriver = {
  openSession: (input: {
    runId: string;
    normalizedSessionId: string;
    workingDirectory: string;
    signal: AbortSignal;
  }) => Promise<FormalQaSession>;
};

const FORMAL_QA_ENVELOPE = {
  schema: "paperclip.skillless_task.v1" as const,
  objective: "Produce the sealed Formal-QA decision for the supplied review authority.",
  completionContract: {
    revision: "formal-qa-decision-v1",
    criteria: [{ id: "sealed-decision", requirement: "Return the exact Formal-QA decision JSON." }],
  },
  constraints: [
    "Use only the three sealed Formal-QA source tools; no checkout is mounted.",
    "Do not use skills, apps, Paperclip APIs, credentials, or network access.",
    "Return exactly one Formal-QA decision JSON object.",
  ],
  expectedResultSchema: "paperclip.run_result.v1" as const,
};

const MAX_READ_BYTES = 512 * 1024;
const MAX_LIST_RESULTS = 500;
const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 100;

type SealedSourceEntry = Readonly<{
  path: string;
  mode: "100644" | "100755" | "120000";
  sha256: string;
  size: number;
}>;

export type FormalQaSealedContent = Readonly<{
  list: () => Promise<readonly SealedSourceEntry[]>;
  read: (path: string) => Promise<SealedSourceEntry & { content: Buffer }>;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finalAgentMessage(event: AdapterRuntimeEvent): string | null {
  if (event.eventType !== "item.completed") return null;
  const payload = asRecord(event.payload);
  if (!payload || payload.kind !== "agentMessage" || payload.channel !== "final") return null;
  return typeof payload.text === "string" ? payload.text : null;
}

function exactRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new Error("formal_qa_content_tool_arguments_invalid");
  return record;
}

function relativePath(value: unknown, key: "path" | "prefix"): string {
  if (typeof value !== "string" || value.length > (key === "path" ? 1024 : 512)) {
    throw new Error("formal_qa_content_tool_path_invalid");
  }
  if (!value) return "";
  if (value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("formal_qa_content_tool_path_invalid");
  }
  return value;
}

function utf8Content(entry: SealedSourceEntry & { content: Buffer }): string {
  if (entry.size > MAX_READ_BYTES || entry.content.length !== entry.size) {
    throw new Error("formal_qa_content_tool_file_too_large");
  }
  if (createHash("sha256").update(entry.content).digest("hex") !== entry.sha256) {
    throw new Error("formal_qa_content_tool_digest_mismatch");
  }
  const text = entry.content.toString("utf8");
  // Node replaces malformed UTF-8 with U+FFFD.  Returning that replacement
  // would make the reviewer inspect different source text than the exact
  // Git bytes whose digest was sealed.  Admit only a lossless UTF-8 round trip.
  if (text.includes("\0") || !Buffer.from(text, "utf8").equals(entry.content)) {
    throw new Error("formal_qa_content_tool_binary_file");
  }
  return text;
}

function overlaps(left: string, right: string): boolean {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  return fromLeft === "" || fromRight === "" || !fromLeft.startsWith("..") || !fromRight.startsWith("..");
}

async function trustedScratchPath(value: string): Promise<string> {
  const stated = await lstat(value);
  if (!stated.isDirectory() || stated.isSymbolicLink()) throw new Error("formal_qa_scratch_untrusted");
  const resolved = await realpath(value);
  const actual = await lstat(resolved);
  if (!actual.isDirectory() || actual.isSymbolicLink()) throw new Error("formal_qa_scratch_untrusted");
  return resolved;
}

async function protectedRoots(environment: NodeJS.ProcessEnv): Promise<string[]> {
  const candidates = [...new Set([environment.CODEX_HOME, resolveSourceCodexHome(environment)])]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => resolve(value.trim()));
  const roots: string[] = [];
  try {
    for (const candidate of candidates) {
      const canonical = await realpath(candidate);
      const stated = await lstat(canonical);
      if (!stated.isDirectory() || stated.isSymbolicLink()) {
        throw new Error("formal_qa_credential_root_untrusted");
      }
      if (!roots.includes(canonical)) roots.push(canonical);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "formal_qa_credential_root_untrusted") throw error;
    throw new Error("formal_qa_credential_root_untrusted", { cause: error });
  }
  return roots;
}

async function assertScratchCredentialSeparation(scratchPath: string, environment: NodeJS.ProcessEnv): Promise<string[]> {
  const hostProtectedRoots = await protectedRoots(environment);
  if (hostProtectedRoots.some((root) => overlaps(scratchPath, root))) {
    throw new Error("formal_qa_scratch_credential_overlap");
  }
  return hostProtectedRoots;
}

export const formalQaCodexExecutorTestOnly = {
  async assertScratchCredentialSeparation(scratchPath: string, environment: NodeJS.ProcessEnv): Promise<void> {
    const trusted = await trustedScratchPath(scratchPath);
    await assertScratchCredentialSeparation(trusted, environment);
  },
  protectedRoots,
};

async function formalQaContentTool(
  content: FormalQaSealedContent,
  call: { tool: "formal_qa_list_files" | "formal_qa_read_file" | "formal_qa_search"; arguments: unknown },
): Promise<unknown> {
  const args = exactRecord(call.arguments);
  if (call.tool === "formal_qa_list_files") {
    if (Object.keys(args).some((key) => key !== "prefix")) throw new Error("formal_qa_content_tool_arguments_invalid");
    const prefix = args.prefix === undefined ? "" : relativePath(args.prefix, "prefix");
    const entries = (await content.list()).filter((entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`));
    return { files: entries.slice(0, MAX_LIST_RESULTS).map(({ path, mode, sha256, size }) => ({ path, mode, sha256, size })), truncated: entries.length > MAX_LIST_RESULTS };
  }
  if (call.tool === "formal_qa_read_file") {
    if (Object.keys(args).length !== 1 || !("path" in args)) throw new Error("formal_qa_content_tool_arguments_invalid");
    const entry = await content.read(relativePath(args.path, "path"));
    return { path: entry.path, mode: entry.mode, sha256: entry.sha256, size: entry.size, content: utf8Content(entry) };
  }
  if (Object.keys(args).length !== 1 || typeof args.query !== "string" || !args.query || args.query.length > 256) {
    throw new Error("formal_qa_content_tool_arguments_invalid");
  }
  let scanned = 0;
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const listed of await content.list()) {
    if (scanned >= MAX_SEARCH_BYTES || matches.length >= MAX_SEARCH_RESULTS || listed.size > MAX_READ_BYTES) continue;
    const entry = await content.read(listed.path);
    const text = utf8Content(entry);
    scanned += Buffer.byteLength(text);
    for (const [index, line] of text.split("\n").entries()) {
      if (line.includes(args.query)) matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 1024) });
      if (matches.length >= MAX_SEARCH_RESULTS) break;
    }
  }
  return { matches, truncated: scanned >= MAX_SEARCH_BYTES || matches.length >= MAX_SEARCH_RESULTS };
}

/**
 * Issue-free Formal-QA provider bridge. Unlike the native issue executor this
 * deliberately has no issue, execution-workspace, runtime, or environment
 * lease inputs, so it cannot create or mutate generic runtime state.
 */
export async function executeFormalQaCodexAppServer(input: {
  runId: string;
  reviewId: string;
  scratchPath: string;
  prompt: string;
  model: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  sealedContent: FormalQaSealedContent;
  onEvent?: (event: AdapterRuntimeEvent) => Promise<void>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  /** Test seam; production always uses the isolated app-server driver below. */
  driverFactory?: (options: CodexAppServerDriverOptions) => FormalQaDriver;
}): Promise<{ output: string; usage: Record<string, unknown> | null }> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new Error("formal_qa_codex_timeout_invalid");
  }
  const scratchPath = await trustedScratchPath(input.scratchPath);
  const sourceEnvironment = input.environment ?? process.env;
  const hostProtectedRoots = await assertScratchCredentialSeparation(scratchPath, sourceEnvironment);
  const providerHome = await mkdtemp(join(tmpdir(), "paperclip-formal-qa-codex-"));
  await chmod(providerHome, 0o700);
  const providerStats = await lstat(providerHome);
  if (!providerStats.isDirectory() || providerStats.isSymbolicLink()) {
    await rm(providerHome, { recursive: true, force: true });
    throw new Error("formal_qa_provider_home_untrusted");
  }
  if (overlaps(providerHome, scratchPath) || hostProtectedRoots.some((root) => overlaps(providerHome, root))) {
    await rm(providerHome, { recursive: true, force: true });
    throw new Error("formal_qa_provider_home_overlap");
  }
  try {
    await prepareIsolatedCodexHome({
      context: null,
      codexHome: providerHome,
      sourceCodexHome: resolveSourceCodexHome(sourceEnvironment),
      nativeMcp: null,
      apiKey: null,
    });
  } catch (error) {
    await rm(providerHome, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const providerEnvironment: NodeJS.ProcessEnv = {
    PATH: sourceEnvironment.PATH,
    LANG: sourceEnvironment.LANG,
    LC_ALL: sourceEnvironment.LC_ALL,
    HOME: providerHome,
    CODEX_HOME: providerHome,
    PAPERCLIP_WORKSPACE_CWD: scratchPath,
  };
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout: ((reason: Error) => void) | null = null;
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    const error = new Error("formal_qa_codex_timeout");
    controller.abort(error);
    rejectTimeout?.(error);
  }, input.timeoutMs);
  timer.unref?.();
  const abortFromCaller = () => {
    const reason = input.signal?.reason instanceof Error
      ? input.signal.reason
      : new Error("formal_qa_codex_cancelled");
    controller.abort(reason);
    rejectTimeout?.(reason);
  };
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const options: CodexAppServerDriverOptions = {
    taskEnvelope: FORMAL_QA_ENVELOPE,
    conversationMode: "direct",
    formalQa: {
      protectedHostRoots: hostProtectedRoots,
      contentToolHandler: (call) => formalQaContentTool(input.sealedContent, call),
    },
    approvalPolicy: "never",
    includeSkillInstructions: false,
    includeCollaborationModeInstructions: false,
    capabilities: {
      steering: false,
      interruption: true,
      dynamicTools: true,
      runtimeRequestResolution: false,
      goals: false,
    },
    ...(input.model ? { model: input.model } : {}),
    environment: providerEnvironment,
    onDiagnostic: (message) => {
      void input.onLog?.("stderr", `[formal-qa-codex] ${message}\n`);
    },
    ...(input.onSpawn ? { onSpawn: input.onSpawn } : {}),
  };
  const driver = input.driverFactory?.(options) ?? new CodexAppServerDriver(options);
  const executionState: { session: FormalQaSession | null; activeTurnId: string | null } = {
    session: null,
    activeTurnId: null,
  };
  try {
    const complete = (async () => {
      executionState.session = await driver.openSession({
        runId: input.runId,
        normalizedSessionId: input.reviewId,
        workingDirectory: scratchPath,
        signal: controller.signal,
      });
      const { turnId } = await executionState.session.startTurn({
        message: { role: "user", text: input.prompt },
      });
      executionState.activeTurnId = turnId;
      let output: string | null = null;
      for await (const event of executionState.session.events()) {
        await input.onEvent?.(event as AdapterRuntimeEvent);
        const candidate = finalAgentMessage(event as AdapterRuntimeEvent);
        if (candidate !== null) {
          if (output !== null && output !== candidate) {
            throw new Error("formal_qa_codex_multiple_final_outputs");
          }
          output = candidate;
        }
        if ((event as { turnId?: string }).turnId !== turnId) continue;
        if (event.eventType === "turn.completed") break;
        if (["turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType)) {
          throw new Error(`formal_qa_codex_turn_${event.eventType.replace("turn.", "")}`);
        }
      }
      if (output === null) throw new Error("formal_qa_codex_decision_output_missing");
      const usage = await executionState.session.usage?.() ?? null;
      return { output, usage: usage && typeof usage === "object" ? usage as Record<string, unknown> : null };
    })();
    return await Promise.race([complete, timeout]);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromCaller);
    if (controller.signal.aborted && executionState.activeTurnId && executionState.session?.interrupt) {
      await executionState.session.interrupt({
        turnId: executionState.activeTurnId,
        reason: timedOut ? "formal_qa_codex_timeout" : "formal_qa_codex_cancelled",
      }).catch(() => undefined);
    }
    await executionState.session?.close({ reason: "formal_qa_terminal", force: true }).catch(() => undefined);
    await rm(providerHome, { recursive: true, force: true }).catch(() => undefined);
  }
}
