import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import { DATA_KEYS, DEFAULT_CONFIG, PLUGIN_ID, TOOL_NAMES } from "./constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SentryConfig = {
  authToken: string;
  organizationSlug: string;
  projectSlug?: string;
  sentryBaseUrl?: string;
};

type SentryIssue = {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  status: string;
  firstSeen: string;
  lastSeen: string;
  count: string;
  userCount: number;
  project: { id: string; name: string; slug: string };
  metadata: Record<string, unknown>;
  permalink: string;
  statusDetails: Record<string, unknown>;
};

type SentryEvent = {
  eventID: string;
  title: string;
  message: string;
  dateCreated: string;
  context: Record<string, unknown>;
  tags: Array<{ key: string; value: string }>;
  entries: Array<{ type: string; data: unknown }>;
};

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

let currentContext: PluginContext | null = null;

async function getConfig(ctx: PluginContext): Promise<SentryConfig> {
  const raw = (await ctx.config.get()) as Partial<SentryConfig> | null;
  return {
    authToken: raw?.authToken ?? DEFAULT_CONFIG.authToken,
    organizationSlug: raw?.organizationSlug ?? DEFAULT_CONFIG.organizationSlug,
    projectSlug: raw?.projectSlug ?? DEFAULT_CONFIG.projectSlug,
    sentryBaseUrl: raw?.sentryBaseUrl ?? DEFAULT_CONFIG.sentryBaseUrl,
  };
}

function ensureConfigured(config: SentryConfig): void {
  if (!config.authToken) {
    throw new Error("Sentry auth token is not configured. Set it in plugin settings.");
  }
  if (!config.organizationSlug) {
    throw new Error("Sentry organization slug is not configured. Set it in plugin settings.");
  }
}

// ---------------------------------------------------------------------------
// Sentry API helpers
// ---------------------------------------------------------------------------

