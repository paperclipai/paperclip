import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { normalizeConfig, type WeKnoraConfig } from "../config.js";
import { asWeknoraError, isHealthFatal, mapHttpError, WeknoraPluginError } from "../errors.js";
import {
  decodeChunks,
  decodeDiagnostics,
  decodeDocument,
  decodeEnvelope,
  decodeIngest,
  decodeKnowledgeBaseList,
  decodeKnowledgeBaseDetail,
  decodeSearch,
  decodeWikiPage,
  decodeWikiPages,
  decodeWikiSearch,
} from "./response-codecs.js";
import type { DocumentSummary, IngestResult, KnowledgeBase, KnowledgeBaseDetail, SearchResult, WikiDiagnostics, WikiPage, WikiPageSummary, WikiSearchResult } from "./types.js";

type Sleep = (milliseconds: number) => Promise<void>;

export type WeKnoraClientOptions = {
  sleep?: Sleep;
  random?: () => number;
};

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value != null) search.set(key, String(value));
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text.slice(0, 300) } };
  }
}

export class WeKnoraClient {
  constructor(
    private readonly ctx: PluginContext,
    private readonly companyId: string,
    private readonly options: WeKnoraClientOptions = {},
  ) {}

  private async config(): Promise<WeKnoraConfig> {
    return normalizeConfig(await this.ctx.config.get(this.companyId));
  }

  private async secret(config: WeKnoraConfig): Promise<string> {
    try {
      const secret = await this.ctx.secrets.resolve(config.apiKeyRef, { companyId: this.companyId, configPath: "apiKeyRef" });
      if (typeof secret !== "string" || secret.trim().length === 0) throw new Error("empty secret");
      return secret;
    } catch {
      throw new WeknoraPluginError("auth", "WeKnora API key secret could not be resolved", false, 401);
    }
  }

