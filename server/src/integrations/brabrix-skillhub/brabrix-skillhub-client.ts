import { logger } from "../../middleware/logger.js";
import type {
  BrabrixSkillHubCategory,
  BrabrixSkillHubConfig,
  BrabrixSkillHubContentBlock,
  BrabrixSkillHubReadyConfig,
  BrabrixSkillHubSearchParams,
  BrabrixSkillHubSearchResponse,
  BrabrixSkillHubSkill,
} from "./brabrix-skillhub-types.js";

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_BRABRIX_SKILLHUB_API_URL = "https://api.brabrix.com";
const DEFAULT_BRABRIX_SKILLHUB_ENDPOINTS = {
  searchSkills: "/api/public/dev-hub/items",
  getSkillById: "/api/public/dev-hub/items/{skillId}",
  getSkillCategories: "/api/public/dev-hub/categories",
  getFeaturedSkills: "/api/public/dev-hub/featured",
} as const;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNonEmptyStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const normalized = asNonEmptyString(entry);
    return normalized ? [normalized] : [];
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function ensureLeadingSlash(path: string | null, fallback: string): string {
  const normalized = asNonEmptyString(path) ?? fallback;
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function classifyContentBlockType(rawType: string | null): BrabrixSkillHubContentBlock["type"] {
  if (!rawType) return "unknown";
  switch (rawType.toLowerCase()) {
    case "markdown":
      return "markdown";
    case "prompt":
    case "prompts":
      return "prompt";
    case "rules":
      return "rules";
    case "workflow":
    case "workflows":
      return "workflow";
    case "architecture":
    case "architectural_pattern":
    case "architectural-pattern":
      return "architecture";
    case "convention":
    case "conventions":
      return "convention";
    case "context":
    case "contexts":
      return "context";
    default:
      return "unknown";
  }
}

function toContentBlocks(input: {
  markdown?: string | null;
  prompts?: string[];
  rules?: string[];
  workflows?: string[];
  architectures?: string[];
  conventions?: string[];
  contexts?: string[];
  blocks?: unknown[];
}): BrabrixSkillHubContentBlock[] {
  const blocks: BrabrixSkillHubContentBlock[] = [];

  const markdown = asNonEmptyString(input.markdown);
  if (markdown) {
    blocks.push({ type: "markdown", title: "Markdown", content: markdown });
  }

  for (const prompt of input.prompts ?? []) {
    blocks.push({ type: "prompt", title: "Prompt", content: prompt });
  }
  for (const rule of input.rules ?? []) {
    blocks.push({ type: "rules", title: "Rule", content: rule });
  }
  for (const workflow of input.workflows ?? []) {
    blocks.push({ type: "workflow", title: "Workflow", content: workflow });
  }
  for (const architecture of input.architectures ?? []) {
    blocks.push({ type: "architecture", title: "Architecture", content: architecture });
  }
  for (const convention of input.conventions ?? []) {
    blocks.push({ type: "convention", title: "Convention", content: convention });
  }
  for (const context of input.contexts ?? []) {
    blocks.push({ type: "context", title: "Context", content: context });
  }

  for (const entry of input.blocks ?? []) {
    if (!isRecord(entry)) continue;
    const content = asNonEmptyString(entry.content) ?? asNonEmptyString(entry.body) ?? asNonEmptyString(entry.text);
    if (!content) continue;
    blocks.push({
      type: classifyContentBlockType(asNonEmptyString(entry.type)),
      title: asNonEmptyString(entry.title),
      content,
    });
  }

  const unique = new Set<string>();
  return blocks.filter((block) => {
    const key = `${block.type}:${block.title ?? ""}:${block.content}`;
    if (unique.has(key)) return false;
    unique.add(key);
    return true;
  });
}

function normalizeSkill(value: unknown): BrabrixSkillHubSkill | null {
  if (!isRecord(value)) return null;
  const id = asNonEmptyString(value.id) ?? asNonEmptyString(value.skillId);
  if (!id) return null;

  const slug = asNonEmptyString(value.slug) ?? id;
  const name = asNonEmptyString(value.name) ?? asNonEmptyString(value.title) ?? slug;

  const contentBlocks = toContentBlocks({
    markdown:
      asNonEmptyString(value.markdown)
      ?? asNonEmptyString(value.content)
      ?? asNonEmptyString(value.descriptionMarkdown),
    prompts: toNonEmptyStringList(value.prompts),
    rules: toNonEmptyStringList(value.rules),
    workflows: toNonEmptyStringList(value.workflows),
    architectures: toNonEmptyStringList(value.architecturalPatterns),
    conventions: toNonEmptyStringList(value.conventions),
    contexts: toNonEmptyStringList(value.contexts),
    blocks: Array.isArray(value.contentBlocks) ? value.contentBlocks : [],
  });

  return {
    id,
    slug,
    name,
    summary: asNonEmptyString(value.summary),
    description: asNonEmptyString(value.description),
    category: asNonEmptyString(value.category) ?? asNonEmptyString(value.categoryKey),
    tags: toNonEmptyStringList(value.tags),
    featured: Boolean(value.featured),
    version: asNonEmptyString(value.version),
    updatedAt: asNonEmptyString(value.updatedAt),
    author: asNonEmptyString(value.author),
    contentBlocks,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
}

function normalizeSkillList(payload: unknown): BrabrixSkillHubSearchResponse {
  if (Array.isArray(payload)) {
    return {
      skills: payload.map(normalizeSkill).filter((skill): skill is BrabrixSkillHubSkill => skill !== null),
      total: null,
    };
  }
  if (!isRecord(payload)) return { skills: [], total: null };

  const listRaw =
    (Array.isArray(payload.skills) ? payload.skills : null)
    ?? (Array.isArray(payload.items) ? payload.items : null)
    ?? (isRecord(payload.data) && Array.isArray(payload.data.skills) ? payload.data.skills : null)
    ?? (isRecord(payload.data) && Array.isArray(payload.data.items) ? payload.data.items : null)
    ?? [];
  const total =
    Number.isFinite(payload.total as number)
      ? Number(payload.total)
      : Number.isFinite(payload.totalElements as number)
        ? Number(payload.totalElements)
      : isRecord(payload.pagination) && Number.isFinite(payload.pagination.total as number)
        ? Number(payload.pagination.total)
        : null;

  return {
    skills: listRaw.map(normalizeSkill).filter((skill): skill is BrabrixSkillHubSkill => skill !== null),
    total,
  };
}

function normalizeCategories(payload: unknown): BrabrixSkillHubCategory[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.categories)
      ? payload.categories
      : isRecord(payload) && isRecord(payload.data) && Array.isArray(payload.data.categories)
        ? payload.data.categories
        : [];
  return list.flatMap((entry) => {
    if (typeof entry === "string") {
      const normalized = asNonEmptyString(entry);
      if (!normalized) return [];
      return [{
        key: normalized,
        label: normalized,
        description: null,
      }];
    }
    if (!isRecord(entry)) return [];
    const key = asNonEmptyString(entry.key) ?? asNonEmptyString(entry.id);
    const label = asNonEmptyString(entry.label) ?? asNonEmptyString(entry.name) ?? key;
    if (!key || !label) return [];
    return [{
      key,
      label,
      description: asNonEmptyString(entry.description),
    }];
  });
}

function normalizeSkillPayload(payload: unknown): BrabrixSkillHubSkill | null {
  if (!isRecord(payload)) return normalizeSkill(payload);
  if (isRecord(payload.skill)) return normalizeSkill(payload.skill);
  if (isRecord(payload.data) && isRecord(payload.data.skill)) return normalizeSkill(payload.data.skill);
  return normalizeSkill(payload);
}

export function getBrabrixSkillHubConfig(env: NodeJS.ProcessEnv = process.env): BrabrixSkillHubConfig {
  const apiToken = asNonEmptyString(env.BRABRIX_SKILLHUB_TOKEN) ?? asNonEmptyString(env.BRABRIX_AGENT_TOKEN);
  const apiKey = asNonEmptyString(env.BRABRIX_SKILLHUB_API_KEY) ?? asNonEmptyString(env.BRABRIX_API_KEY);

  return {
    apiUrl: asNonEmptyString(env.BRABRIX_SKILLHUB_API_URL) ?? DEFAULT_BRABRIX_SKILLHUB_API_URL,
    enabled: parseBoolean(env.BRABRIX_SKILLHUB_ENABLED, true),
    apiToken,
    apiKey,
    endpoints: {
      searchSkills: ensureLeadingSlash(env.BRABRIX_SKILLHUB_SEARCH_ENDPOINT ?? null, DEFAULT_BRABRIX_SKILLHUB_ENDPOINTS.searchSkills),
      getSkillById: ensureLeadingSlash(env.BRABRIX_SKILLHUB_SKILL_DETAIL_ENDPOINT ?? null, DEFAULT_BRABRIX_SKILLHUB_ENDPOINTS.getSkillById),
      getSkillCategories: ensureLeadingSlash(env.BRABRIX_SKILLHUB_CATEGORIES_ENDPOINT ?? null, DEFAULT_BRABRIX_SKILLHUB_ENDPOINTS.getSkillCategories),
      getFeaturedSkills: ensureLeadingSlash(env.BRABRIX_SKILLHUB_FEATURED_ENDPOINT ?? null, DEFAULT_BRABRIX_SKILLHUB_ENDPOINTS.getFeaturedSkills),
    },
    timeoutMs: parsePositiveInteger(env.BRABRIX_SKILLHUB_HTTP_TIMEOUT_MS, 10_000),
    maxRetries: parseNonNegativeInteger(env.BRABRIX_SKILLHUB_HTTP_MAX_RETRIES, 1),
    retryDelayMs: parseNonNegativeInteger(env.BRABRIX_SKILLHUB_HTTP_RETRY_DELAY_MS, 350),
  };
}

export function resolveBrabrixSkillHubConfig(config: BrabrixSkillHubConfig): BrabrixSkillHubReadyConfig | null {
  if (!config.enabled || !config.apiUrl) return null;
  return {
    apiUrl: config.apiUrl,
    apiToken: config.apiToken,
    apiKey: config.apiKey,
    endpoints: {
      searchSkills: config.endpoints.searchSkills,
      getSkillById: config.endpoints.getSkillById,
      getSkillCategories: config.endpoints.getSkillCategories,
      getFeaturedSkills: config.endpoints.getFeaturedSkills,
    },
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    retryDelayMs: config.retryDelayMs,
  };
}

export class BrabrixSkillHubHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly operation: string,
    readonly url: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "BrabrixSkillHubHttpError";
  }
}