async function sentryFetch(ctx: PluginContext, config: SentryConfig, path: string): Promise<unknown> {
  const baseUrl = (config.sentryBaseUrl || "https://sentry.io").replace(/\/$/, "");
  const url = `${baseUrl}/api/0/${path}`;

  const response = await ctx.http.fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.authToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sentry API ${response.status}: ${body.slice(0, 500)}`);
  }

  return await response.json();
}

function buildIssueQuery(
  config: SentryConfig,
  opts: {
    query?: string;
    project?: string;
    limit?: number;
    sort?: string;
  },
): string {
  const org = config.organizationSlug;
  const params = new URLSearchParams();
  if (opts.query) params.set("query", opts.query);
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  params.set("limit", String(limit));
  if (opts.sort) params.set("sort", opts.sort);

  const projectSlug = opts.project ?? config.projectSlug;
  if (projectSlug) params.set("project", projectSlug);

  return `organizations/${org}/issues/?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function registerToolHandlers(ctx: PluginContext): Promise<void> {
  ctx.tools.register(
    TOOL_NAMES.listIssues,
    {
      displayName: "List Sentry Issues",
      description: "List recent Sentry issues filtered by project, level, and status.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          project: { type: "string" },
          limit: { type: "number" },
          sort: { type: "string", enum: ["date", "new", "freq", "priority"] },
        },
      },
    },
    async (params): Promise<ToolResult> => {
      const config = await getConfig(ctx);
      ensureConfigured(config);
      const p = params as { query?: string; project?: string; limit?: number; sort?: string };
      const path = buildIssueQuery(config, p);
      const issues = (await sentryFetch(ctx, config, path)) as SentryIssue[];
      const summary = issues.map((i) => ({
        id: i.id,
        shortId: i.shortId,
        title: i.title,
        level: i.level,
        status: i.status,
        count: i.count,
        userCount: i.userCount,
        lastSeen: i.lastSeen,
        firstSeen: i.firstSeen,
        culprit: i.culprit,
        project: i.project?.slug,
        permalink: i.permalink,
      }));
      return {
        content: `Found ${issues.length} Sentry issue(s).\n\n${summary.map((i) => `- [${i.level.toUpperCase()}] ${i.shortId}: ${i.title} (${i.count} events, last seen ${i.lastSeen})`).join("\n")}`,
        data: summary,
      };
    },
  );

  ctx.tools.register(
    TOOL_NAMES.getIssue,
    {
      displayName: "Get Sentry Issue Detail",
      description: "Get detailed information about a Sentry issue including stacktrace and tags.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
        },
        required: ["issueId"],
      },
    },
    async (params): Promise<ToolResult> => {
      const config = await getConfig(ctx);
      ensureConfigured(config);
      const { issueId } = params as { issueId: string };
      if (!issueId) return { error: "issueId is required" };

      const org = config.organizationSlug;
      const issue = (await sentryFetch(ctx, config, `organizations/${org}/issues/${issueId}/`)) as SentryIssue;
      const events = (await sentryFetch(
        ctx,
        config,
        `organizations/${org}/issues/${issueId}/events/?limit=5`,
      )) as SentryEvent[];
      const latestEvent = events[0];

      // Extract stacktrace from latest event entries
      let stacktrace: unknown = null;
      if (latestEvent?.entries) {
        const exceptionEntry = latestEvent.entries.find((e) => e.type === "exception");
        if (exceptionEntry) stacktrace = exceptionEntry.data;
      }

      return {
        content: `**${issue.shortId}: ${issue.title}**\nLevel: ${issue.level} | Status: ${issue.status}\nFirst seen: ${issue.firstSeen} | Last seen: ${issue.lastSeen}\nEvents: ${issue.count} | Users: ${issue.userCount}\nCulprit: ${issue.culprit}\n${stacktrace ? "\nStacktrace available in data." : ""}`,
        data: {
          issue: {
            id: issue.id,
            shortId: issue.shortId,
            title: issue.title,
            level: issue.level,
            status: issue.status,
            culprit: issue.culprit,
            firstSeen: issue.firstSeen,
            lastSeen: issue.lastSeen,
            count: issue.count,
            userCount: issue.userCount,
            metadata: issue.metadata,
            permalink: issue.permalink,
          },
          latestEvent: latestEvent
            ? {
                eventID: latestEvent.eventID,
                title: latestEvent.title,
                message: latestEvent.message,
                dateCreated: latestEvent.dateCreated,
                tags: latestEvent.tags,
              }
            : null,
          stacktrace,
          recentEvents: events.map((e) => ({
            eventID: e.eventID,
            title: e.title,
            dateCreated: e.dateCreated,
          })),
        },
      };
    },
  );

  ctx.tools.register(
    TOOL_NAMES.search,
    {
      displayName: "Search Sentry Errors",
      description: "Search Sentry errors by query string.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          level: { type: "string", enum: ["fatal", "error", "warning", "info", "debug"] },
          dateRange: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
    async (params): Promise<ToolResult> => {
      const config = await getConfig(ctx);
      ensureConfigured(config);
      const p = params as { query: string; level?: string; dateRange?: string; limit?: number };

      // Build a combined search query for the issues endpoint
      let sentryQuery = p.query;
      if (p.level) sentryQuery += ` level:${p.level}`;

      const org = config.organizationSlug;
      const urlParams = new URLSearchParams();
      urlParams.set("query", sentryQuery);
      const limit = Math.min(Math.max(p.limit ?? 25, 1), 100);
      urlParams.set("limit", String(limit));

      // Map dateRange to Sentry statsPeriod
      if (p.dateRange) {
        urlParams.set("statsPeriod", p.dateRange);
      }
      if (config.projectSlug) {
        urlParams.set("project", config.projectSlug);
      }

      const issues = (await sentryFetch(
        ctx,
        config,
        `organizations/${org}/issues/?${urlParams.toString()}`,
      )) as SentryIssue[];

      const results = issues.map((i) => ({
        id: i.id,
        shortId: i.shortId,
        title: i.title,
        level: i.level,
        status: i.status,
        count: i.count,
        lastSeen: i.lastSeen,
        culprit: i.culprit,
        permalink: i.permalink,
      }));

      return {
        content: `Search for "${p.query}" returned ${results.length} result(s).\n\n${results.map((r) => `- [${r.level.toUpperCase()}] ${r.shortId}: ${r.title} (${r.count} events)`).join("\n")}`,
        data: results,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Data handlers (for UI bridge)
// ---------------------------------------------------------------------------

async function registerDataHandlers(ctx: PluginContext): Promise<void> {
  ctx.data.register(DATA_KEYS.overview, async () => {
    const config = await getConfig(ctx);
    if (!config.authToken || !config.organizationSlug) {
      return {
        configured: false,
        issues: [],
        stats: null,
      };
    }
    try {
      const org = config.organizationSlug;
      const params = new URLSearchParams();
      params.set("query", "is:unresolved");
      params.set("limit", "20");
      params.set("sort", "date");
      if (config.projectSlug) params.set("project", config.projectSlug);

      const issues = (await sentryFetch(
        ctx,
        config,
        `organizations/${org}/issues/?${params.toString()}`,
      )) as SentryIssue[];

      return {
        configured: true,
        issues: issues.map((i) => ({
          id: i.id,
          shortId: i.shortId,
          title: i.title,
          level: i.level,
          status: i.status,
          count: i.count,
          userCount: i.userCount,
          lastSeen: i.lastSeen,
          firstSeen: i.firstSeen,
          culprit: i.culprit,
          project: i.project?.slug ?? "",
          permalink: i.permalink,
        })),
      };
    } catch (err) {
      return {
        configured: true,
        issues: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ctx.data.register(DATA_KEYS.issueDetail, async (params) => {
    const config = await getConfig(ctx);
    ensureConfigured(config);
    const issueId = typeof params.issueId === "string" ? params.issueId : "";
    if (!issueId) throw new Error("issueId is required");

    const org = config.organizationSlug;
    const issue = (await sentryFetch(ctx, config, `organizations/${org}/issues/${issueId}/`)) as SentryIssue;
    const events = (await sentryFetch(
      ctx,
      config,
      `organizations/${org}/issues/${issueId}/events/?limit=10`,
    )) as SentryEvent[];
    const latestEvent = events[0];

    let stacktrace: unknown = null;
    let breadcrumbs: unknown = null;
    if (latestEvent?.entries) {
      const exceptionEntry = latestEvent.entries.find((e) => e.type === "exception");
      if (exceptionEntry) stacktrace = exceptionEntry.data;
      const breadcrumbEntry = latestEvent.entries.find((e) => e.type === "breadcrumbs");
      if (breadcrumbEntry) breadcrumbs = breadcrumbEntry.data;
    }

    return {
      issue,
      latestEvent: latestEvent ?? null,
      stacktrace,
      breadcrumbs,
      events: events.map((e) => ({
        eventID: e.eventID,
        title: e.title,
        message: e.message,
        dateCreated: e.dateCreated,
        tags: e.tags,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    ctx.logger.info("Sentry plugin initializing", { pluginId: PLUGIN_ID });
    await registerToolHandlers(ctx);
    await registerDataHandlers(ctx);
    ctx.logger.info("Sentry plugin setup complete");
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentContext;
    if (!ctx) {
      return { status: "degraded", message: "Plugin context not initialized" };
    }
    try {
      const config = await getConfig(ctx);
      if (!config.authToken || !config.organizationSlug) {
        return { status: "degraded", message: "Sentry credentials not configured" };
      }
      // Quick connectivity check
      await sentryFetch(ctx, config, `organizations/${config.organizationSlug}/`);
      return { status: "ok", message: "Connected to Sentry" };
    } catch (err) {
      return {
        status: "degraded",
        message: `Sentry API unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  async onValidateConfig(config) {
    const c = config as Partial<SentryConfig>;
    if (!c.authToken) return { ok: false, errors: ["authToken is required"] };
    if (!c.organizationSlug) return { ok: false, errors: ["organizationSlug is required"] };
    return { ok: true };
  },
});

runWorker(plugin, import.meta.url);
