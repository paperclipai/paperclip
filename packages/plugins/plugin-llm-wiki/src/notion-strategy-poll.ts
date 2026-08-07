import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Company, PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { WIKI_ROOT_FOLDER_KEY } from "./manifest.js";
import { DEFAULT_SPACE_SLUG, DEFAULT_WIKI_ID, resolveSpace, type WikiSpace } from "./wiki.js";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const DEFAULT_NOTION_TOKEN_PATH = "~/.paperclip/instances/default/secrets/notion-token.txt";
const DEFAULT_NOTION_TASKS_DATABASE_ID_PATH = "~/.paperclip/instances/default/secrets/notion-tasks-database-id.txt";
const DEFAULT_CRO_AGENT_ID = "fb0272a1-0b64-42c6-bebf-835c6ea22903";
const MAX_PAGINATION_ITERATIONS = 50;

const STRATEGY_TITLE_MARKERS = ["\u0441\u0442\u0440\u0430\u0442\u0435\u0433", "strategy"] as const;
const STRATEGY_RESEARCH_TAG = "research";
const STRATEGY_DOMAIN_TAGS = new Set(["btc", "metrics"]);
const SKIP_STATUSES = new Set(["done", "cancelled", "canceled", "archived"]);

type NotionStrategyPollConfig = {
  enabled: boolean;
  wikiId: string;
  spaceSlug: string;
  tokenPath: string;
  tasksDatabaseIdPath: string;
  token?: string | null;
  tasksDatabaseId?: string | null;
  croAgentId: string;
  /**
   * Companies this job fans out over. The host never grants a plugin a wildcard
   * ("all companies") scope on a proactive worker-to-host call, so the job must
   * name each company explicitly and issue one company-scoped call per entry.
   */
  companyIds: string[];
};

type NotionPage = {
  id: string;
  object: "page";
  url?: string;
  archived?: boolean;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
};

type PollCounts = {
  companies: number;
  pagesFetched: number;
  pagesSkipped: number;
  pagesMatched: number;
  issuesCreated: number;
  alreadyProcessed: number;
  failures: number;
};

type CompanyPollResult = {
  companyId: string;
  wikiId: string;
  spaceSlug: string;
  status: "succeeded" | "failed" | "partial";
  counts: PollCounts;
  warnings: string[];
  emittedIssues: string[];
};

function tableName(namespace: string, table: string): string {
  return `${namespace}.${table}`;
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? "";
  if (path.startsWith("~/")) return `${process.env.HOME ?? ""}${path.slice(1)}`;
  return path;
}