  private async request<T>(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
    decode: (payload: unknown) => T,
    idempotent: boolean,
  ): Promise<T> {
    const config = await this.config();
    const secret = await this.secret(config);
    const requestId = randomUUID();
    const url = `${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const maxRetries = idempotent ? 2 : 0;
    const sleep = this.options.sleep ?? defaultSleep;
    const random = this.options.random ?? Math.random;

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      try {
        const response = await this.ctx.http.fetch(url, {
          method: init.method,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "X-API-Key": secret,
            ...(config.tenantId ? { "X-Tenant-ID": config.tenantId } : {}),
            "X-Request-ID": requestId,
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          redirect: "manual",
          signal: controller.signal,
          timeoutMs: config.requestTimeoutMs,
        });
        if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
          throw new WeknoraPluginError("upstream", "WeKnora redirects are not allowed", false, response.status, requestId);
        }

        const payload = await readBody(response);
        clearTimeout(timeout);
        if (!response.ok) {
          const mapped = mapHttpError(response.status, payload, requestId);
          if (idempotent && attempt < maxRetries && (RETRYABLE_STATUS.has(response.status) || mapped.retryable)) {
            await sleep(this.retryDelay(attempt, response.headers.get("retry-after"), random));
            continue;
          }
          throw mapped;
        }
        return decode(payload);
      } catch (error) {
        clearTimeout(timeout);
        const normalized = asWeknoraError(error);
        if (idempotent && attempt < maxRetries && normalized.retryable) {
          await sleep(this.retryDelay(attempt, null, random));
          continue;
        }
        if (normalized.requestId == null && normalized.kind !== "invalid_config") {
          throw new WeknoraPluginError(normalized.kind, normalized.message, normalized.retryable, normalized.status, requestId);
        }
        throw normalized;
      }
    }
  }

  private retryDelay(attempt: number, retryAfter: string | null, random: () => number): number {
    const retryAfterMs = retryAfter ? this.retryAfterMilliseconds(retryAfter) : 0;
    const exponential = Math.min(4000, 250 * (2 ** attempt));
    const jitter = Math.floor(Math.max(0, Math.min(1, random())) * 100);
    return Math.min(5000, Math.max(exponential + jitter, retryAfterMs));
  }

  private retryAfterMilliseconds(value: string): number {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5000, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.min(5000, Math.max(0, date - Date.now())) : 0;
  }

  async listKnowledgeBases(): Promise<{ knowledgeBases: KnowledgeBase[]; total?: number }> {
    return this.request("/knowledge-bases", { method: "GET" }, (payload) => decodeEnvelope(payload, "knowledge base list", decodeKnowledgeBaseList), true);
  }

  async search(input: { query: string; knowledgeBaseIds?: string[]; knowledgeIds?: string[]; maxResults: number }): Promise<{ results: SearchResult[] }> {
    return this.request("/knowledge-search", {
      method: "POST",
      body: {
        query: input.query,
        ...(input.knowledgeBaseIds?.length ? { knowledge_base_ids: input.knowledgeBaseIds } : {}),
        ...(input.knowledgeIds?.length ? { knowledge_ids: input.knowledgeIds } : {}),
        top_k: input.maxResults,
        resource_urls: "handle",
      },
    }, (payload) => decodeEnvelope(payload, "knowledge search", decodeSearch), true);
  }

  async readKnowledge(knowledgeId: string): Promise<{ document: DocumentSummary; chunks?: Array<{ index: number; content: string; truncated: boolean }>; total?: number }> {
    return this.request(`/knowledge/${encodeURIComponent(knowledgeId)}`, { method: "GET" }, (payload) => decodeEnvelope(payload, "knowledge", decodeDocument), true);
  }

  async listChunks(knowledgeId: string, page: number, pageSize: number): Promise<{ chunks: Array<{ index: number; content: string; truncated: boolean }>; total?: number }> {
    return this.request(`/chunks/${encodeURIComponent(knowledgeId)}${queryString({ page, page_size: pageSize })}`, { method: "GET" }, (payload) => decodeEnvelope(payload, "chunks", decodeChunks), true);
  }

  async listWikiPages(knowledgeBaseId: string, page: number, pageSize: number): Promise<{ pages: WikiPageSummary[]; total?: number }> {
    return this.request(`/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/pages${queryString({ page, page_size: pageSize })}`, { method: "GET" }, (payload) => decodeEnvelope(payload, "wiki pages", decodeWikiPages), true);
  }

  async readWikiPage(knowledgeBaseId: string, slug: string): Promise<{ page: WikiPage }> {
    return this.request(`/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/pages/${encodeURIComponent(slug)}`, { method: "GET" }, (payload) => decodeEnvelope(payload, "wiki page", decodeWikiPage), true);
  }

  async searchWiki(knowledgeBaseId: string, query: string, limit: number): Promise<{ results: WikiSearchResult[] }> {
    return this.request(`/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/search${queryString({ query, limit })}`, { method: "GET" }, (payload) => decodeEnvelope(payload, "wiki search", decodeWikiSearch), true);
  }

  async knowledgeBaseDetail(knowledgeBaseId: string): Promise<KnowledgeBaseDetail> {
    return this.request(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`, { method: "GET" }, (payload) => decodeEnvelope(payload, "knowledge base detail", decodeKnowledgeBaseDetail), true);
  }

  async wikiDiagnostics(knowledgeBaseId: string): Promise<WikiDiagnostics> {
    const results = await Promise.allSettled([
      this.request(`/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/stats`, { method: "GET" }, (payload) => decodeEnvelope(payload, "wiki stats", decodeDiagnostics), true),
      this.request(`/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/lint`, { method: "GET" }, (payload) => decodeEnvelope(payload, "wiki lint", decodeDiagnostics), true),
      this.request(`/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/issues`, { method: "GET" }, (payload) => decodeEnvelope(payload, "wiki issues", decodeDiagnostics), true),
    ]);
    const [stats, lint, issues] = results;
    const fatal = results.find((result) => result.status === "rejected" && isHealthFatal(result.reason));
    if (fatal?.status === "rejected") throw asWeknoraError(fatal.reason);
    const warnings = results.flatMap((result, index) => result.status === "rejected"
      ? [`${["Wiki stats", "Wiki lint", "Wiki issues"][index]} unavailable: ${asWeknoraError(result.reason).message}`]
      : []);
    return {
      stats: stats.status === "fulfilled" ? stats.value.stats : undefined,
      lintCounts: lint.status === "fulfilled" ? lint.value.lintCounts : undefined,
      issues: issues.status === "fulfilled" ? issues.value.issues : undefined,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async ingestManual(knowledgeBaseId: string, input: { title: string; content: string; metadata?: Record<string, unknown> }): Promise<IngestResult> {
    return this.request(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge/manual`, { method: "POST", body: input }, (payload) => decodeEnvelope(payload, "manual ingest", decodeIngest), false);
  }

  async ingestUrl(knowledgeBaseId: string, input: { url: string; fileName?: string; title?: string; metadata?: Record<string, unknown> }): Promise<IngestResult> {
    return this.request(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge/url`, { method: "POST", body: input }, (payload) => decodeEnvelope(payload, "URL ingest", decodeIngest), false);
  }

  async rebuildWikiLinks(knowledgeBaseId: string): Promise<IngestResult> {
    return this.request(`/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/rebuild-links`, { method: "POST", body: {} }, (payload) => decodeEnvelope(payload, "wiki rebuild", decodeIngest), false);
  }

  async autoFixWiki(knowledgeBaseId: string): Promise<IngestResult> {
    return this.request(`/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/auto-fix`, { method: "POST", body: {} }, (payload) => decodeEnvelope(payload, "wiki auto-fix", decodeIngest), false);
  }
}

export function createWeKnoraClient(ctx: PluginContext, companyId: string, options?: WeKnoraClientOptions): WeKnoraClient {
  return new WeKnoraClient(ctx, companyId, options);
}
