import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface BlindJudgeConfig {
  apiUrl: string;
  apiKey: string;
  runId: string | null;
  taskId: string;
  allowedReadIssueIds: string[];
}

type IssueLookup = (issueId: string) => Promise<unknown>;

function normalizedIssueAlias(value: string): string {
  return value.trim().toLowerCase();
}

export function createBlindJudgeReadAuthorizer(
  allowedReadIssueIds: string[],
  lookupIssue: IssueLookup,
) {
  const configuredAliases = new Set(allowedReadIssueIds.map(normalizedIssueAlias));
  let resolvedAliasesPromise: Promise<Set<string>> | null = null;

  const resolveAliases = () => {
    resolvedAliasesPromise ??= Promise.all(
      allowedReadIssueIds.map(async (configuredId) => {
        const value = await lookupIssue(configuredId);
        const issue = value && typeof value === "object" ? value as Record<string, unknown> : {};
        return [configuredId, issue.id, issue.identifier]
          .filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
          .map(normalizedIssueAlias);
      }),
    ).then((groups) => new Set(groups.flat()));
    return resolvedAliasesPromise;
  };

  return async (issueId: string) => {
    const requestedAlias = normalizedIssueAlias(issueId);
    if (configuredAliases.has(requestedAlias)) return;
    const resolvedAliases = await resolveAliases();
    if (resolvedAliases.has(requestedAlias)) return;
    throw new Error(`blind_judge may not read Paperclip issue ${issueId}`);
  };
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function chunkBlindJudgeDocument(value: unknown, offsetChars: number, limitChars: number) {
  if (!value || typeof value !== "object") throw new Error("Paperclip document response is invalid");
  const record = value as Record<string, unknown>;
  if (typeof record.body !== "string") throw new Error("Paperclip document response has no body");
  const start = Math.min(offsetChars, record.body.length);
  const end = Math.min(start + limitChars, record.body.length);
  const keys = [
    "id",
    "issueId",
    "key",
    "title",
    "format",
    "latestRevisionId",
    "latestRevisionNumber",
    "lockedAt",
    "updatedAt",
  ] as const;
  const metadata = Object.fromEntries(
    keys.flatMap((key) => record[key] === undefined ? [] : [[key, record[key]]]),
  );
  return {
    ...metadata,
    body: record.body.slice(start, end),
    bodyLength: record.body.length,
    bodySha256: sha256Utf8(record.body),
    chunkStart: start,
    chunkEnd: end,
    nextOffset: end < record.body.length ? end : null,
  };
}

function summarizeRevision(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const keys = [
    "id",
    "documentId",
    "issueId",
    "key",
    "revisionNumber",
    "title",
    "format",
    "changeSummary",
    "createdAt",
  ] as const;
  return {
    ...Object.fromEntries(keys.flatMap((key) => record[key] === undefined ? [] : [[key, record[key]]])),
    ...(typeof record.body === "string"
      ? { bodyLength: record.body.length, computedBodySha256: sha256Utf8(record.body) }
      : {}),
  };
}

export function summarizeBlindJudgeRevisions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(summarizeRevision);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.revisions)) return summarizeRevision(record);
  return { ...record, revisions: record.revisions.map(summarizeRevision) };
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function normalizeApiUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export function readBlindJudgeConfig(env: NodeJS.ProcessEnv = process.env): BlindJudgeConfig {
  return {
    apiUrl: normalizeApiUrl(requiredEnv(env, "PAPERCLIP_API_URL")),
    apiKey: requiredEnv(env, "PAPERCLIP_API_KEY"),
    runId: env.PAPERCLIP_RUN_ID?.trim() || null,
    taskId: requiredEnv(env, "PAPERCLIP_TASK_ID"),
    allowedReadIssueIds: [
      ...new Set(
        requiredEnv(env, "PAPERCLIP_MCP_ALLOWED_READ_ISSUE_IDS")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    ],
  };
}

function formatResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function requestJson(
  config: BlindJudgeConfig,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/json",
  };
  if (config.runId) headers["X-Paperclip-Run-Id"] = config.runId;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Paperclip API ${method} ${path} failed (${response.status}): ${text}`);
  }
  return parsed;
}

export function createBlindJudgePaperclipMcpServer(config: BlindJudgeConfig = readBlindJudgeConfig()) {
  const server = new McpServer({ name: "paperclip", version: "0.1.0-blind-judge" });
  const assertReadAllowed = createBlindJudgeReadAuthorizer(
    config.allowedReadIssueIds,
    (issueId) => requestJson(config, "GET", `/issues/${encodeURIComponent(issueId)}`),
  );

  server.tool(
    "paperclipGetDocument",
    "Read one approved Paperclip issue document in bounded sequential chunks. Continue from nextOffset until it is null.",
    {
      issueId: z.string().min(1),
      key: z.string().trim().min(1).max(64),
      offsetChars: z.number().int().min(0).default(0),
      limitChars: z.number().int().min(1).max(16_000).default(12_000),
    },
    async ({ issueId, key, offsetChars, limitChars }) => {
      await assertReadAllowed(issueId);
      return formatResult(
        chunkBlindJudgeDocument(
          await requestJson(
            config,
            "GET",
            `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`,
          ),
          offsetChars,
          limitChars,
        ),
      );
    },
  );

  server.tool(
    "paperclipListDocumentRevisions",
    "List revisions of one approved Paperclip issue document, including revision integrity metadata",
    { issueId: z.string().min(1), key: z.string().trim().min(1).max(64) },
    async ({ issueId, key }) => {
      await assertReadAllowed(issueId);
      return formatResult(
        summarizeBlindJudgeRevisions(
          await requestJson(
            config,
            "GET",
            `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions`,
          ),
        ),
      );
    },
  );

  server.tool(
    "paperclipComputeSha256",
    "Compute canonical SHA-256 over UTF-8 content already visible to the evaluator",
    { content: z.string().max(2_000_000) },
    async ({ content }) => formatResult({ sha256: sha256Utf8(content), encoding: "utf8" }),
  );

  server.tool(
    "paperclipAddCurrentTaskComment",
    "Add the required evaluator report comment to the current Paperclip task only",
    { body: z.string().min(1).max(524288) },
    async ({ body }) =>
      formatResult(
        await requestJson(
          config,
          "POST",
          `/issues/${encodeURIComponent(config.taskId)}/comments`,
          { body },
        ),
      ),
  );

  server.tool(
    "paperclipSetCurrentTaskVerdict",
    "Set only the verdict status and outcome type on the current Paperclip task",
    {
      status: z.enum(["done", "in_review", "blocked"]),
      outcomeType: z.enum(["verification", "no_action"]).optional(),
    },
    async ({ status, outcomeType }) =>
      formatResult(
        await requestJson(
          config,
          "PATCH",
          `/issues/${encodeURIComponent(config.taskId)}`,
          { status, ...(outcomeType ? { outcomeType } : {}) },
        ),
      ),
  );

  return server;
}