function readSecretFile(path: string): string | null {
  try {
    const value = readFileSync(expandHome(path), "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function plainText(richText: unknown): string {
  if (!Array.isArray(richText)) return "";
  return richText
    .map((part) => typeof part === "object" && part != null && "plain_text" in part ? String(part.plain_text ?? "") : "")
    .join("");
}

function normalizePageId(id: string): string {
  return id.replace(/-/g, "");
}

function extractTitle(page: NotionPage): string {
  const properties = page.properties ?? {};
  for (const name of ["Task name", "Name"]) {
    const prop = properties[name];
    if (typeof prop === "object" && prop != null && (prop as { type?: string }).type === "title") {
      const title = plainText((prop as { title?: unknown }).title).trim();
      if (title) return title;
    }
  }
  for (const prop of Object.values(properties)) {
    if (typeof prop === "object" && prop != null && (prop as { type?: string }).type === "title") {
      const title = plainText((prop as { title?: unknown }).title).trim();
      if (title) return title;
    }
  }
  return "";
}

function extractStatus(page: NotionPage): string {
  const prop = page.properties?.Status;
  if (typeof prop !== "object" || prop == null) return "";
  const typed = prop as { type?: string; status?: { name?: unknown } | null; select?: { name?: unknown } | null };
  if (typed.type === "status") return stringField(typed.status?.name) ?? "";
  if (typed.type === "select") return stringField(typed.select?.name) ?? "";
  return "";
}

function extractTags(page: NotionPage): string[] {
  const prop = page.properties?.Tags;
  if (typeof prop !== "object" || prop == null) return [];
  const tags = (prop as { multi_select?: unknown }).multi_select;
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => typeof tag === "object" && tag != null ? stringField((tag as { name?: unknown }).name)?.toLowerCase() : null)
    .filter((tag): tag is string => Boolean(tag));
}

export function isNotionStrategyPage(page: NotionPage): { match: boolean; reason: string } {
  if (page.archived === true) return { match: false, reason: "skip: archived page" };
  const title = extractTitle(page).toLowerCase();
  const status = extractStatus(page).toLowerCase();
  const tags = new Set(extractTags(page));
  if (SKIP_STATUSES.has(status)) return { match: false, reason: `skip: status=${JSON.stringify(status)}` };
  if (tags.size === 0) return { match: false, reason: "no tags (likely template sub-page)" };

  const titleHit = STRATEGY_TITLE_MARKERS.some((marker) => title.includes(marker));
  const domainHit = [...tags].filter((tag) => STRATEGY_DOMAIN_TAGS.has(tag));
  const tagHit = tags.has(STRATEGY_RESEARCH_TAG) && domainHit.length > 0;
  if (tagHit && titleHit) return { match: true, reason: `title strategy + research + ${JSON.stringify(domainHit.sort())}` };
  if (tagHit) return { match: true, reason: `research + ${JSON.stringify(domainHit.sort())}` };
  if (titleHit) {
    return {
      match: false,
      reason: `title mentions strategy but missing required tags (needs 'research' + one of ${JSON.stringify([...STRATEGY_DOMAIN_TAGS].sort())}; tags=${JSON.stringify([...tags].sort())})`,
    };
  }
  return { match: false, reason: `not a strategy (status=${JSON.stringify(status)} tags=${JSON.stringify([...tags].sort())})` };
}

async function notionRequest<T>(
  ctx: PluginContext,
  token: string,
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<T> {
  const response = await ctx.http.fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
      ...(init.headers ?? {}),
    },
  });
  if ((response.status === 429 || response.status >= 500) && attempt < 3) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 250 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return notionRequest<T>(ctx, token, path, init, attempt + 1);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Notion ${init.method ?? "GET"} ${path} failed: HTTP ${response.status}${body ? ` ${body.slice(0, 500)}` : ""}`);
  }
  return await response.json() as T;
}

async function queryTasksDatabase(ctx: PluginContext, token: string, databaseId: string, sinceIso: string | null): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let startCursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let i = 0; i < MAX_PAGINATION_ITERATIONS; i += 1) {
    if (startCursor) {
      if (seenCursors.has(startCursor)) {
        throw new Error(`Notion pagination cursor repeated (${startCursor}); aborting to avoid an infinite loop.`);
      }
      seenCursors.add(startCursor);
    }
    const body: Record<string, unknown> = {
      page_size: 100,
      sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
    };
    if (sinceIso) {
      body.filter = { timestamp: "last_edited_time", last_edited_time: { after: sinceIso } };
    }
    if (startCursor) body.start_cursor = startCursor;

    const payload = await notionRequest<{ results?: unknown[]; has_more?: boolean; next_cursor?: string | null }>(
      ctx,
      token,
      `/databases/${databaseId}/query`,
      { method: "POST", body: JSON.stringify(body) },
    );
    for (const row of payload.results ?? []) {
      if (typeof row === "object" && row != null && (row as { object?: string }).object === "page") {
        pages.push(row as NotionPage);
      }
    }
    if (!payload.has_more) return pages;
    startCursor = payload.next_cursor ?? undefined;
    if (!startCursor) return pages;
  }
  throw new Error(`Notion pagination exceeded ${MAX_PAGINATION_ITERATIONS} iterations; aborting.`);
}

function stringArrayField(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value
    .map((entry) => stringField(entry))
    .filter((entry): entry is string => Boolean(entry));
  return out.length > 0 ? out : null;
}

async function readConfig(ctx: PluginContext): Promise<NotionStrategyPollConfig> {
  const config = await ctx.config.get();
  return {
    enabled: config.notionStrategyPollEnabled !== false,
    wikiId: stringField(config.notionStrategyPollWikiId) ?? stringField(config.notionSyncWikiId) ?? DEFAULT_WIKI_ID,
    spaceSlug: stringField(config.notionStrategyPollSpaceSlug) ?? stringField(config.notionSyncSpaceSlug) ?? DEFAULT_SPACE_SLUG,
    token: stringField(config.notionStrategyPollToken) ?? stringField(config.notionToken) ?? process.env.NOTION_TOKEN ?? null,
    tokenPath: stringField(config.notionStrategyPollTokenPath) ?? stringField(config.notionTokenPath) ?? process.env.NOTION_TOKEN_PATH ?? DEFAULT_NOTION_TOKEN_PATH,
    tasksDatabaseId: stringField(config.notionStrategyPollTasksDatabaseId) ?? stringField(config.notionTasksDatabaseId) ?? process.env.NOTION_TASKS_DATABASE_ID ?? null,
    tasksDatabaseIdPath: stringField(config.notionStrategyPollTasksDatabaseIdPath) ?? stringField(config.notionTasksDatabaseIdPath) ?? process.env.NOTION_TASKS_DATABASE_ID_PATH ?? DEFAULT_NOTION_TASKS_DATABASE_ID_PATH,
    croAgentId: stringField(config.notionStrategyPollCroAgentId) ?? process.env.PAPERCLIP_CRO_AGENT_ID ?? DEFAULT_CRO_AGENT_ID,
    companyIds:
      stringArrayField(config.notionStrategyPollCompanyIds) ??
      stringArrayField(config.notionSyncCompanyIds) ??
      [],
  };
}

function resolveToken(config: NotionStrategyPollConfig): string {
  const token = config.token ?? readSecretFile(config.tokenPath);
  if (!token) {
    throw new Error(`Notion token missing. Configure notionStrategyPollToken/notionStrategyPollTokenPath, notionToken/notionTokenPath, or create ${config.tokenPath}.`);
  }
  return token;
}

function resolveTasksDatabaseId(config: NotionStrategyPollConfig): string {
  const databaseId = config.tasksDatabaseId ?? readSecretFile(config.tasksDatabaseIdPath);
  if (!databaseId) {
    throw new Error(`Notion Tasks database id missing. Configure notionStrategyPollTasksDatabaseId/notionStrategyPollTasksDatabaseIdPath, notionTasksDatabaseId/notionTasksDatabaseIdPath, or create ${config.tasksDatabaseIdPath}.`);
  }
  return databaseId;
}

async function latestWatermark(ctx: PluginContext, input: { companyId: string; wikiId: string; spaceId: string }): Promise<string | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT max(notion_last_edited_time)::text AS watermark
       FROM ${tableName(ctx.db.namespace, "notion_strategy_poll_cursors")}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3`,
    [input.companyId, input.wikiId, input.spaceId],
  );
  return stringField(rows[0]?.watermark);
}

