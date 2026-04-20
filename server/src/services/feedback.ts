import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, getTableColumns, gte, lte, ne, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  companySkills,
  costEvents,
  documentRevisions,
  documents,
  feedbackExports,
  feedbackVotes,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { claudeConfigDir, parseClaudeStreamJson } from "@paperclipai/adapter-claude-local/server";
import { codexHomeDir, parseCodexJsonl } from "@paperclipai/adapter-codex-local/server";
import { parseOpenCodeJsonl } from "@paperclipai/adapter-opencode-local/server";
import {
  DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
  instanceGeneralSettingsSchema,
  type FeedbackTargetType,
  type FeedbackTraceBundle,
  type FeedbackTraceBundleCaptureStatus,
  type FeedbackTraceBundleFile,
  type FeedbackTrace,
  type FeedbackTraceStatus,
  type FeedbackTraceTargetSummary,
  type FeedbackVoteValue,
} from "@paperclipai/shared";
import { resolveHomeAwarePath, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { notFound, unprocessable } from "../errors.js";
import { agentInstructionsService } from "./agent-instructions.js";
import {
  createFeedbackRedactionState,
  finalizeFeedbackRedactionSummary,
  sanitizeFeedbackText,
  sanitizeFeedbackValue,
  sha256Digest,
} from "./feedback-redaction.js";
import { getRunLogStore } from "./run-log-store.js";

const FEEDBACK_SCHEMA_VERSION = "paperclip-feedback-envelope-v2";
const FEEDBACK_BUNDLE_VERSION = "paperclip-feedback-bundle-v2";
const FEEDBACK_PAYLOAD_VERSION = "paperclip-feedback-v1";
const FEEDBACK_DESTINATION = "paperclip_labs_feedback_v1";
const FEEDBACK_CONTEXT_WINDOW = 3;
const MAX_EXCERPT_CHARS = 200;
const MAX_PRIMARY_CONTENT_CHARS = 8_000;
const MAX_CONTEXT_ITEM_BODY_CHARS = 3_000;
const MAX_TOTAL_CONTEXT_CHARS = 12_000;
const MAX_DESCRIPTION_CHARS = 1_200;
const MAX_INSTRUCTIONS_BODY_CHARS = 8_000;
const MAX_PATH_CHARS = 600;
const MAX_SKILLS = 20;
const MAX_INSTRUCTION_FILES = 20;
const MAX_TRACE_FILE_CHARS = 10_000_000;
const DEFAULT_INSTANCE_SETTINGS_SINGLETON_KEY = "default";
const FEEDBACK_EXPORT_BACKEND_NOT_CONFIGURED = "Feedback export backend is not configured";

type FeedbackTraceRow = typeof feedbackExports.$inferSelect & {
  issueIdentifier: string | null;
  issueTitle: string;
};

type PendingFeedbackExportRow = typeof feedbackExports.$inferSelect;

type IssueFeedbackContext = {
  id: string;
  companyId: string;
  projectId: string | null;
  identifier: string | null;
  title: string;
  description: string | null;
};

type FeedbackTargetRecord = {
  targetType: FeedbackTargetType;
  targetId: string;
  label: string;
  body: string;
  createdAt: Date;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdByRunId: string | null;
  documentId: string | null;
  documentKey: string | null;
  documentTitle: string | null;
  revisionNumber: number | null;
  issuePath: string | null;
  targetPath: string | null;
};

type ResolvedFeedbackTarget = FeedbackTargetRecord & {
  payloadTarget: Record<string, unknown>;
};

const feedbackExportColumns = getTableColumns(feedbackExports);
const instructionsSvc = agentInstructionsService();

type FeedbackTraceShareClient = {
  uploadTraceBundle(bundle: FeedbackTraceBundle): Promise<{ objectKey: string }>;
};

type FeedbackServiceOptions = {
  shareClient?: FeedbackTraceShareClient;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function uniqueNonEmpty(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

function truncateExcerpt(text: string, max = MAX_EXCERPT_CHARS) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
}

function contentTypeForPath(filePath: string) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "application/x-ndjson";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function normalizeInstanceGeneralSettings(raw: unknown) {
  const parsed = instanceGeneralSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  return {
    censorUsernameInLogs: false,
    feedbackDataSharingPreference: DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  };
}

function buildIssuePath(identifier: string | null) {
  if (!identifier) return null;
  const prefix = identifier.split("-")[0]?.trim();
  if (!prefix) return null;
  return `/${prefix}/issues/${identifier}`;
}

function buildTargetSummary(input: {
  label: string;
  excerpt: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: Date | null;
  documentKey?: string | null;
  documentTitle?: string | null;
  revisionNumber?: number | null;
}): FeedbackTraceTargetSummary {
  return {
    label: input.label,
    excerpt: input.excerpt,
    authorAgentId: input.authorAgentId,
    authorUserId: input.authorUserId,
    createdAt: input.createdAt,
    documentKey: input.documentKey ?? null,
    documentTitle: input.documentTitle ?? null,
    revisionNumber: input.revisionNumber ?? null,
  };
}

function normalizeReason(vote: FeedbackVoteValue, reason: string | null | undefined) {
  if (vote !== "down" || typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSkillReference(value: string) {
  return value.trim().toLowerCase();
}

function matchesSkillReference(
  skill: typeof companySkills.$inferSelect,
  reference: string,
) {
  const normalized = normalizeSkillReference(reference);
  if (!normalized) return false;
  if (skill.key.toLowerCase() === normalized) return true;
  if (skill.slug.toLowerCase() === normalized) return true;
  if (skill.name.toLowerCase() === normalized) return true;
  const keyTail = skill.key.split("/").pop()?.toLowerCase();
  return keyTail === normalized;
}

function buildExportId(feedbackVoteId: string, sharedAt: Date) {
  return `fbexp_${sha256Digest(`${feedbackVoteId}:${sharedAt.toISOString()}`).slice(0, 24)}`;
}

function resolveSourceRunId(payloadSnapshot: Record<string, unknown> | null) {
  const targetRunId = asString(asRecord(payloadSnapshot?.target)?.createdByRunId);
  if (targetRunId) return targetRunId;

  const bundle = asRecord(payloadSnapshot?.bundle);
  const agentContext = asRecord(bundle?.agentContext);
  const runtime = asRecord(agentContext?.runtime);
  return asString(asRecord(runtime?.sourceRun)?.id);
}

function makeBundleFile(input: {
  path: string;
  contentType: string;
  source: FeedbackTraceBundleFile["source"];
  contents: string;
}) {
  return {
    path: input.path,
    contentType: input.contentType,
    encoding: "utf8" as const,
    byteLength: Buffer.byteLength(input.contents, "utf8"),
    sha256: sha256Digest(input.contents),
    source: input.source,
    contents: input.contents,
  } satisfies FeedbackTraceBundleFile;
}

function appendNote(notes: string[], note: string) {
  if (note.trim().length === 0 || notes.includes(note)) return;
  notes.push(note);
}

async function readTextFileIfPresent(
  filePath: string | null,
  state: ReturnType<typeof createFeedbackRedactionState>,
  fieldPath: string,
) {
  if (!filePath) return null;
  const raw = await readFile(filePath, "utf8").catch(() => null);
  if (raw == null) return null;
  return sanitizeFeedbackText(raw, state, fieldPath, MAX_TRACE_FILE_CHARS);
}

async function listChildFiles(dirPath: string) {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function listNestedFiles(dirPath: string, maxDepth = 4): Promise<string[]> {
  async function walk(currentPath: string, depth: number): Promise<string[]> {
    const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(currentPath, entry.name))
      .sort((left, right) => left.localeCompare(right));
    if (depth >= maxDepth) return files;

    const childDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(currentPath, entry.name))
      .sort((left, right) => left.localeCompare(right));
    const nested = await Promise.all(childDirs.map((childDir) => walk(childDir, depth + 1)));
    return [...files, ...nested.flat()];
  }

  return walk(dirPath, 0);
}

async function findMatchingFile(
  rootDir: string,
  matcher: (absolutePath: string, name: string) => boolean,
  maxDepth = 5,
): Promise<string | null> {
  async function search(dirPath: string, depth: number): Promise<string | null> {
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isFile() && matcher(absolutePath, entry.name)) {
        return absolutePath;
      }
    }
    if (depth >= maxDepth) return null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = await search(path.join(dirPath, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  }

  return search(rootDir, 0);
}

async function readFullRunLog(run: {
  logStore: string | null;
  logRef: string | null;
}) {
  if (run.logStore !== "local_file" || !run.logRef) return null;
  const store = getRunLogStore();
  let offset = 0;
  let combined = "";

  while (true) {
    const result = await store.read({ store: "local_file", logRef: run.logRef }, {
      offset,
      limitBytes: 512_000,
    }).catch(() => null);
    if (!result) return combined || null;
    combined += result.content;
    if (result.nextOffset == null) break;
    offset = result.nextOffset;
  }

  return combined || null;
}

function parseRunLogEntries(logText: string | null) {
  if (!logText) return [];
  const entries: Array<{ ts: string; stream: string; chunk: string }> = [];
  for (const rawLine of logText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { ts?: unknown; stream?: unknown; chunk?: unknown };
      const ts = asString(parsed.ts) ?? new Date(0).toISOString();
      const stream = asString(parsed.stream) ?? "stdout";
      const chunk = typeof parsed.chunk === "string" ? parsed.chunk : "";
      entries.push({ ts, stream, chunk });
    } catch {
      // Keep malformed lines out of the normalized bundle but preserve the raw log file separately.
    }
  }
  return entries;
}

function captureStatusFromFiles(files: FeedbackTraceBundleFile[]): FeedbackTraceBundleCaptureStatus {
  const sources = new Set(files.map((file) => file.source));
  if (sources.has("codex_session")) return "full";
  if (sources.has("claude_project_session") || sources.has("claude_debug_log")) return "full";
  if (
    sources.has("opencode_session") &&
    sources.has("opencode_message") &&
    sources.has("opencode_message_part")
  ) {
    return "full";
  }

  const hasAdapterFiles = files.some((file) =>
    file.source !== "paperclip_run" &&
    file.source !== "paperclip_run_events" &&
    file.source !== "paperclip_run_log",
  );
  if (hasAdapterFiles) return "partial";
  return files.length > 0 ? "partial" : "unavailable";
}

async function buildCodexTraceFiles(input: {
  companyId: string;
  sessionId: string | null;
  state: ReturnType<typeof createFeedbackRedactionState>;
  notes: string[];
}) {
  const files: FeedbackTraceBundleFile[] = [];
  if (!input.sessionId) {
    appendNote(input.notes, "codex_session_id_missing");
    return { files, raw: null as Record<string, unknown> | null, normalized: null as Record<string, unknown> | null };
  }

  const managedRoot = path.join(
    resolvePaperclipInstanceRoot(),
    "companies",
    input.companyId,
    "codex-home",
    "sessions",
  );
  const sharedRoot = path.join(codexHomeDir(), "sessions");
  const sessionFile =
    await findMatchingFile(managedRoot, (_absolutePath, name) => name.includes(input.sessionId!), 6) ??
    await findMatchingFile(sharedRoot, (_absolutePath, name) => name.includes(input.sessionId!), 6);

  const sessionText = await readTextFileIfPresent(sessionFile, input.state, "bundle.rawAdapterTrace.codex.session");
  if (!sessionText) {
    appendNote(input.notes, "codex_session_file_missing");
    return { files, raw: null as Record<string, unknown> | null, normalized: null as Record<string, unknown> | null };
  }

  files.push(makeBundleFile({
    path: "adapter/codex/session.jsonl",
    contentType: "application/x-ndjson",
    source: "codex_session",
    contents: sessionText,
  }));

  return {
    files,
    raw: {
      adapterType: "codex_local",
      sessionId: input.sessionId,
      sessionFile: sessionFile ? path.basename(sessionFile) : null,
    },
    normalized: sanitizeFeedbackValue(
      {
        adapterType: "codex_local",
        sessionId: input.sessionId,
        summary: parseCodexJsonl(sessionText),
      },
      input.state,
      "bundle.normalizedAdapterTrace.codex",
      MAX_TRACE_FILE_CHARS,
    ) as Record<string, unknown>,
  };
}

async function buildClaudeTraceFiles(input: {
  sessionId: string | null;
  stdoutText: string;
  state: ReturnType<typeof createFeedbackRedactionState>;
  notes: string[];
}) {
  const files: FeedbackTraceBundleFile[] = [];
  const sanitizedStdout = sanitizeFeedbackText(
    input.stdoutText,
    input.state,
    "bundle.rawAdapterTrace.claude.stdout",
    MAX_TRACE_FILE_CHARS,
  );
  if (sanitizedStdout.trim().length > 0) {
    files.push(makeBundleFile({
      path: "adapter/claude/stream-json.ndjson",
      contentType: "application/x-ndjson",
      source: "claude_stream_json",
      contents: sanitizedStdout,
    }));
  }

  const projectsRoot = path.join(claudeConfigDir(), "projects");
  const projectSessionFile = input.sessionId
    ? await findMatchingFile(projectsRoot, (_absolutePath, name) => name === `${input.sessionId}.jsonl`, 6)
    : null;
  const projectSessionText = await readTextFileIfPresent(
    projectSessionFile,
    input.state,
    "bundle.rawAdapterTrace.claude.projectSession",
  );
  if (projectSessionText) {
    files.push(makeBundleFile({
      path: "adapter/claude/session.jsonl",
      contentType: "application/x-ndjson",
      source: "claude_project_session",
      contents: projectSessionText,
    }));
  } else if (input.sessionId) {
    appendNote(input.notes, "claude_project_session_missing");
  }

  const projectSessionArtifactsDir = projectSessionFile
    ? path.join(path.dirname(projectSessionFile), input.sessionId ?? "")
    : null;
  const projectSessionArtifactFiles = projectSessionArtifactsDir
    ? await listNestedFiles(projectSessionArtifactsDir, 4)
    : [];
  for (const filePath of projectSessionArtifactFiles) {
    const relativePath = path.relative(projectSessionArtifactsDir!, filePath).split(path.sep).join("/");
    const fileText = await readTextFileIfPresent(
      filePath,
      input.state,
      `bundle.rawAdapterTrace.claude.projectArtifacts.${relativePath}`,
    );
    if (!fileText) continue;
    files.push(makeBundleFile({
      path: `adapter/claude/session/${relativePath}`,
      contentType: contentTypeForPath(filePath),
      source: "claude_project_artifact",
      contents: fileText,
    }));
  }

  const debugLogText = await readTextFileIfPresent(
    input.sessionId ? path.join(claudeConfigDir(), "debug", `${input.sessionId}.txt`) : null,
    input.state,
    "bundle.rawAdapterTrace.claude.debugLog",
  );
  if (debugLogText) {
    files.push(makeBundleFile({
      path: "adapter/claude/debug.txt",
      contentType: "text/plain; charset=utf-8",
      source: "claude_debug_log",
      contents: debugLogText,
    }));
  }

  const taskDir = input.sessionId ? path.join(claudeConfigDir(), "tasks", input.sessionId) : null;
  const taskFiles = taskDir ? await listChildFiles(taskDir) : [];
  const metadataPieces: string[] = [];
  for (const filePath of taskFiles) {
    const fileText = await readTextFileIfPresent(
      filePath,
      input.state,
      `bundle.rawAdapterTrace.claude.taskMetadata.${path.basename(filePath)}`,
    );
    if (!fileText) continue;
    metadataPieces.push(`# ${path.basename(filePath)}\n${fileText}`);
  }
  if (metadataPieces.length > 0) {
    files.push(makeBundleFile({
      path: "adapter/claude/task-metadata.txt",
      contentType: "text/plain; charset=utf-8",
      source: "claude_task_metadata",
      contents: `${metadataPieces.join("\n\n")}\n`,
    }));
  } else if (input.sessionId) {
    appendNote(input.notes, "claude_task_metadata_missing");
  }

  if (files.length === 0) {
    appendNote(input.notes, "claude_stream_trace_missing");
  }

  return {
    files,
    raw: {
      adapterType: "claude_local",
      sessionId: input.sessionId,
      projectSessionFound: Boolean(projectSessionText),
      projectArtifactsCount: projectSessionArtifactFiles.length,
      debugLogFound: Boolean(debugLogText),
      taskDirPresent: taskFiles.length > 0,
    },
    normalized: sanitizeFeedbackValue(
      {
        adapterType: "claude_local",
        sessionId: input.sessionId,
        summary: parseClaudeStreamJson(input.stdoutText),
      },
      input.state,
      "bundle.normalizedAdapterTrace.claude",
      MAX_TRACE_FILE_CHARS,
    ) as Record<string, unknown>,
  };
}

async function buildOpenCodeTraceFiles(input: {
  sessionId: string | null;
  stdoutText: string;
  state: ReturnType<typeof createFeedbackRedactionState>;
  notes: string[];
}) {
  const files: FeedbackTraceBundleFile[] = [];
  if (!input.sessionId) {
    appendNote(input.notes, "opencode_session_id_missing");
    return {
      files,
      raw: null as Record<string, unknown> | null,
      normalized: sanitizeFeedbackValue(
        {
          adapterType: "opencode_local",
          summary: parseOpenCodeJsonl(input.stdoutText),
        },
        input.state,
        "bundle.normalizedAdapterTrace.opencode",
        MAX_TRACE_FILE_CHARS,
      ) as Record<string, unknown>,
    };
  }

  const opencodeRoot = resolveHomeAwarePath(
    process.env.PAPERCLIP_OPENCODE_STORAGE_DIR ?? "~/.local/share/opencode",
  );
  const sessionRoot = path.join(opencodeRoot, "storage", "session");
  const diffRoot = path.join(opencodeRoot, "storage", "session_diff");
  const messageRoot = path.join(opencodeRoot, "storage", "message");
  const partRoot = path.join(opencodeRoot, "storage", "part");
  const todoRoot = path.join(opencodeRoot, "storage", "todo");
  const projectRoot = path.join(opencodeRoot, "storage", "project");
  const sessionFile = await findMatchingFile(
    sessionRoot,
    (_absolutePath, name) => name === `${input.sessionId}.json`,
    6,
  );
  const diffFile = path.join(diffRoot, `${input.sessionId}.json`);

  const sessionRaw = sessionFile ? await readFile(sessionFile, "utf8").catch(() => null) : null;
  const sessionText =
    sessionRaw == null
      ? null
      : sanitizeFeedbackText(sessionRaw, input.state, "bundle.rawAdapterTrace.opencode.session", MAX_TRACE_FILE_CHARS);
  if (sessionText) {
    files.push(makeBundleFile({
      path: "adapter/opencode/session.json",
      contentType: "application/json",
      source: "opencode_session",
      contents: sessionText,
    }));
  } else {
    appendNote(input.notes, "opencode_session_file_missing");
  }

  const diffText = await readTextFileIfPresent(
    diffFile,
    input.state,
    "bundle.rawAdapterTrace.opencode.sessionDiff",
  );
  if (diffText) {
    files.push(makeBundleFile({
      path: "adapter/opencode/session-diff.json",
      contentType: "application/json",
      source: "opencode_session_diff",
      contents: diffText,
    }));
  }

  const messageFiles = await listChildFiles(path.join(messageRoot, input.sessionId));
  const messageIds: string[] = [];
  for (const filePath of messageFiles) {
    const messageText = await readTextFileIfPresent(
      filePath,
      input.state,
      `bundle.rawAdapterTrace.opencode.messages.${path.basename(filePath)}`,
    );
    if (!messageText) continue;
    messageIds.push(path.basename(filePath, path.extname(filePath)));
    files.push(makeBundleFile({
      path: `adapter/opencode/messages/${path.basename(filePath)}`,
      contentType: "application/json",
      source: "opencode_message",
      contents: messageText,
    }));
  }
  if (messageFiles.length === 0) {
    appendNote(input.notes, "opencode_message_files_missing");
  }

  let partFilesCount = 0;
  for (const messageId of messageIds) {
    const partFiles = await listChildFiles(path.join(partRoot, messageId));
    for (const filePath of partFiles) {
      const partText = await readTextFileIfPresent(
        filePath,
        input.state,
        `bundle.rawAdapterTrace.opencode.parts.${messageId}.${path.basename(filePath)}`,
      );
      if (!partText) continue;
      partFilesCount += 1;
      files.push(makeBundleFile({
        path: `adapter/opencode/parts/${messageId}/${path.basename(filePath)}`,
        contentType: "application/json",
        source: "opencode_message_part",
        contents: partText,
      }));
    }
  }
  if (messageIds.length > 0 && partFilesCount === 0) {
    appendNote(input.notes, "opencode_message_parts_missing");
  }

  const parsedSession = (() => {
    if (!sessionRaw) return null;
    try {
      return JSON.parse(sessionRaw) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  const projectId = asString(parsedSession?.projectID) ?? asString(parsedSession?.projectId);
  const projectText = await readTextFileIfPresent(
    projectId ? path.join(projectRoot, `${projectId}.json`) : null,
    input.state,
    "bundle.rawAdapterTrace.opencode.project",
  );
  if (projectText) {
    files.push(makeBundleFile({
      path: "adapter/opencode/project.json",
      contentType: "application/json",
      source: "opencode_project",
      contents: projectText,
    }));
  }

  const todoText = await readTextFileIfPresent(
    path.join(todoRoot, `${input.sessionId}.json`),
    input.state,
    "bundle.rawAdapterTrace.opencode.todo",
  );
  if (todoText) {
    files.push(makeBundleFile({
      path: "adapter/opencode/todo.json",
      contentType: "application/json",
      source: "opencode_todo",
      contents: todoText,
    }));
  }

  return {
    files,
    raw: {
      adapterType: "opencode_local",
      sessionId: input.sessionId,
      sessionFileFound: Boolean(sessionText),
      sessionDiffFound: Boolean(diffText),
      messageFilesCount: messageFiles.length,
      partFilesCount,
      projectFound: Boolean(projectText),
      todoFound: Boolean(todoText),
    },
    normalized: sanitizeFeedbackValue(
      {
        adapterType: "opencode_local",
        sessionId: input.sessionId,
        summary: parseOpenCodeJsonl(input.stdoutText),
      },
      input.state,
      "bundle.normalizedAdapterTrace.opencode",
      MAX_TRACE_FILE_CHARS,
    ) as Record<string, unknown>,
  };
}

function truncateFailureReason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 1_000) || "Feedback export failed";
}

function mapTraceRow(row: FeedbackTraceRow, includePayload: boolean): FeedbackTrace {
  const targetSummary = asRecord(row.targetSummary) as unknown as FeedbackTraceTargetSummary | null;
  return {
    id: row.id,
    companyId: row.companyId,
    feedbackVoteId: row.feedbackVoteId,
    issueId: row.issueId,
    projectId: row.projectId ?? null,
    issueIdentifier: row.issueIdentifier,
    issueTitle: row.issueTitle,
    authorUserId: row.authorUserId,
    targetType: row.targetType as FeedbackTargetType,
    targetId: row.targetId,
    vote: row.vote as FeedbackVoteValue,
    status: row.status as FeedbackTraceStatus,
    destination: row.destination ?? null,
    exportId: row.exportId ?? null,
    consentVersion: row.consentVersion ?? null,
    schemaVersion: row.schemaVersion,
    bundleVersion: row.bundleVersion,
    payloadVersion: row.payloadVersion,
    payloadDigest: row.payloadDigest ?? null,
    payloadSnapshot: includePayload ? asRecord(row.payloadSnapshot) : null,
    targetSummary: targetSummary ?? buildTargetSummary({
      label: row.targetType,
      excerpt: null,
      authorAgentId: null,
      authorUserId: null,
      createdAt: null,
    }),
    redactionSummary: asRecord(row.redactionSummary),
    attemptCount: row.attemptCount,
    lastAttemptedAt: row.lastAttemptedAt ?? null,
    exportedAt: row.exportedAt ?? null,
    failureReason: row.failureReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function resolveFeedbackTarget(
  db: Pick<Db, "select">,
  issue: IssueFeedbackContext,
  targetType: FeedbackTargetType,
  targetId: string,
): Promise<ResolvedFeedbackTarget> {
  const issuePath = buildIssuePath(issue.identifier);

  if (targetType === "issue_comment") {
    const targetComment = await db
      .select({
        id: issueComments.id,
        issueId: issueComments.issueId,
        companyId: issueComments.companyId,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        createdByRunId: issueComments.createdByRunId,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.id, targetId))
      .then((rows) => rows[0] ?? null);

    if (!targetComment || targetComment.issueId !== issue.id || targetComment.companyId !== issue.companyId) {
      throw notFound("Feedback target not found");
    }
    if (!targetComment.authorAgentId) {
      throw unprocessable("Feedback voting is only available on agent-authored issue comments");
    }

    const record: ResolvedFeedbackTarget = {
      targetType,
      targetId,
      label: "Comment",
      body: targetComment.body,
      createdAt: targetComment.createdAt,
      authorAgentId: targetComment.authorAgentId,
      authorUserId: targetComment.authorUserId,
      createdByRunId: targetComment.createdByRunId ?? null,
      documentId: null,
      documentKey: null,
      documentTitle: null,
      revisionNumber: null,
      issuePath,
      targetPath: issuePath ? `${issuePath}#comment-${targetComment.id}` : null,
      payloadTarget: {
        type: targetType,
        id: targetComment.id,
        createdAt: targetComment.createdAt.toISOString(),
        authorAgentId: targetComment.authorAgentId,
        authorUserId: targetComment.authorUserId,
        createdByRunId: targetComment.createdByRunId ?? null,
        issuePath,
        targetPath: issuePath ? `${issuePath}#comment-${targetComment.id}` : null,
      },
    };
    return record;
  }

  if (targetType === "issue_document_revision") {
    const targetRevision = await db
      .select({
        id: documentRevisions.id,
        companyId: documentRevisions.companyId,
        documentId: documentRevisions.documentId,
        revisionNumber: documentRevisions.revisionNumber,
        body: documentRevisions.body,
        createdByAgentId: documentRevisions.createdByAgentId,
        createdByUserId: documentRevisions.createdByUserId,
        createdByRunId: documentRevisions.createdByRunId,
        createdAt: documentRevisions.createdAt,
        issueId: issueDocuments.issueId,
        key: issueDocuments.key,
        title: documents.title,
      })
      .from(documentRevisions)
      .innerJoin(documents, eq(documentRevisions.documentId, documents.id))
      .innerJoin(issueDocuments, eq(issueDocuments.documentId, documents.id))
      .where(eq(documentRevisions.id, targetId))
      .then((rows) => rows.find((row) => row.issueId === issue.id) ?? null);

    if (!targetRevision || targetRevision.companyId !== issue.companyId) {
      throw notFound("Feedback target not found");
    }
    if (!targetRevision.createdByAgentId) {
      throw unprocessable("Feedback voting is only available on agent-authored document revisions");
    }

    const record: ResolvedFeedbackTarget = {
      targetType,
      targetId,
      label: `${targetRevision.key} rev ${targetRevision.revisionNumber}`,
      body: targetRevision.body,
      createdAt: targetRevision.createdAt,
      authorAgentId: targetRevision.createdByAgentId,
      authorUserId: targetRevision.createdByUserId,
      createdByRunId: targetRevision.createdByRunId ?? null,
      documentId: targetRevision.documentId,
      documentKey: targetRevision.key,
      documentTitle: targetRevision.title ?? null,
      revisionNumber: targetRevision.revisionNumber,
      issuePath,
      targetPath: issuePath ? `${issuePath}#document-${encodeURIComponent(targetRevision.key)}` : null,
      payloadTarget: {
        type: targetType,
        id: targetRevision.id,
        documentId: targetRevision.documentId,
        documentKey: targetRevision.key,
        documentTitle: targetRevision.title ?? null,
        revisionNumber: targetRevision.revisionNumber,
        createdAt: targetRevision.createdAt.toISOString(),
        authorAgentId: targetRevision.createdByAgentId,
        authorUserId: targetRevision.createdByUserId,
        createdByRunId: targetRevision.createdByRunId ?? null,
        issuePath,
        targetPath: issuePath ? `${issuePath}#document-${encodeURIComponent(targetRevision.key)}` : null,
      },
    };
    return record;
  }

  throw unprocessable("Unsupported feedback target type");
}

async function listIssueContextItems(
  db: Pick<Db, "select">,
  issue: IssueFeedbackContext,
) {
  const [commentRows, revisionRows] = await Promise.all([
    db
      .select({
        targetId: issueComments.id,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        createdByRunId: issueComments.createdByRunId,
      })
      .from(issueComments)
      .where(and(eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id))),
    db
      .select({
        targetId: documentRevisions.id,
        body: documentRevisions.body,
        createdAt: documentRevisions.createdAt,
        authorAgentId: documentRevisions.createdByAgentId,
        authorUserId: documentRevisions.createdByUserId,
        createdByRunId: documentRevisions.createdByRunId,
        documentId: documentRevisions.documentId,
        documentKey: issueDocuments.key,
        documentTitle: documents.title,
        revisionNumber: documentRevisions.revisionNumber,
      })
      .from(documentRevisions)
      .innerJoin(documents, eq(documentRevisions.documentId, documents.id))
      .innerJoin(issueDocuments, eq(issueDocuments.documentId, documents.id))
      .where(and(eq(documentRevisions.companyId, issue.companyId), eq(issueDocuments.issueId, issue.id))),
  ]);

  const issuePath = buildIssuePath(issue.identifier);

  const items: FeedbackTargetRecord[] = [
    ...commentRows.map((row) => ({
      targetType: "issue_comment" as const,
      targetId: row.targetId,
      label: "Comment",
      body: row.body,
      createdAt: row.createdAt,
      authorAgentId: row.authorAgentId,
      authorUserId: row.authorUserId,
      createdByRunId: row.createdByRunId ?? null,
      documentId: null,
      documentKey: null,
      documentTitle: null,
      revisionNumber: null,
      issuePath,
      targetPath: issuePath ? `${issuePath}#comment-${row.targetId}` : null,
    })),
    ...revisionRows.map((row) => ({
      targetType: "issue_document_revision" as const,
      targetId: row.targetId,
      label: `${row.documentKey} rev ${row.revisionNumber}`,
      body: row.body,
      createdAt: row.createdAt,
      authorAgentId: row.authorAgentId,
      authorUserId: row.authorUserId,
      createdByRunId: row.createdByRunId ?? null,
      documentId: row.documentId,
      documentKey: row.documentKey,
      documentTitle: row.documentTitle ?? null,
      revisionNumber: row.revisionNumber,
      issuePath,
      targetPath: issuePath ? `${issuePath}#document-${encodeURIComponent(row.documentKey)}` : null,
    })),
  ];

  return items.sort((left, right) => {
    const byDate = left.createdAt.getTime() - right.createdAt.getTime();
    if (byDate !== 0) return byDate;
    return left.targetId.localeCompare(right.targetId);
  });
}

async function buildIssueContext(
  db: Pick<Db, "select">,
  issue: IssueFeedbackContext,
  target: ResolvedFeedbackTarget,
  state: ReturnType<typeof createFeedbackRedactionState>,
) {
  const items = await listIssueContextItems(db, issue);
  const targetIndex = items.findIndex((item) => item.targetType === target.targetType && item.targetId === target.targetId);
  const before = targetIndex >= 0
    ? items.slice(Math.max(0, targetIndex - FEEDBACK_CONTEXT_WINDOW), targetIndex)
    : [];
  const after = targetIndex >= 0
    ? items.slice(targetIndex + 1, targetIndex + 1 + FEEDBACK_CONTEXT_WINDOW)
    : [];

  let remainingChars = MAX_TOTAL_CONTEXT_CHARS;
  const serializedItems = [...before, ...after].map((item, index) => {
    const relation = index < before.length ? "before" : "after";
    if (remainingChars <= 0) {
      state.omittedFields.add("bundle.issueContext.items");
      return null;
    }
    const maxChars = Math.min(MAX_CONTEXT_ITEM_BODY_CHARS, remainingChars);
    const body = sanitizeFeedbackText(
      item.body,
      state,
      `bundle.issueContext.items.${index}.body`,
      maxChars,
    );
    remainingChars -= body.length;
    return {
      type: item.targetType,
      id: item.targetId,
      label: item.label,
      relation,
      createdAt: item.createdAt.toISOString(),
      authorAgentId: item.authorAgentId,
      authorUserId: item.authorUserId,
      createdByRunId: item.createdByRunId,
      documentKey: item.documentKey,
      documentTitle: item.documentTitle,
      revisionNumber: item.revisionNumber,
      targetPath: item.targetPath,
      body,
      excerpt: truncateExcerpt(body),
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null);

  const descriptionExcerpt = issue.description
    ? sanitizeFeedbackText(issue.description, state, "bundle.issueContext.issue.description", MAX_DESCRIPTION_CHARS)
    : null;

  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      projectId: issue.projectId,
      path: buildIssuePath(issue.identifier),
      descriptionExcerpt: descriptionExcerpt ? truncateExcerpt(descriptionExcerpt, MAX_DESCRIPTION_CHARS) : null,
    },
    items: serializedItems,
  };
}

async function buildAgentContext(
  db: Pick<Db, "select">,
  companyId: string,
  authorAgentId: string | null,
  createdByRunId: string | null,
  state: ReturnType<typeof createFeedbackRedactionState>,
) {
  if (!authorAgentId) {
    state.notes.add("author_agent_missing");
    return null;
  }

  const agent = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      title: agents.title,
      status: agents.status,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(agents)
    .where(eq(agents.id, authorAgentId))
    .then((rows) => rows[0] ?? null);

  if (!agent || agent.companyId !== companyId) {
    state.notes.add("author_agent_unavailable");
    return null;
  }

  const adapterConfig = asRecord(agent.adapterConfig) ?? {};
  const runtimeConfig = asRecord(agent.runtimeConfig) ?? {};
  const desiredSkillRefs = uniqueNonEmpty(readPaperclipSkillSyncPreference(adapterConfig).desiredSkills).slice(0, MAX_SKILLS);
  const availableSkills = desiredSkillRefs.length === 0
    ? []
    : await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));
  const matchedSkills = availableSkills
    .filter((skill) => desiredSkillRefs.some((reference) => matchesSkillReference(skill, reference)))
    .slice(0, MAX_SKILLS);
  const unresolvedSkillRefs = desiredSkillRefs.filter(
    (reference) => !matchedSkills.some((skill) => matchesSkillReference(skill, reference)),
  );

  if (availableSkills.length > MAX_SKILLS || desiredSkillRefs.length > MAX_SKILLS) {
    state.omittedFields.add("bundle.agentContext.skills");
  }

  const run = createdByRunId
    ? await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        invocationSource: heartbeatRuns.invocationSource,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        usageJson: heartbeatRuns.usageJson,
        sessionIdBefore: heartbeatRuns.sessionIdBefore,
        sessionIdAfter: heartbeatRuns.sessionIdAfter,
        externalRunId: heartbeatRuns.externalRunId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, createdByRunId))
      .then((rows) => rows[0] ?? null)
    : null;
  const runCosts = run
    ? await db
      .select({
        provider: costEvents.provider,
        biller: costEvents.biller,
        billingType: costEvents.billingType,
        model: costEvents.model,
        inputTokens: costEvents.inputTokens,
        cachedInputTokens: costEvents.cachedInputTokens,
        outputTokens: costEvents.outputTokens,
        costCents: costEvents.costCents,
      })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), eq(costEvents.heartbeatRunId, run.id)))
    : [];

  const usage = asRecord(run?.usageJson) ?? {};
  const runtime = {
    configuredModel: asString(adapterConfig.model),
    configuredInstructionsBundleMode: asString(adapterConfig.instructionsBundleMode),
    configuredInstructionsEntryFile: asString(adapterConfig.instructionsEntryFile),
    configuredInstructionsFilePath: asString(adapterConfig.instructionsFilePath),
    configuredInstructionsRootPath: asString(adapterConfig.instructionsRootPath),
    heartbeatPolicy: sanitizeFeedbackValue(runtimeConfig.heartbeat ?? null, state, "bundle.agentContext.runtime.heartbeatPolicy", 400),
    provenanceMode: run ? "source_run" : "vote_time_snapshot",
    sourceRun: run
      ? sanitizeFeedbackValue({
        id: run.id,
        invocationSource: run.invocationSource,
        status: run.status,
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        externalRunId: run.externalRunId ?? null,
        sessionIdBefore: run.sessionIdBefore ?? null,
        sessionIdAfter: run.sessionIdAfter ?? null,
        usage: {
          provider: asString(usage.provider),
          biller: asString(usage.biller),
          billingType: asString(usage.billingType),
          model: asString(usage.model),
          inputTokens: asNumber(usage.inputTokens) ?? asNumber(usage.rawInputTokens),
          cachedInputTokens: asNumber(usage.cachedInputTokens) ?? asNumber(usage.rawCachedInputTokens),
          outputTokens: asNumber(usage.outputTokens) ?? asNumber(usage.rawOutputTokens),
          costUsd: asNumber(usage.costUsd),
          usageSource: asString(usage.usageSource),
          sessionReused: asBoolean(usage.sessionReused),
          taskSessionReused: asBoolean(usage.taskSessionReused),
          freshSession: asBoolean(usage.freshSession),
          sessionRotated: asBoolean(usage.sessionRotated),
          sessionRotationReason: asString(usage.sessionRotationReason),
        },
      }, state, "bundle.agentContext.runtime.sourceRun", 400)
      : null,
    costSummary: runCosts.length > 0
      ? {
        providers: uniqueNonEmpty(runCosts.map((row) => row.provider)),
        billers: uniqueNonEmpty(runCosts.map((row) => row.biller)),
        billingTypes: uniqueNonEmpty(runCosts.map((row) => row.billingType)),
        models: uniqueNonEmpty(runCosts.map((row) => row.model)),
        inputTokens: runCosts.reduce((sum, row) => sum + row.inputTokens, 0),
        cachedInputTokens: runCosts.reduce((sum, row) => sum + row.cachedInputTokens, 0),
        outputTokens: runCosts.reduce((sum, row) => sum + row.outputTokens, 0),
        costCents: runCosts.reduce((sum, row) => sum + row.costCents, 0),
      }
      : null,
  };

  const instructionsBundle = await instructionsSvc.getBundle({
    id: agent.id,
    companyId: agent.companyId,
    name: agent.name,
    adapterConfig: agent.adapterConfig,
  }).catch(() => null);

  let entryDigest: string | null = null;
  let entryBody: string | null = null;
  if (instructionsBundle) {
    const readableEntryPath =
      instructionsBundle.files.find((file) => file.path === instructionsBundle.entryFile)?.path
      ?? instructionsBundle.files[0]?.path
      ?? null;
    if (readableEntryPath) {
      const entryFile = await instructionsSvc.readFile({
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        adapterConfig: agent.adapterConfig,
      }, readableEntryPath).catch(() => null);
      if (entryFile) {
        entryDigest = sha256Digest(entryFile.content);
        entryBody = sanitizeFeedbackText(
          entryFile.content,
          state,
          "bundle.agentContext.instructions.entryBody",
          MAX_INSTRUCTIONS_BODY_CHARS,
        );
      }
    }
    if (instructionsBundle.files.length > MAX_INSTRUCTION_FILES) {
      state.omittedFields.add("bundle.agentContext.instructions.files");
    }
  }

  return {
    agent: {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      adapterType: agent.adapterType,
    },
    runtime: sanitizeFeedbackValue(runtime, state, "bundle.agentContext.runtime", 400),
    skills: {
      desiredRefs: desiredSkillRefs,
      unresolvedRefs: unresolvedSkillRefs,
      items: matchedSkills.map((skill, index) => ({
        key: skill.key,
        slug: skill.slug,
        name: skill.name,
        sourceType: skill.sourceType,
        sourceLocator: skill.sourceLocator == null
          ? null
          : skill.sourceType === "github" || skill.sourceType === "skills_sh" || skill.sourceType === "url"
            ? skill.sourceLocator
            : sanitizeFeedbackText(
              skill.sourceLocator,
              state,
              `bundle.agentContext.skills.items.${index}.sourceLocator`,
              MAX_PATH_CHARS,
            ),
        sourceRef: skill.sourceRef,
        trustLevel: skill.trustLevel,
        compatibility: skill.compatibility,
        fileInventory: skill.fileInventory,
      })),
    },
    instructions: instructionsBundle
      ? {
        mode: instructionsBundle.mode,
        entryFile: instructionsBundle.entryFile,
        resolvedEntryPath: instructionsBundle.resolvedEntryPath
          ? sanitizeFeedbackText(
            instructionsBundle.resolvedEntryPath,
            state,
            "bundle.agentContext.instructions.resolvedEntryPath",
            MAX_PATH_CHARS,
          )
          : null,
        warnings: instructionsBundle.warnings.map((warning, index) =>
          sanitizeFeedbackText(
            warning,
            state,
            `bundle.agentContext.instructions.warnings.${index}`,
            400,
          )),
        legacyPromptTemplateActive: instructionsBundle.legacyPromptTemplateActive,
        legacyBootstrapPromptTemplateActive: instructionsBundle.legacyBootstrapPromptTemplateActive,
        fileCount: instructionsBundle.files.length,
        files: instructionsBundle.files.slice(0, MAX_INSTRUCTION_FILES).map((file) => ({
          path: file.path,
          size: file.size,
          language: file.language,
          markdown: file.markdown,
          isEntryFile: file.isEntryFile,
          virtual: file.virtual,
        })),
        entryDigest,
        entryBody,
      }
      : null,
    paperclip: {
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      bundleVersion: FEEDBACK_BUNDLE_VERSION,
    },
  };
}

