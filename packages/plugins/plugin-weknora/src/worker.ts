import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { normalizeConfig, type WeKnoraConfig } from "./config.js";
import { asWeknoraError, WeknoraPluginError } from "./errors.js";
import { PLUGIN_ID, ROUTE_KEYS, TOOL_NAMES } from "./manifest.js";
import { createWeKnoraClient } from "./client/weknora-client.js";
import { createHealthService, unavailableHealth } from "./services/health.js";
import { createIngestionService } from "./services/ingestion.js";
import { createRetrievalService } from "./services/retrieval.js";
import { createWikiService } from "./services/wiki.js";

const COMPANY_ID_FIELD = "companyId";

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WeknoraPluginError("upstream", `${label} must be an object`, false);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WeknoraPluginError("upstream", `${field} is required`, false);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function companyIdFromParams(params: Record<string, unknown>, expectedCompanyId?: string): string {
  const companyId = requiredString(params[COMPANY_ID_FIELD], COMPANY_ID_FIELD);
  if (expectedCompanyId && companyId !== expectedCompanyId) {
    throw new WeknoraPluginError("forbidden", "companyId does not match the authorized company", false, 403);
  }
  return companyId;
}

async function configFor(ctx: PluginContext, companyId: string): Promise<WeKnoraConfig> {
  return normalizeConfig(await ctx.config.get(companyId));
}

async function servicesFor(ctx: PluginContext, companyId: string) {
  const config = await configFor(ctx, companyId);
  const client = createWeKnoraClient(ctx, companyId);
  return {
    config,
    client,
    retrieval: createRetrievalService(client, config),
    wiki: createWikiService(client, config),
    health: createHealthService(client, config),
    ingestion: createIngestionService(client, config),
  };
}

async function healthResultFor(ctx: PluginContext, companyId: string, knowledgeBaseId?: string) {
  try {
    return await (await servicesFor(ctx, companyId)).health.check(knowledgeBaseId);
  } catch (error) {
    return unavailableHealth(new Date().toISOString(), error);
  }
}

function toolDeclaration(ctx: PluginContext, name: string) {
  const declaration = ctx.manifest.tools?.find((tool) => tool.name === name);
  if (!declaration) throw new Error(`Manifest does not declare tool ${name}`);
  return declaration;
}

function toolParams(params: unknown, runCtx: ToolRunContext): Record<string, unknown> {
  const input = record(params, "tool parameters");
  companyIdFromParams(input, runCtx.companyId);
  return input;
}

function toolResult(data: unknown, content?: string): ToolResult {
  return {
    content: content ?? JSON.stringify(data),
    data,
  };
}

async function registerReadTools(ctx: PluginContext): Promise<void> {
  ctx.tools.register(TOOL_NAMES.listKnowledgeBases, toolDeclaration(ctx, TOOL_NAMES.listKnowledgeBases), async (params, runCtx) => {
    const input = toolParams(params, runCtx);
    const result = await (await servicesFor(ctx, runCtx.companyId)).retrieval.listKnowledgeBases();
    return toolResult(result);
  });

  ctx.tools.register(TOOL_NAMES.search, toolDeclaration(ctx, TOOL_NAMES.search), async (params, runCtx) => {
    const input = toolParams(params, runCtx);
    const result = await (await servicesFor(ctx, runCtx.companyId)).retrieval.search({
      query: requiredString(input.query, "query"),
      knowledgeBaseIds: Array.isArray(input.knowledgeBaseIds) ? input.knowledgeBaseIds.filter((value): value is string => typeof value === "string") : undefined,
      knowledgeIds: Array.isArray(input.knowledgeIds) ? input.knowledgeIds.filter((value): value is string => typeof value === "string") : undefined,
      maxResults: typeof input.maxResults === "number" ? input.maxResults : undefined,
    });
    return toolResult(result);
  });

  ctx.tools.register(TOOL_NAMES.readDocument, toolDeclaration(ctx, TOOL_NAMES.readDocument), async (params, runCtx) => {
    const input = toolParams(params, runCtx);
    const result = await (await servicesFor(ctx, runCtx.companyId)).retrieval.readDocument({
      knowledgeId: requiredString(input.knowledgeId, "knowledgeId"),
      page: typeof input.page === "number" ? input.page : undefined,
      pageSize: typeof input.pageSize === "number" ? input.pageSize : undefined,
    });
    return toolResult(result);
  });

  ctx.tools.register(TOOL_NAMES.listWikiPages, toolDeclaration(ctx, TOOL_NAMES.listWikiPages), async (params, runCtx) => {
    const input = toolParams(params, runCtx);
    const result = await (await servicesFor(ctx, runCtx.companyId)).wiki.listPages({
      knowledgeBaseId: requiredString(input.knowledgeBaseId, "knowledgeBaseId"),
      page: typeof input.page === "number" ? input.page : undefined,
      pageSize: typeof input.pageSize === "number" ? input.pageSize : undefined,
    });
    return toolResult(result);
  });

  ctx.tools.register(TOOL_NAMES.readWikiPage, toolDeclaration(ctx, TOOL_NAMES.readWikiPage), async (params, runCtx) => {
    const input = toolParams(params, runCtx);
    const result = await (await servicesFor(ctx, runCtx.companyId)).wiki.readPage({
      knowledgeBaseId: requiredString(input.knowledgeBaseId, "knowledgeBaseId"),
      slug: requiredString(input.slug, "slug"),
    });
    return toolResult(result);
  });

  ctx.tools.register(TOOL_NAMES.searchWiki, toolDeclaration(ctx, TOOL_NAMES.searchWiki), async (params, runCtx) => {
    const input = toolParams(params, runCtx);
    const result = await (await servicesFor(ctx, runCtx.companyId)).wiki.search({
      knowledgeBaseId: requiredString(input.knowledgeBaseId, "knowledgeBaseId"),
      query: requiredString(input.query, "query"),
      limit: typeof input.limit === "number" ? input.limit : undefined,
    });
    return toolResult(result);
  });

  ctx.tools.register(TOOL_NAMES.health, toolDeclaration(ctx, TOOL_NAMES.health), async (params, runCtx) => {
    const input = toolParams(params, runCtx);
    const result = await healthResultFor(ctx, runCtx.companyId, optionalString(input.knowledgeBaseId));
    return toolResult(result);
  });
}