async function alreadyProcessed(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  spaceId: string;
  notionPageIdNormalized: string;
  lastEditedTime: string;
}): Promise<boolean> {
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT 1
       FROM ${tableName(ctx.db.namespace, "notion_strategy_poll_cursors")}
      WHERE company_id = $1
        AND wiki_id = $2
        AND space_id = $3
        AND notion_page_id_normalized = $4
        AND notion_last_edited_time = $5::timestamptz
      LIMIT 1`,
    [input.companyId, input.wikiId, input.spaceId, input.notionPageIdNormalized, input.lastEditedTime],
  );
  return rows.length > 0;
}

async function recordProcessed(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  spaceId: string;
  notionPageId: string;
  lastEditedTime: string;
  issueId: string | null;
  issueIdentifier: string | null;
  metadata: Record<string, unknown>;
}) {
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx.db.namespace, "notion_strategy_poll_cursors")}
       (id, company_id, wiki_id, space_id, notion_page_id, notion_page_id_normalized, notion_last_edited_time,
        emitted_issue_id, emitted_issue_identifier, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10::jsonb)
     ON CONFLICT (company_id, wiki_id, space_id, notion_page_id_normalized, notion_last_edited_time)
     DO UPDATE SET emitted_issue_id = EXCLUDED.emitted_issue_id,
                   emitted_issue_identifier = EXCLUDED.emitted_issue_identifier,
                   metadata = EXCLUDED.metadata,
                   updated_at = now()`,
    [
      randomUUID(),
      input.companyId,
      input.wikiId,
      input.spaceId,
      input.notionPageId,
      normalizePageId(input.notionPageId),
      input.lastEditedTime,
      input.issueId ?? null,
      input.issueIdentifier,
      jsonParam(input.metadata),
    ],
  );
}