async function buildPayloadArtifacts(
  db: Pick<Db, "select">,
  input: {
    issue: IssueFeedbackContext;
    target: ResolvedFeedbackTarget;
    voteId: string;
    vote: FeedbackVoteValue;
    reason: string | null;
    authorUserId: string;
    consentVersion: string | null;
    sharedWithLabs: boolean;
    now: Date;
  },
) {
  const state = createFeedbackRedactionState();
  const primaryBody = sanitizeFeedbackText(
    input.target.body,
    state,
    "bundle.primaryContent.body",
    MAX_PRIMARY_CONTENT_CHARS,
  );
  const primaryContent = {
    type: input.target.targetType,
    id: input.target.targetId,
    label: input.target.label,
    createdAt: input.target.createdAt.toISOString(),
    authorAgentId: input.target.authorAgentId,
    authorUserId: input.target.authorUserId,
    createdByRunId: input.target.createdByRunId,
    documentId: input.target.documentId,
    documentKey: input.target.documentKey,
    documentTitle: input.target.documentTitle,
    revisionNumber: input.target.revisionNumber,
    targetPath: input.target.targetPath,
    body: primaryBody,
    excerpt: truncateExcerpt(primaryBody),
  };
  const targetSummary = buildTargetSummary({
    label: input.target.label,
    excerpt: primaryContent.excerpt,
    authorAgentId: input.target.authorAgentId,
    authorUserId: input.target.authorUserId,
    createdAt: input.target.createdAt,
    documentKey: input.target.documentKey,
    documentTitle: input.target.documentTitle,
    revisionNumber: input.target.revisionNumber,
  });

  const basePayload = {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    bundleVersion: FEEDBACK_BUNDLE_VERSION,
    sourceApp: "paperclip",
    capturedAt: input.now.toISOString(),
    consentVersion: input.consentVersion,
    vote: {
      id: input.voteId,
      value: input.vote,
      reason: input.reason,
      authorUserId: input.authorUserId,
      sharedWithLabs: input.sharedWithLabs,
      sharedAt: input.sharedWithLabs ? input.now.toISOString() : null,
    },
    target: input.target.payloadTarget,
  } satisfies Record<string, unknown>;

  if (!input.sharedWithLabs) {
    state.notes.add("local_only_trace_stores_metadata_only");
    const payloadSnapshot = {
      ...basePayload,
      exportId: null,
      exportEligible: false,
      bundle: null,
    };
    const redactionSummary = finalizeFeedbackRedactionSummary(state);
    return {
      exportId: null,
      targetSummary,
      redactionSummary,
      payloadSnapshot: {
        ...payloadSnapshot,
        redactionSummary,
      },
      payloadDigest: sha256Digest({
        ...payloadSnapshot,
        redactionSummary,
      }),
    };
  }

  const exportId = buildExportId(input.voteId, input.now);
  const [issueContext, agentContext] = await Promise.all([
    buildIssueContext(db, input.issue, input.target, state),
    buildAgentContext(db, input.issue.companyId, input.target.authorAgentId, input.target.createdByRunId, state),
  ]);

  const payloadSnapshot = {
    ...basePayload,
    exportId,
    exportEligible: true,
    bundle: {
      primaryContent,
      issueContext,
      agentContext,
    },
  };
  const redactionSummary = finalizeFeedbackRedactionSummary(state);
  const payloadWithSummary = {
    ...payloadSnapshot,
    redactionSummary,
  };
  return {
    exportId,
    targetSummary,
    redactionSummary,
    payloadSnapshot: payloadWithSummary,
    payloadDigest: sha256Digest(payloadWithSummary),
  };
}