function actionCompanyId(params: Record<string, unknown>, context: PluginPerformActionContext): string {
  if (context.actor.type !== "user") {
    throw new WeknoraPluginError("forbidden", "This WeKnora action is available to board users only", false, 403);
  }
  const companyId = context.companyId ?? context.actor.companyId;
  if (!companyId) throw new WeknoraPluginError("forbidden", "A company scope is required", false, 403);
  return companyIdFromParams({ ...params, companyId }, companyId);
}

async function recordWrite(ctx: PluginContext, companyId: string, action: string, knowledgeBaseId: string, result: unknown): Promise<void> {
  const resultRecord = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
  await ctx.activity.log({
    companyId,
    message: `WeKnora board action completed: ${action}`,
    entityType: "weknora_operation",
    entityId: typeof resultRecord.id === "string" ? resultRecord.id : knowledgeBaseId,
    metadata: { pluginId: PLUGIN_ID, action, knowledgeBaseId },
  });
}

function bodyRecord(input: PluginApiRequestInput): Record<string, unknown> {
  return input.body == null ? {} : record(input.body, "request body");
}

function apiResponseError(error: unknown): { status: number; body: { error: ReturnType<WeknoraPluginError["toJSON"]> } } {
  const normalized = asWeknoraError(error);
  const status = normalized.status && normalized.status >= 400 && normalized.status < 600 ? normalized.status : normalized.kind === "forbidden" ? 403 : 400;
  return { status, body: { error: normalized.toJSON() } };
}