async function recordOperation(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  spaceId: string;
  operationId: string;
  runId: string;
  status: "succeeded" | "failed" | "partial";
  warnings: string[];
  metadata: Record<string, unknown>;
}) {
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx.db.namespace, "wiki_operations")}
       (id, company_id, wiki_id, space_id, operation_type, status, run_ids, cost_cents, warnings, affected_pages, metadata)
     VALUES ($1, $2, $3, $4, 'notion-strategy-poll', $5, $6::jsonb, 0, $7::jsonb, '[]'::jsonb, $8::jsonb)`,
    [
      input.operationId,
      input.companyId,
      input.wikiId,
      input.spaceId,
      input.status,
      jsonParam([input.runId]),
      jsonParam(input.warnings),
      jsonParam(input.metadata),
    ],
  );
}

function buildCroIssue(input: {
  companyId: string;
  croAgentId: string;
  page: NotionPage;
  reason: string;
}) {
  const title = extractTitle(input.page) || "(untitled Notion task)";
  const status = extractStatus(input.page);
  const tags = extractTags(input.page);
  const edited = input.page.last_edited_time ?? "";
  const notionId = input.page.id;
  const url = input.page.url ?? "";
  return {
    companyId: input.companyId,
    title: `Research: ${title}`,
    description: [
      "Research task auto-created by plugin-native Notion Strategy Poll.",
      "",
      `**Source:** ${url ? `[${title}](${url})` : title}`,
      `**Notion id:** \`${notionId}\``,
      `**Notion status:** ${status || "n/a"}`,
      `**Tags:** ${tags.length > 0 ? tags.join(", ") : "n/a"}`,
      `**Last edited:** ${edited || "n/a"}`,
      `**Detection:** ${input.reason}`,
      "",
      "Please analyse this strategy, document assumptions, and propose a backtest or paper-trade plan. Escalate to CTO if data dependencies are unclear.",
    ].join("\n"),
    status: "todo" as const,
    priority: "medium" as const,
    assigneeAgentId: input.croAgentId,
    originKind: "plugin:llm-wiki:notion-strategy-poll" as const,
    originId: `notion:${normalizePageId(notionId)}:${edited}`,
    originRunId: null,
  };
}