async function buildFeedbackTraceBundleFromRow(
  db: Db,
  row: FeedbackTraceRow,
): Promise<FeedbackTraceBundle> {
  const trace = mapTraceRow(row, true);
  const payloadSnapshot = asRecord(trace.payloadSnapshot);
  const notes: string[] = [];
  const state = createFeedbackRedactionState();
  const files: FeedbackTraceBundleFile[] = [];
  const sourceRunId = resolveSourceRunId(payloadSnapshot);

  let paperclipRun: Record<string, unknown> | null = null;
  let rawAdapterTrace: Record<string, unknown> | null = null;
  let normalizedAdapterTrace: Record<string, unknown> | null = null;
  let adapterType: string | null = null;

  if (!sourceRunId) {
    appendNote(notes, "source_run_missing");
  } else {
    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        invocationSource: heartbeatRuns.invocationSource,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        updatedAt: heartbeatRuns.updatedAt,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        usageJson: heartbeatRuns.usageJson,
        resultJson: heartbeatRuns.resultJson,
        sessionIdBefore: heartbeatRuns.sessionIdBefore,
        sessionIdAfter: heartbeatRuns.sessionIdAfter,
        externalRunId: heartbeatRuns.externalRunId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        logStore: heartbeatRuns.logStore,
        logRef: heartbeatRuns.logRef,
        logBytes: heartbeatRuns.logBytes,
        logSha256: heartbeatRuns.logSha256,
        agentName: agents.name,
        agentRole: agents.role,
        agentTitle: agents.title,
        adapterType: agents.adapterType,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.id, sourceRunId))
      .then((rows) => rows[0] ?? null);

    if (!run || run.companyId !== row.companyId) {
      appendNote(notes, "source_run_unavailable");
    } else {
      adapterType = run.adapterType;
      const events = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, run.id))
        .orderBy(asc(heartbeatRunEvents.seq));
      const logText = await readFullRunLog(run);
      const logEntries = parseRunLogEntries(logText);
      const stdoutText = logEntries
        .filter((entry) => entry.stream === "stdout")
        .map((entry) => entry.chunk)
        .join("");

      paperclipRun = sanitizeFeedbackValue(
        {
          id: run.id,
          companyId: run.companyId,
          agentId: run.agentId,
          agentName: run.agentName,
          agentRole: run.agentRole,
          agentTitle: run.agentTitle,
          adapterType: run.adapterType,
          invocationSource: run.invocationSource,
          status: run.status,
          startedAt: run.startedAt?.toISOString() ?? null,
          finishedAt: run.finishedAt?.toISOString() ?? null,
          createdAt: run.createdAt.toISOString(),
          updatedAt: run.updatedAt.toISOString(),
          error: run.error,
          errorCode: run.errorCode,
          usage: asRecord(run.usageJson),
          result: asRecord(run.resultJson),
          sessionIdBefore: run.sessionIdBefore,
          sessionIdAfter: run.sessionIdAfter,
          externalRunId: run.externalRunId,
          contextSnapshot: asRecord(run.contextSnapshot),
          logStore: run.logStore,
          logRef: run.logRef,
          logBytes: run.logBytes,
          logSha256: run.logSha256,
          eventCount: events.length,
        },
        state,
        "bundle.paperclipRun",
        MAX_TRACE_FILE_CHARS,
      ) as Record<string, unknown>;

      files.push(makeBundleFile({
        path: "paperclip/run.json",
        contentType: "application/json",
        source: "paperclip_run",
        contents: `${JSON.stringify(paperclipRun, null, 2)}\n`,
      }));

      const sanitizedEvents = sanitizeFeedbackValue(
        events,
        state,
        "bundle.paperclipRun.events",
        MAX_TRACE_FILE_CHARS,
      );
      files.push(makeBundleFile({
        path: "paperclip/run-events.json",
        contentType: "application/json",
        source: "paperclip_run_events",
        contents: `${JSON.stringify(sanitizedEvents, null, 2)}\n`,
      }));

      if (logText) {
        files.push(makeBundleFile({
          path: "paperclip/run-log.ndjson",
          contentType: "application/x-ndjson",
          source: "paperclip_run_log",
          contents: `${sanitizeFeedbackText(logText, state, "bundle.paperclipRun.log", MAX_TRACE_FILE_CHARS)}\n`,
        }));
      } else {
        appendNote(notes, "run_log_missing");
      }

      if (run.adapterType === "codex_local") {
        const adapter = await buildCodexTraceFiles({
          companyId: row.companyId,
          sessionId: run.sessionIdAfter ?? run.sessionIdBefore,
          state,
          notes,
        });
        files.push(...adapter.files);
        rawAdapterTrace = adapter.raw;
        normalizedAdapterTrace = adapter.normalized;
      } else if (run.adapterType === "claude_local") {
        const adapter = await buildClaudeTraceFiles({
          sessionId: run.sessionIdAfter ?? run.sessionIdBefore,
          stdoutText,
          state,
          notes,
        });
        files.push(...adapter.files);
        rawAdapterTrace = adapter.raw;
        normalizedAdapterTrace = adapter.normalized;
      } else if (run.adapterType === "opencode_local") {
        const adapter = await buildOpenCodeTraceFiles({
          sessionId: run.sessionIdAfter ?? run.sessionIdBefore,
          stdoutText,
          state,
          notes,
        });
        files.push(...adapter.files);
        rawAdapterTrace = adapter.raw;
        normalizedAdapterTrace = adapter.normalized;
      } else {
        appendNote(notes, "adapter_specific_trace_not_supported");
      }
    }
  }

  const privacy = {
    ...(asRecord(trace.redactionSummary) ?? {}),
    bundleRedactionSummary: finalizeFeedbackRedactionSummary(state),
  };
  const captureStatus = captureStatusFromFiles(files);
  if (captureStatus !== "full" && files.length > 0) {
    appendNote(notes, "adapter_trace_partial");
  }

  const envelope = sanitizeFeedbackValue(
    {
      traceId: trace.id,
      exportId: trace.exportId,
      companyId: trace.companyId,
      feedbackVoteId: trace.feedbackVoteId,
      issueId: trace.issueId,
      issueIdentifier: trace.issueIdentifier,
      issueTitle: trace.issueTitle,
      projectId: trace.projectId,
      authorUserId: trace.authorUserId,
      targetType: trace.targetType,
      targetId: trace.targetId,
      vote: trace.vote,
      status: trace.status,
      destination: trace.destination,
      consentVersion: trace.consentVersion,
      schemaVersion: trace.schemaVersion,
      bundleVersion: trace.bundleVersion,
      payloadVersion: trace.payloadVersion,
      payloadDigest: trace.payloadDigest,
      createdAt: trace.createdAt.toISOString(),
      exportedAt: trace.exportedAt?.toISOString() ?? null,
    },
    state,
    "bundle.envelope",
    MAX_TRACE_FILE_CHARS,
  ) as Record<string, unknown>;

  const surface = sanitizeFeedbackValue(
    {
      target: asRecord(payloadSnapshot?.target),
      summary: trace.targetSummary,
    },
    state,
    "bundle.surface",
    MAX_TRACE_FILE_CHARS,
  ) as Record<string, unknown>;

  const bundle: FeedbackTraceBundle = {
    traceId: trace.id,
    exportId: trace.exportId,
    companyId: trace.companyId,
    issueId: trace.issueId,
    issueIdentifier: trace.issueIdentifier,
    adapterType,
    captureStatus,
    notes,
    envelope,
    surface,
    paperclipRun,
    rawAdapterTrace,
    normalizedAdapterTrace,
    privacy,
    integrity: {
      payloadDigest: trace.payloadDigest,
      bundleDigest: sha256Digest({
        traceId: trace.id,
        files: files.map((file) => ({
          path: file.path,
          source: file.source,
          sha256: file.sha256,
        })),
        captureStatus,
      }),
    },
    files,
  };

  return bundle;
}