async function handleReadRoute(ctx: PluginContext, input: PluginApiRequestInput): Promise<unknown> {
  const companyId = input.companyId;
  if (input.routeKey === ROUTE_KEYS.health) {
    return healthResultFor(ctx, companyId, optionalString(firstQueryValue(input.query.knowledgeBaseId)));
  }
  const services = await servicesFor(ctx, companyId);
  const query = input.query;
  const params = input.params;
  switch (input.routeKey) {
    case ROUTE_KEYS.overview:
      return {
        configured: true,
        baseUrl: services.config.baseUrl,
        tenantConfigured: Boolean(services.config.tenantId),
        defaultKnowledgeBaseIds: services.config.defaultKnowledgeBaseIds,
        defaultWikiKnowledgeBaseId: services.config.defaultWikiKnowledgeBaseId ?? null,
        maxResults: services.config.maxResults,
        maxChunkChars: services.config.maxChunkChars,
        requestTimeoutMs: services.config.requestTimeoutMs,
        enableWriteActions: services.config.enableWriteActions,
        resourceUrls: services.config.resourceUrls,
      };
    case ROUTE_KEYS.knowledgeBases:
      return services.retrieval.listKnowledgeBases();
    case ROUTE_KEYS.search: {
      const body = bodyRecord(input);
      return services.retrieval.search({
        query: requiredString(body.query, "query"),
        knowledgeBaseIds: Array.isArray(body.knowledgeBaseIds) ? body.knowledgeBaseIds.filter((value): value is string => typeof value === "string") : undefined,
        knowledgeIds: Array.isArray(body.knowledgeIds) ? body.knowledgeIds.filter((value): value is string => typeof value === "string") : undefined,
        maxResults: typeof body.maxResults === "number" ? body.maxResults : undefined,
      });
    }
    case ROUTE_KEYS.document:
      return services.retrieval.readDocument({
        knowledgeId: requiredString(params.knowledgeId, "knowledgeId"),
        page: Number(firstQueryValue(query.page)) || undefined,
        pageSize: Number(firstQueryValue(query.pageSize)) || undefined,
      });
    case ROUTE_KEYS.wikiPages:
      return services.wiki.listPages({
        knowledgeBaseId: requiredString(params.knowledgeBaseId, "knowledgeBaseId"),
        page: Number(firstQueryValue(query.page)) || undefined,
        pageSize: Number(firstQueryValue(query.pageSize)) || undefined,
      });
    case ROUTE_KEYS.wikiPage:
      return services.wiki.readPage({
        knowledgeBaseId: requiredString(params.knowledgeBaseId, "knowledgeBaseId"),
        slug: requiredString(firstQueryValue(query.slug), "slug"),
      });
    case ROUTE_KEYS.wikiSearch:
      return services.wiki.search({
        knowledgeBaseId: requiredString(params.knowledgeBaseId, "knowledgeBaseId"),
        query: requiredString(firstQueryValue(query.query), "query"),
        limit: Number(firstQueryValue(query.limit)) || undefined,
      });
    default:
      throw new WeknoraPluginError("not_found", "Unknown WeKnora route", false, 404);
  }
}

async function handleWriteRoute(ctx: PluginContext, input: PluginApiRequestInput): Promise<unknown> {
  if (input.actor.actorType !== "user") {
    throw new WeknoraPluginError("forbidden", "WeKnora write routes are available to board users only", false, 403);
  }
  const services = await servicesFor(ctx, input.companyId);
  const params = input.params;
  const body = bodyRecord(input);
  const knowledgeBaseId = requiredString(params.knowledgeBaseId, "knowledgeBaseId");
  let result: unknown;
  switch (input.routeKey) {
    case ROUTE_KEYS.ingestManual:
      result = await services.ingestion.manual({ knowledgeBaseId, title: requiredString(body.title, "title"), content: requiredString(body.content, "content"), metadata: body.metadata });
      break;
    case ROUTE_KEYS.ingestUrl:
      result = await services.ingestion.url({ knowledgeBaseId, url: requiredString(body.url, "url"), fileName: optionalString(body.fileName), title: optionalString(body.title), metadata: body.metadata });
      break;
    case ROUTE_KEYS.rebuildWikiLinks:
      result = await services.ingestion.rebuildWikiLinks(knowledgeBaseId);
      break;
    case ROUTE_KEYS.autoFixWiki:
      result = await services.ingestion.autoFixWiki(knowledgeBaseId);
      break;
    default:
      throw new WeknoraPluginError("not_found", "Unknown WeKnora write route", false, 404);
  }
  await recordWrite(ctx, input.companyId, input.routeKey, knowledgeBaseId, result);
  return result;
}