async function syncCompany(ctx: PluginContext, company: Company, job: PluginJobContext): Promise<CompanyPollResult> {
  const config = await readConfig(ctx);
  const counts: PollCounts = {
    companies: 1,
    pagesFetched: 0,
    pagesSkipped: 0,
    pagesMatched: 0,
    issuesCreated: 0,
    alreadyProcessed: 0,
    failures: 0,
  };
  const warnings: string[] = [];
  const emittedIssues: string[] = [];
  const wikiId = config.wikiId;

  const folderStatus = await ctx.localFolders.status(company.id, WIKI_ROOT_FOLDER_KEY);
  if (!folderStatus.configured || !folderStatus.readable) {
    return {
      companyId: company.id,
      wikiId,
      spaceSlug: config.spaceSlug,
      status: "succeeded",
      counts,
      warnings: ["Skipped: wiki-root local folder is not configured for this company."],
      emittedIssues,
    };
  }

  const space = await resolveSpace(ctx, { companyId: company.id, wikiId, spaceSlug: config.spaceSlug });
  const operationId = randomUUID();
  try {
    if (!config.enabled) {
      warnings.push("Notion strategy poll disabled by plugin config.");
      await recordOperation(ctx, {
        companyId: company.id,
        wikiId,
        spaceId: space.id,
        operationId,
        runId: job.runId,
        status: "succeeded",
        warnings,
        metadata: { skipped: true, reason: "disabled" },
      });
      return { companyId: company.id, wikiId, spaceSlug: space.slug, status: "succeeded", counts, warnings, emittedIssues };
    }

    const token = resolveToken(config);
    const tasksDatabaseId = resolveTasksDatabaseId(config);
    const since = await latestWatermark(ctx, { companyId: company.id, wikiId, spaceId: space.id });
    const pages = await queryTasksDatabase(ctx, token, tasksDatabaseId, since);
    counts.pagesFetched = pages.length;

    for (const page of pages) {
      const edited = page.last_edited_time;
      if (!edited) {
        counts.pagesSkipped += 1;
        warnings.push(`Skipped Notion page ${page.id}: missing last_edited_time.`);
        continue;
      }
      const pageIdNormalized = normalizePageId(page.id);
      if (await alreadyProcessed(ctx, {
        companyId: company.id,
        wikiId,
        spaceId: space.id,
        notionPageIdNormalized: pageIdNormalized,
        lastEditedTime: edited,
      })) {
        counts.alreadyProcessed += 1;
        continue;
      }
      const decision = isNotionStrategyPage(page);
      if (!decision.match) {
        counts.pagesSkipped += 1;
        await recordProcessed(ctx, {
          companyId: company.id,
          wikiId,
          spaceId: space.id,
          notionPageId: page.id,
          lastEditedTime: edited,
          issueId: null,
          issueIdentifier: null,
          metadata: {
            title: extractTitle(page),
            notionUrl: page.url ?? null,
            skipped: true,
            skipReason: decision.reason,
            jobRunId: job.runId,
          },
        });
        continue;
      }
      counts.pagesMatched += 1;
      const issue = await ctx.issues.create(buildCroIssue({
        companyId: company.id,
        croAgentId: config.croAgentId,
        page,
        reason: decision.reason,
      }));
      await recordProcessed(ctx, {
        companyId: company.id,
        wikiId,
        spaceId: space.id,
        notionPageId: page.id,
        lastEditedTime: edited,
        issueId: issue.id,
        issueIdentifier: issue.identifier ?? null,
        metadata: {
          title: extractTitle(page),
          notionUrl: page.url ?? null,
          detectionReason: decision.reason,
          jobRunId: job.runId,
        },
      });
      emittedIssues.push(issue.identifier ?? issue.id);
      counts.issuesCreated += 1;
    }
  } catch (error) {
    counts.failures += 1;
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  const status = counts.failures > 0 && counts.issuesCreated > 0 ? "partial" : counts.failures > 0 ? "failed" : "succeeded";
  await recordOperation(ctx, {
    companyId: company.id,
    wikiId,
    spaceId: space.id,
    operationId,
    runId: job.runId,
    status,
    warnings,
    metadata: { counts, emittedIssues, scheduledAt: job.scheduledAt, trigger: job.trigger },
  });
  await ctx.metrics.write("notion_strategy_poll.run", 1, { status, trigger: job.trigger });
  return { companyId: company.id, wikiId, spaceSlug: space.slug, status, counts, warnings, emittedIssues };
}

export async function runNotionStrategyPoll(ctx: PluginContext, job: PluginJobContext) {
  const { companyIds } = await readConfig(ctx);
  if (companyIds.length === 0) {
    ctx.logger.warn("Notion Strategy Poll skipped: no notionStrategyPollCompanyIds configured", {
      jobKey: job.jobKey,
      runId: job.runId,
    });
    return { status: "skipped", results: [] as CompanyPollResult[] };
  }
  const companies: Company[] = [];
  for (const companyId of companyIds) {
    const company = await ctx.companies.get(companyId);
    if (!company) {
      ctx.logger.warn("Notion Strategy Poll: configured company not found or not authorized", {
        jobKey: job.jobKey,
        runId: job.runId,
        companyId,
      });
      continue;
    }
    companies.push(company);
  }
  const results: CompanyPollResult[] = [];
  for (const company of companies) {
    results.push(await syncCompany(ctx, company, job));
  }
  ctx.logger.info("Notion Strategy Poll job completed", {
    jobKey: job.jobKey,
    runId: job.runId,
    companyCount: companies.length,
    statuses: results.map((result) => ({ companyId: result.companyId, status: result.status, counts: result.counts })),
  });
  return { status: "ok", results };
}