export function feedbackService(db: Db, options: FeedbackServiceOptions = {}) {
  return {
    listIssueVotesForUser: async (issueId: string, authorUserId: string) =>
      db
        .select()
        .from(feedbackVotes)
        .where(and(eq(feedbackVotes.issueId, issueId), eq(feedbackVotes.authorUserId, authorUserId))),

    listFeedbackTraces: async (input: {
      companyId: string;
      issueId?: string;
      projectId?: string;
      targetType?: FeedbackTargetType;
      vote?: FeedbackVoteValue;
      status?: FeedbackTraceStatus;
      from?: Date;
      to?: Date;
      sharedOnly?: boolean;
      includePayload?: boolean;
    }) => {
      const filters = [eq(feedbackExports.companyId, input.companyId)];
      if (input.issueId) filters.push(eq(feedbackExports.issueId, input.issueId));
      if (input.projectId) filters.push(eq(feedbackExports.projectId, input.projectId));
      if (input.targetType) filters.push(eq(feedbackExports.targetType, input.targetType));
      if (input.vote) filters.push(eq(feedbackExports.vote, input.vote));
      if (input.status) filters.push(eq(feedbackExports.status, input.status));
      if (input.sharedOnly) filters.push(ne(feedbackExports.status, "local_only"));
      if (input.from) filters.push(gte(feedbackExports.createdAt, input.from));
      if (input.to) filters.push(lte(feedbackExports.createdAt, input.to));

      const rows = await db
        .select({
          ...feedbackExportColumns,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(feedbackExports)
        .innerJoin(issues, eq(feedbackExports.issueId, issues.id))
        .where(and(...filters))
        .orderBy(desc(feedbackExports.createdAt));

      return rows.map((row) => mapTraceRow(row, input.includePayload === true));
    },

    getFeedbackTraceById: async (traceId: string, includePayload = true) => {
      const row = await db
        .select({
          ...feedbackExportColumns,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(feedbackExports)
        .innerJoin(issues, eq(feedbackExports.issueId, issues.id))
        .where(eq(feedbackExports.id, traceId))
        .then((rows) => rows[0] ?? null);
      return row ? mapTraceRow(row, includePayload) : null;
    },

    getFeedbackTraceBundle: async (traceId: string) => {
      const row = await db
        .select({
          ...feedbackExportColumns,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(feedbackExports)
        .innerJoin(issues, eq(feedbackExports.issueId, issues.id))
        .where(eq(feedbackExports.id, traceId))
        .then((rows) => rows[0] ?? null);
      return row ? buildFeedbackTraceBundleFromRow(db, row) : null;
    },

    flushPendingFeedbackTraces: async (input?: {
      companyId?: string;
      traceId?: string;
      limit?: number;
      now?: Date;
    }) => {
      const shareClient = options.shareClient;
      if (!shareClient) {
        const filters = [eq(feedbackExports.status, "pending")];
        if (input?.companyId) {
          filters.push(eq(feedbackExports.companyId, input.companyId));
        }
        if (input?.traceId) {
          filters.push(eq(feedbackExports.id, input.traceId));
        }

        const rows = await db
          .select({
            id: feedbackExports.id,
            attemptCount: feedbackExports.attemptCount,
          })
          .from(feedbackExports)
          .where(and(...filters))
          .orderBy(asc(feedbackExports.createdAt), asc(feedbackExports.id))
          .limit(Math.max(1, Math.min(input?.limit ?? 25, 200)));

        const attemptAt = input?.now ?? new Date();
        for (const row of rows) {
          await db
            .update(feedbackExports)
            .set({
              status: "failed",
              attemptCount: row.attemptCount + 1,
              lastAttemptedAt: attemptAt,
              failureReason: FEEDBACK_EXPORT_BACKEND_NOT_CONFIGURED,
              updatedAt: attemptAt,
            })
            .where(eq(feedbackExports.id, row.id));
        }

        return {
          attempted: rows.length,
          sent: 0,
          failed: rows.length,
        };
      }

      const limit = Math.max(1, Math.min(input?.limit ?? 25, 200));
      const filters = [
        or(eq(feedbackExports.status, "pending"), eq(feedbackExports.status, "failed")),
      ];
      if (input?.companyId) {
        filters.push(eq(feedbackExports.companyId, input.companyId));
      }
      if (input?.traceId) {
        filters.push(eq(feedbackExports.id, input.traceId));
      }

      const rows = await db
        .select({
          ...feedbackExportColumns,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(feedbackExports)
        .innerJoin(issues, eq(feedbackExports.issueId, issues.id))
        .where(and(...filters))
        .orderBy(asc(feedbackExports.createdAt), asc(feedbackExports.id))
        .limit(limit);

      let attempted = 0;
      let sent = 0;
      let failed = 0;

      for (const row of rows) {
        const attemptAt = input?.now ?? new Date();
        attempted += 1;

        try {
          const bundle = await buildFeedbackTraceBundleFromRow(db, row);
          await shareClient.uploadTraceBundle(bundle);

          await db
            .update(feedbackExports)
            .set({
              status: "sent",
              attemptCount: row.attemptCount + 1,
              lastAttemptedAt: attemptAt,
              exportedAt: attemptAt,
              failureReason: null,
              updatedAt: attemptAt,
            })
            .where(eq(feedbackExports.id, row.id));
          sent += 1;
        } catch (error) {
          await db
            .update(feedbackExports)
            .set({
              status: "failed",
              attemptCount: row.attemptCount + 1,
              lastAttemptedAt: attemptAt,
              failureReason: truncateFailureReason(error),
              updatedAt: attemptAt,
            })
            .where(eq(feedbackExports.id, row.id));
          failed += 1;
        }
      }

      return {
        attempted,
        sent,
        failed,
      };
    },

    saveIssueVote: async (input: {
      issueId: string;
      targetType: FeedbackTargetType;
      targetId: string;
      vote: FeedbackVoteValue;
      authorUserId: string;
      reason?: string | null;
      allowSharing?: boolean;
    }) =>
      db.transaction(async (tx) => {
        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            projectId: issues.projectId,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
          })
          .from(issues)
          .where(eq(issues.id, input.issueId))
          .then((rows) => rows[0] ?? null);
        if (!issue) throw notFound("Issue not found");

        const target = await resolveFeedbackTarget(tx, issue, input.targetType, input.targetId);

        const existingCompany = await tx
          .select({
            feedbackDataSharingEnabled: companies.feedbackDataSharingEnabled,
            feedbackDataSharingTermsVersion: companies.feedbackDataSharingTermsVersion,
          })
          .from(companies)
          .where(eq(companies.id, issue.companyId))
          .then((rows) => rows[0] ?? null);
        if (!existingCompany) throw notFound("Company not found");

        const now = new Date();
        const normalizedReason = normalizeReason(input.vote, input.reason);
        const sharedWithLabs = input.allowSharing === true;
        let consentEnabledNow = false;
        let consentVersion = existingCompany.feedbackDataSharingTermsVersion ?? null;
        let persistedSharingPreference: "allowed" | "not_allowed" | null = null;

        if (sharedWithLabs && !existingCompany.feedbackDataSharingEnabled) {
          consentEnabledNow = true;
          consentVersion = DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION;
          await tx
            .update(companies)
            .set({
              feedbackDataSharingEnabled: true,
              feedbackDataSharingConsentAt: now,
              feedbackDataSharingConsentByUserId: input.authorUserId,
              feedbackDataSharingTermsVersion: consentVersion,
              updatedAt: now,
            })
            .where(eq(companies.id, issue.companyId));
        }

        const existingInstanceSettings = await tx
          .select({
            id: instanceSettings.id,
            general: instanceSettings.general,
          })
          .from(instanceSettings)
          .where(eq(instanceSettings.singletonKey, DEFAULT_INSTANCE_SETTINGS_SINGLETON_KEY))
          .then((rows) => rows[0] ?? null);

        const currentInstanceSettings =
          existingInstanceSettings ??
          (await tx
            .insert(instanceSettings)
            .values({
              singletonKey: DEFAULT_INSTANCE_SETTINGS_SINGLETON_KEY,
              general: {},
              experimental: {},
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [instanceSettings.singletonKey],
              set: {
                updatedAt: now,
              },
            })
            .returning({
              id: instanceSettings.id,
              general: instanceSettings.general,
            })
            .then((rows) => rows[0] ?? null));

        const currentGeneral = normalizeInstanceGeneralSettings(currentInstanceSettings?.general);
        if (currentInstanceSettings && currentGeneral.feedbackDataSharingPreference === "prompt") {
          const nextSharingPreference = sharedWithLabs ? "allowed" : "not_allowed";
          const currentGeneralRaw = asRecord(currentInstanceSettings.general) ?? {};
          await tx
            .update(instanceSettings)
            .set({
              general: {
                ...currentGeneralRaw,
                censorUsernameInLogs: currentGeneral.censorUsernameInLogs,
                feedbackDataSharingPreference: nextSharingPreference,
              },
              updatedAt: now,
            })
            .where(eq(instanceSettings.id, currentInstanceSettings.id));
          persistedSharingPreference = nextSharingPreference;
        }

        const [savedVote] = await tx
          .insert(feedbackVotes)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            targetType: input.targetType,
            targetId: input.targetId,
            authorUserId: input.authorUserId,
            vote: input.vote,
            reason: normalizedReason,
            sharedWithLabs,
            sharedAt: sharedWithLabs ? now : null,
            consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
            redactionSummary: null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              feedbackVotes.companyId,
              feedbackVotes.targetType,
              feedbackVotes.targetId,
              feedbackVotes.authorUserId,
            ],
            set: {
              vote: input.vote,
              reason: normalizedReason,
              sharedWithLabs,
              sharedAt: sharedWithLabs ? now : null,
              consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
              redactionSummary: null,
              updatedAt: now,
            },
          })
          .returning();

        const artifacts = await buildPayloadArtifacts(tx, {
          issue,
          target,
          voteId: savedVote.id,
          vote: input.vote,
          reason: normalizedReason,
          authorUserId: input.authorUserId,
          consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
          sharedWithLabs,
          now,
        });

        await tx
          .update(feedbackVotes)
          .set({
            redactionSummary: artifacts.redactionSummary,
            updatedAt: now,
          })
          .where(eq(feedbackVotes.id, savedVote.id));

        const [savedTrace] = await tx
          .insert(feedbackExports)
          .values({
            companyId: issue.companyId,
            feedbackVoteId: savedVote.id,
            issueId: issue.id,
            projectId: issue.projectId,
            authorUserId: input.authorUserId,
            targetType: input.targetType,
            targetId: input.targetId,
            vote: input.vote,
            status: sharedWithLabs ? "pending" : "local_only",
            destination: sharedWithLabs ? FEEDBACK_DESTINATION : null,
            exportId: artifacts.exportId,
            consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
            schemaVersion: FEEDBACK_SCHEMA_VERSION,
            bundleVersion: FEEDBACK_BUNDLE_VERSION,
            payloadVersion: FEEDBACK_PAYLOAD_VERSION,
            payloadDigest: artifacts.payloadDigest,
            payloadSnapshot: artifacts.payloadSnapshot,
            targetSummary: artifacts.targetSummary,
            redactionSummary: artifacts.redactionSummary,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [feedbackExports.feedbackVoteId],
            set: {
              issueId: issue.id,
              projectId: issue.projectId,
              authorUserId: input.authorUserId,
              targetType: input.targetType,
              targetId: input.targetId,
              vote: input.vote,
              status: sharedWithLabs ? "pending" : "local_only",
              destination: sharedWithLabs ? FEEDBACK_DESTINATION : null,
              exportId: artifacts.exportId,
              consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
              schemaVersion: FEEDBACK_SCHEMA_VERSION,
              bundleVersion: FEEDBACK_BUNDLE_VERSION,
              payloadVersion: FEEDBACK_PAYLOAD_VERSION,
              payloadDigest: artifacts.payloadDigest,
              payloadSnapshot: artifacts.payloadSnapshot,
              targetSummary: artifacts.targetSummary,
              redactionSummary: artifacts.redactionSummary,
              failureReason: null,
              updatedAt: now,
            },
          })
          .returning({
            id: feedbackExports.id,
          });

        return {
          vote: {
            ...savedVote,
            redactionSummary: artifacts.redactionSummary,
          },
          traceId: savedTrace?.id ?? null,
          consentEnabledNow,
          persistedSharingPreference,
          sharingEnabled: sharedWithLabs,
        };
      }),
  };
}