const plugin = definePlugin({
  async setup(ctx) {
    await registerReadTools(ctx);

    ctx.data.register("overview", async (params) => {
      const companyId = companyIdFromParams(params);
      try {
        return await handleReadRoute(ctx, { routeKey: ROUTE_KEYS.overview, method: "GET", path: "/overview", params: {}, query: {}, body: null, actor: { actorType: "user", actorId: "ui", userId: "ui", agentId: null }, companyId, headers: {} });
      } catch (error) {
        const normalized = asWeknoraError(error);
        return { configured: false, error: normalized.toJSON() };
      }
    });
    ctx.data.register("knowledge-bases", async (params) => (await servicesFor(ctx, companyIdFromParams(params))).retrieval.listKnowledgeBases());
    ctx.data.register("search", async (params) => {
      const companyId = companyIdFromParams(params);
      return (await servicesFor(ctx, companyId)).retrieval.search({
        query: requiredString(params.query, "query"),
        knowledgeBaseIds: Array.isArray(params.knowledgeBaseIds) ? params.knowledgeBaseIds.filter((value): value is string => typeof value === "string") : undefined,
        knowledgeIds: Array.isArray(params.knowledgeIds) ? params.knowledgeIds.filter((value): value is string => typeof value === "string") : undefined,
        maxResults: typeof params.maxResults === "number" ? params.maxResults : undefined,
      });
    });
    ctx.data.register("document", async (params) => (await servicesFor(ctx, companyIdFromParams(params))).retrieval.readDocument({ knowledgeId: requiredString(params.knowledgeId, "knowledgeId"), page: typeof params.page === "number" ? params.page : undefined, pageSize: typeof params.pageSize === "number" ? params.pageSize : undefined }));
    ctx.data.register("wiki-pages", async (params) => (await servicesFor(ctx, companyIdFromParams(params))).wiki.listPages({ knowledgeBaseId: requiredString(params.knowledgeBaseId, "knowledgeBaseId"), page: typeof params.page === "number" ? params.page : undefined, pageSize: typeof params.pageSize === "number" ? params.pageSize : undefined }));
    ctx.data.register("wiki-page", async (params) => (await servicesFor(ctx, companyIdFromParams(params))).wiki.readPage({ knowledgeBaseId: requiredString(params.knowledgeBaseId, "knowledgeBaseId"), slug: requiredString(params.slug, "slug") }));
    ctx.data.register("wiki-search", async (params) => (await servicesFor(ctx, companyIdFromParams(params))).wiki.search({ knowledgeBaseId: requiredString(params.knowledgeBaseId, "knowledgeBaseId"), query: requiredString(params.query, "query"), limit: typeof params.limit === "number" ? params.limit : undefined }));
    ctx.data.register("health", async (params) => healthResultFor(ctx, companyIdFromParams(params), optionalString(params.knowledgeBaseId)));

    ctx.actions.register("ingest-manual", async (params, context) => {
      const companyId = actionCompanyId(params, context);
      const body = record(params, "action parameters");
      const knowledgeBaseId = requiredString(body.knowledgeBaseId, "knowledgeBaseId");
      const result = await (await servicesFor(ctx, companyId)).ingestion.manual({ knowledgeBaseId, title: requiredString(body.title, "title"), content: requiredString(body.content, "content"), metadata: body.metadata });
      await recordWrite(ctx, companyId, "ingest-manual", knowledgeBaseId, result);
      return result;
    });
    ctx.actions.register("ingest-url", async (params, context) => {
      const companyId = actionCompanyId(params, context);
      const body = record(params, "action parameters");
      const knowledgeBaseId = requiredString(body.knowledgeBaseId, "knowledgeBaseId");
      const result = await (await servicesFor(ctx, companyId)).ingestion.url({ knowledgeBaseId, url: requiredString(body.url, "url"), fileName: optionalString(body.fileName), title: optionalString(body.title), metadata: body.metadata });
      await recordWrite(ctx, companyId, "ingest-url", knowledgeBaseId, result);
      return result;
    });
    for (const [key, method] of [["rebuild-wiki-links", "rebuildWikiLinks"], ["auto-fix-wiki", "autoFixWiki"]] as const) {
      ctx.actions.register(key, async (params, context) => {
        const companyId = actionCompanyId(params, context);
        const body = record(params, "action parameters");
        const knowledgeBaseId = requiredString(body.knowledgeBaseId, "knowledgeBaseId");
        const ingestion = (await servicesFor(ctx, companyId)).ingestion;
        const result = await ingestion[method](knowledgeBaseId);
        await recordWrite(ctx, companyId, key, knowledgeBaseId, result);
        return result;
      });
    }
  },

  async onValidateConfig(config) {
    try {
      normalizeConfig(config);
      return { ok: true };
    } catch (error) {
      return { ok: false, errors: [asWeknoraError(error).message] };
    }
  },

  async onApiRequest(input) {
    try {
      const writes = new Set<string>([ROUTE_KEYS.ingestManual, ROUTE_KEYS.ingestUrl, ROUTE_KEYS.rebuildWikiLinks, ROUTE_KEYS.autoFixWiki]);
      const body = writes.has(input.routeKey) ? await handleWriteRoute(thisContext(), input) : await handleReadRoute(thisContext(), input);
      return { status: 200, body };
    } catch (error) {
      return apiResponseError(error);
    }
  },

  async onHealth() {
    return { status: "ok", message: "WeKnora plugin worker is running", details: { pluginId: PLUGIN_ID, readTools: 7, writeActionsEnabledByDefault: false } };
  },
});

let workerContext: PluginContext | null = null;
function thisContext(): PluginContext {
  if (!workerContext) throw new Error("WeKnora plugin worker has not been set up");
  return workerContext;
}

const setup = plugin.definition.setup;
plugin.definition.setup = async (ctx) => {
  workerContext = ctx;
  await setup(ctx);
};

export default plugin;
runWorker(plugin, import.meta.url);