export class BrabrixSkillHubClient {
  private readonly log = logger.child({ service: "brabrix-skillhub-client" });

  constructor(
    private readonly config: BrabrixSkillHubConfig = getBrabrixSkillHubConfig(),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  isEnabled(): boolean {
    return resolveBrabrixSkillHubConfig(this.config) !== null;
  }

  private resolveConfig(): BrabrixSkillHubReadyConfig {
    const resolved = resolveBrabrixSkillHubConfig(this.config);
    if (!resolved) {
      throw new Error("Brabrix SkillHub integration is disabled. Set BRABRIX_SKILLHUB_ENABLED=true and BRABRIX_SKILLHUB_API_URL.");
    }
    return resolved;
  }

  private resolveEndpointPath(
    template: string,
    params: Record<string, string | number | null | undefined> = {},
  ): string {
    return template.replaceAll(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
      const value = params[key];
      if (value === null || value === undefined || String(value).trim().length === 0) {
        throw new Error(`Missing Brabrix SkillHub path parameter: ${key}`);
      }
      return encodeURIComponent(String(value));
    });
  }

  private buildHeaders(cfg: BrabrixSkillHubReadyConfig, hasBody: boolean): Record<string, string> {
    return {
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(cfg.apiToken ? { authorization: `Bearer ${cfg.apiToken}` } : {}),
      ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}),
    };
  }

  private async request<T>(input: {
    method: "GET" | "POST";
    endpoint: keyof BrabrixSkillHubReadyConfig["endpoints"];
    pathParams?: Record<string, string | number | null | undefined>;
    query?: Record<string, string | number | null | undefined>;
    body?: unknown;
    operation: string;
    map: (payload: unknown) => T;
  }): Promise<T> {
    const cfg = this.resolveConfig();
    const endpointTemplate = cfg.endpoints[input.endpoint];
    const resolvedPath = this.resolveEndpointPath(endpointTemplate, input.pathParams);
    const url = new URL(resolvedPath, cfg.apiUrl);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value === null || value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const maxAttempts = Math.max(1, cfg.maxRetries + 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const response = await this.fetcher(url.toString(), {
          method: input.method,
          headers: this.buildHeaders(cfg, input.body !== undefined),
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const retryable = RETRYABLE_STATUS_CODES.has(response.status);
          const body = await response.text().catch(() => "");
          this.log.warn({
            operation: input.operation,
            attempt,
            maxAttempts,
            status: response.status,
            retryable,
            durationMs: Date.now() - startedAt,
            responseBody: body.slice(0, 500),
          }, "brabrix skillhub http call failed");
          if (retryable && attempt < maxAttempts) {
            await sleep(cfg.retryDelayMs * attempt);
            continue;
          }
          throw new BrabrixSkillHubHttpError(
            `Brabrix SkillHub request failed (${response.status}) for ${input.operation}.`,
            response.status,
            input.operation,
            url.toString(),
            retryable,
          );
        }

        const json = await response.json().catch(() => null);
        this.log.debug({
          operation: input.operation,
          attempt,
          maxAttempts,
          durationMs: Date.now() - startedAt,
        }, "brabrix skillhub http call completed");
        return input.map(json);
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        const retryable = aborted || (error instanceof BrabrixSkillHubHttpError && error.retryable);
        this.log.warn({
          operation: input.operation,
          attempt,
          maxAttempts,
          retryable,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }, "brabrix skillhub http call errored");
        if (retryable && attempt < maxAttempts) {
          await sleep(cfg.retryDelayMs * attempt);
          continue;
        }
        if (error instanceof BrabrixSkillHubHttpError) {
          throw error;
        }
        throw new BrabrixSkillHubHttpError(
          `Brabrix SkillHub request failed for ${input.operation}: ${error instanceof Error ? error.message : String(error)}.`,
          null,
          input.operation,
          url.toString(),
          retryable,
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error(`Brabrix SkillHub request exhausted retries for ${input.operation}.`);
  }

  async searchSkills(params: BrabrixSkillHubSearchParams = {}): Promise<BrabrixSkillHubSearchResponse> {
    const limit = params.limit ?? 20;
    const offset = params.offset ?? 0;
    const page = Math.max(0, Math.floor(offset / Math.max(1, limit)));

    return this.request({
      method: "GET",
      endpoint: "searchSkills",
      query: {
        q: params.query ?? undefined,
        category: params.category ?? undefined,
        tags: params.tags?.join(",") ?? undefined,
        limit,
        page,
      },
      operation: "searchSkills",
      map: normalizeSkillList,
    });
  }

  async getSkillById(skillId: string): Promise<BrabrixSkillHubSkill | null> {
    try {
      return await this.request({
        method: "GET",
        endpoint: "getSkillById",
        pathParams: { skillId },
        operation: "getSkillById",
        map: normalizeSkillPayload,
      });
    } catch (error) {
      if (error instanceof BrabrixSkillHubHttpError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async importSkill(skillId: string): Promise<BrabrixSkillHubSkill | null> {
    return this.getSkillById(skillId);
  }

  async getSkillCategories(): Promise<BrabrixSkillHubCategory[]> {
    return this.request({
      method: "GET",
      endpoint: "getSkillCategories",
      operation: "getSkillCategories",
      map: normalizeCategories,
    });
  }

  async getFeaturedSkills(limit = 12): Promise<BrabrixSkillHubSkill[]> {
    return this.request({
      method: "GET",
      endpoint: "getFeaturedSkills",
      query: {
        limit,
      },
      operation: "getFeaturedSkills",
      map: (payload) => normalizeSkillList(payload).skills,
    });
  }
}
