import fs from "node:fs/promises";
import { logger } from "../../middleware/logger.js";
import { resolveManagedProjectWorkspaceDir } from "../../home-paths.js";
import { projectService } from "../../services/projects.js";
import { goalService } from "../../services/goals.js";
import { issueService } from "../../services/issues.js";
import { companySkillService } from "../../services/company-skills.js";
import type { Db } from "@paperclipai/db";
import type { BrabrixConfig } from "./brabrix-config.js";
import type {
  BrabrixBacklogItem,
  BrabrixFeature,
  BrabrixPrd,
  BrabrixProject,
  BrabrixProjectBundle,
  BrabrixSkillReference,
  BrabrixSpec,
  ProjectContext,
} from "./brabrix-types.js";
import {
  mapBrabrixBacklogItemToIssue,
  mapBrabrixFeatureToGoal,
  mapBrabrixPrdToProjectContext,
  mapBrabrixProjectToProjectInput,
  mapBrabrixSkillReferenceToSkill,
  mapBrabrixSpecToTechnicalContext,
  type BrabrixImportMetadata,
} from "./brabrix-project-mappers.js";

const BRABRIX_BACKLOG_ISSUE_ORIGIN_KIND = "brabrix_backlog_item";
const BRABRIX_WORKSPACE_METADATA_KEY = "brabrix";
const BRABRIX_SYNC_STALE_MS = 12 * 60 * 60 * 1000;

type BrabrixImporterEndpoints = {
  memberships: string;
  listProjects: string;
  projectDetail: string;
  projectContextExport: string;
  projectBacklog: string;
  projectWorkflow: string;
  projectSkillsExport: string;
  projectSkills: string;
};

export interface BrabrixImportedProjectSummary {
  brabrixProjectId: string;
  localProjectId: string;
  localProjectName: string;
  workspaceId: string;
  workspaceName: string;
  brabrixImportedAt: string | null;
  brabrixLastSyncedAt: string | null;
  brabrixSourceUrl: string | null;
  badges: {
    imported: boolean;
    synced: boolean;
    outOfSync: boolean;
  };
}

export interface BrabrixProjectImportResult {
  mode: "import" | "sync";
  brabrixProjectId: string;
  localProjectId: string;
  localWorkspaceId: string;
  projectName: string;
  importedAt: string;
  lastSyncedAt: string;
  counts: {
    goalsUpserted: number;
    issuesUpserted: number;
    skillsImported: number;
    prdImported: boolean;
    specsImported: number;
  };
  warnings: string[];
}

export interface BrabrixConnectionCheckResult {
  ok: boolean;
  message: string;
  projectCount: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asNonEmptyString(entry)).filter((entry): entry is string => Boolean(entry));
}

function normalizeAuthToken(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (trimmed.toLowerCase().startsWith("bearer ")) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

function isApiKeyToken(token: string): boolean {
  return token.startsWith("bbx_");
}

function applyPathParams(template: string, params: Record<string, string | null | undefined>): string {
  return template.replaceAll(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (!value) throw new Error(`Missing path param "${key}" for template "${template}".`);
    return encodeURIComponent(value);
  });
}

function withQueryString(url: string, query: Record<string, string | number | boolean | null | undefined>): string {
  const parsed = new URL(url);
  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === null || rawValue === undefined) continue;
    parsed.searchParams.set(key, String(rawValue));
  }
  return parsed.toString();
}

function toAbsoluteUrl(baseUrl: string | null, endpointTemplate: string, pathParams: Record<string, string | null | undefined>): string {
  const resolved = applyPathParams(endpointTemplate, pathParams);
  if (/^https?:\/\//i.test(resolved)) return resolved;
  if (!baseUrl) {
    throw new Error(`Relative endpoint "${endpointTemplate}" requires BRABRIX_API_URL.`);
  }
  const normalizedPath = resolved.startsWith("/") ? resolved : `/${resolved}`;
  return new URL(normalizedPath, baseUrl).toString();
}

function truncateForLog(value: string | undefined, maxLength = 500): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
}

function extractRequestIdFromResponseBody(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { requestId?: unknown };
    return typeof parsed.requestId === "string" && parsed.requestId.trim().length > 0
      ? parsed.requestId.trim()
      : null;
  } catch {
    return null;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function defaultImporterEndpointsFromEnv(env: NodeJS.ProcessEnv = process.env): BrabrixImporterEndpoints {
  const nonEmpty = (value: string | undefined, fallback: string) => {
    const normalized = asNonEmptyString(value);
    return normalized ?? fallback;
  };
  return {
    memberships: nonEmpty(env.BRABRIX_MEMBERSHIPS_ENDPOINT, "/api/v1/me/memberships"),
    listProjects: nonEmpty(env.BRABRIX_LIST_PROJECTS_ENDPOINT, "/api/v1/tenants/current/dev/projects"),
    projectDetail: nonEmpty(env.BRABRIX_PROJECT_DETAIL_ENDPOINT, "/api/v1/tenants/current/dev/projects/{projectId}"),
    projectContextExport: nonEmpty(env.BRABRIX_PROJECT_CONTEXT_EXPORT_ENDPOINT, "/api/v1/tenants/current/dev/projects/{projectId}/export/context"),
    projectBacklog: nonEmpty(env.BRABRIX_PROJECT_BACKLOG_ENDPOINT, "/api/v1/tenants/current/dev/projects/{projectId}/backlog"),
    projectWorkflow: nonEmpty(env.BRABRIX_PROJECT_WORKFLOW_ENDPOINT, "/api/v1/tenants/current/dev/projects/{projectId}/workflow"),
    projectSkillsExport: nonEmpty(env.BRABRIX_PROJECT_SKILLS_EXPORT_ENDPOINT, "/api/v1/tenants/current/dev/projects/{projectId}/skills/export"),
    projectSkills: nonEmpty(env.BRABRIX_PROJECT_SKILLS_ENDPOINT, "/api/v1/tenants/current/dev/projects/{projectId}/skills"),
  };
}

function shouldAttachTenantHeader(url: string): boolean {
  return url.includes("/tenants/current/");
}

function normalizeBrabrixProject(value: unknown): BrabrixProject | null {
  const record = asRecord(value);
  if (!record) return null;
  const projectId = asNonEmptyString(record.projectId) ?? asNonEmptyString(record.id);
  const name = asNonEmptyString(record.name);
  if (!projectId || !name) return null;
  return {
    projectId,
    name,
    description: asNonEmptyString(record.description),
    status: asNonEmptyString(record.status),
    customerName: asNonEmptyString(record.customerName),
    projectType: asNonEmptyString(record.projectType),
    updatedAt: asNonEmptyString(record.updatedAt),
    sourceUrl: asNonEmptyString(record.sourceUrl) ?? asNonEmptyString(record.url),
    metadata: record,
  };
}

function normalizeProjectList(payload: unknown): BrabrixProject[] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeBrabrixProject).filter((entry): entry is BrabrixProject => entry !== null);
  }
  const record = asRecord(payload);
  if (!record) return [];
  const candidates = [
    record.items,
    record.projects,
    asRecord(record.data)?.items,
    asRecord(record.data)?.projects,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const mapped = candidate.map(normalizeBrabrixProject).filter((entry): entry is BrabrixProject => entry !== null);
    if (mapped.length > 0) return mapped;
  }
  return [];
}

type BrabrixMembership = {
  tenantId: string;
  tenantName: string | null;
  roleCode: string | null;
  tenantSlug: string | null;
  isPreferred: boolean;
  metadata: Record<string, unknown>;
};

function normalizeMembership(value: unknown): BrabrixMembership | null {
  const record = asRecord(value);
  if (!record) return null;
  const tenantRecord = asRecord(record.tenant);
  const tenantId = asNonEmptyString(record.tenantId)
    ?? asNonEmptyString(tenantRecord?.tenantId)
    ?? asNonEmptyString(tenantRecord?.id);
  if (!tenantId) return null;

  return {
    tenantId,
    tenantName: asNonEmptyString(record.tenantName) ?? asNonEmptyString(tenantRecord?.name),
    roleCode: asNonEmptyString(record.roleCode) ?? asNonEmptyString(record.role),
    tenantSlug: asNonEmptyString(record.tenantSlug) ?? asNonEmptyString(tenantRecord?.slug),
    isPreferred:
      record.isCurrent === true
      || record.current === true
      || record.isActive === true
      || record.active === true
      || record.isDefault === true
      || record.default === true
      || tenantRecord?.isDefault === true
      || tenantRecord?.active === true,
    metadata: record,
  };
}

function normalizeMembershipList(payload: unknown): BrabrixMembership[] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeMembership).filter((entry): entry is BrabrixMembership => entry !== null);
  }
  const record = asRecord(payload);
  if (!record) return [];
  const data = asRecord(record.data);
  const candidates: unknown[] = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.memberships)
      ? record.memberships
      : Array.isArray(data?.items)
        ? data.items as unknown[]
        : Array.isArray(data?.memberships)
          ? data.memberships as unknown[]
          : [];
  return candidates
    .map(normalizeMembership)
    .filter((entry): entry is BrabrixMembership => entry !== null);
}

function normalizeProjectContextFromExport(projectId: string, projectName: string, payload: unknown): ProjectContext | null {
  const record = asRecord(payload);
  if (!record) return null;
  const projectContextMd = asNonEmptyString(record.projectContextMd);
  const summary = asNonEmptyString(record.summary);
  const description = projectContextMd ?? summary ?? asNonEmptyString(record.description);
  if (!description) return null;
  return {
    projectId,
    name: projectName,
    description,
    skills: [],
    metadata: {
      source: "project_context_export",
      hasPrdMd: Boolean(asNonEmptyString(record.prdMd)),
      hasTechnicalSpecMd: Boolean(asNonEmptyString(record.technicalSpecMd)),
    },
  };
}

function normalizeBrabrixPrd(payload: unknown): BrabrixPrd | null {
  const record = asRecord(payload);
  if (!record) return null;
  const title = asNonEmptyString(record.title) ?? "PRD";
  const content = asNonEmptyString(record.content) ?? asNonEmptyString(record.markdown);
  if (!content) return null;
  return {
    title,
    content,
    status: asNonEmptyString(record.status),
    sourceUrl: asNonEmptyString(record.sourceUrl) ?? asNonEmptyString(record.url),
    updatedAt: asNonEmptyString(record.updatedAt),
    metadata: record,
  };
}

function normalizeBrabrixSpec(payload: unknown, type: string): BrabrixSpec | null {
  const record = asRecord(payload);
  if (!record) return null;
  const content = asNonEmptyString(record.content) ?? asNonEmptyString(record.markdown);
  if (!content) return null;
  return {
    specId: asNonEmptyString(record.id) ?? `${type.toLowerCase()}-generated`,
    type,
    title: asNonEmptyString(record.title) ?? type,
    content,
    status: asNonEmptyString(record.status),
    sourceUrl: asNonEmptyString(record.sourceUrl) ?? asNonEmptyString(record.url),
    updatedAt: asNonEmptyString(record.updatedAt),
    metadata: record,
  };
}

function normalizeBacklogItem(value: unknown): BrabrixBacklogItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const itemId = asNonEmptyString(record.itemId) ?? asNonEmptyString(record.id);
  const projectId = asNonEmptyString(record.projectId);
  const title = asNonEmptyString(record.title);
  if (!itemId || !projectId || !title) return null;

  const acceptanceCriteriaRaw = record.acceptanceCriteria;
  const acceptanceCriteria = Array.isArray(acceptanceCriteriaRaw)
    ? asStringArray(acceptanceCriteriaRaw)
    : asNonEmptyString(acceptanceCriteriaRaw)
      ? [asNonEmptyString(acceptanceCriteriaRaw)!]
      : [];

  const estimatedHoursRaw = typeof record.estimatedHours === "number" ? record.estimatedHours : null;

  return {
    itemId,
    projectId,
    parentId: asNonEmptyString(record.parentId),
    type: asNonEmptyString(record.type) ?? "TASK",
    title,
    description: asNonEmptyString(record.description),
    status: asNonEmptyString(record.status),
    priority: asNonEmptyString(record.priority),
    acceptanceCriteria,
    estimatedHours: estimatedHoursRaw,
    updatedAt: asNonEmptyString(record.updatedAt),
    metadata: record,
  };
}

function normalizeBacklogList(payload: unknown): BrabrixBacklogItem[] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeBacklogItem).filter((entry): entry is BrabrixBacklogItem => entry !== null);
  }
  const record = asRecord(payload);
  if (!record) return [];
  const dataRecord = asRecord(record.data);
  const items: unknown[] = Array.isArray(record.items)
    ? record.items
    : Array.isArray(dataRecord?.items)
      ? dataRecord.items as unknown[]
      : [];
  return items.map(normalizeBacklogItem).filter((entry): entry is BrabrixBacklogItem => entry !== null);
}

function normalizeSkillReference(value: unknown): BrabrixSkillReference | null {
  const record = asRecord(value);
  if (!record) return null;
  const name = asNonEmptyString(record.name) ?? asNonEmptyString(record.title) ?? asNonEmptyString(record.key);
  if (!name) return null;
  return {
    skillId: asNonEmptyString(record.skillId) ?? asNonEmptyString(record.id),
    key: asNonEmptyString(record.key),
    name,
    description: asNonEmptyString(record.description),
    category: asNonEmptyString(record.category),
    tags: asStringArray(record.tags),
    provider: asNonEmptyString(record.provider) ?? "brabrix",
    sourceUrl: asNonEmptyString(record.sourceUrl) ?? asNonEmptyString(record.url),
    markdown: asNonEmptyString(record.content) ?? asNonEmptyString(record.markdown),
    prompts: asNonEmptyString(record.prompts),
    rules: asNonEmptyString(record.rules),
    workflows: asNonEmptyString(record.workflows),
    architecturePatterns: asNonEmptyString(record.architecturePatterns),
    conventions: asNonEmptyString(record.conventions),
    agentContexts: asNonEmptyString(record.agentContexts),
    metadata: record,
  };
}

function normalizeSkillReferences(payload: unknown): BrabrixSkillReference[] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeSkillReference).filter((entry): entry is BrabrixSkillReference => entry !== null);
  }
  const record = asRecord(payload);
  if (!record) return [];

  const skills = Array.isArray(record.skills) ? record.skills : [];
  const rules = Array.isArray(record.rules) ? record.rules : [];
  const flat = skills.length > 0 || rules.length > 0
    ? [...skills, ...rules]
    : Array.isArray(record.items)
      ? record.items
      : [];
  return flat.map(normalizeSkillReference).filter((entry): entry is BrabrixSkillReference => entry !== null);
}

function extractFeaturesFromBacklog(backlogItems: BrabrixBacklogItem[]): BrabrixFeature[] {
  return backlogItems
    .filter((item) => item.type.toUpperCase() === "EPIC" || item.type.toUpperCase() === "FEATURE")
    .map((item) => ({
      featureId: item.itemId,
      projectId: item.projectId,
      title: item.title,
      description: item.description ?? null,
      status: item.status ?? null,
      priority: item.priority ?? null,
      epicId: item.parentId ?? null,
      metadata: item.metadata,
    }));
}

function parseIsoTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function computeOutOfSync(lastSyncedAt: string | null): boolean {
  const syncedMs = parseIsoTimestamp(lastSyncedAt);
  if (syncedMs === null) return true;
  return (Date.now() - syncedMs) > BRABRIX_SYNC_STALE_MS;
}

function buildBrabrixMetadata(input: {
  projectId: string;
  sourceUrl: string | null;
  importedAt: string;
  lastSyncedAt: string;
  entityType: BrabrixImportMetadata["brabrixEntityType"];
}): BrabrixImportMetadata {
  return {
    brabrixProjectId: input.projectId,
    brabrixImportedAt: input.importedAt,
    brabrixLastSyncedAt: input.lastSyncedAt,
    brabrixSourceUrl: input.sourceUrl,
    brabrixEntityType: input.entityType,
  };
}

function mergeWorkspaceMetadata(input: {
  existing: Record<string, unknown> | null | undefined;
  value: Record<string, unknown>;
}): Record<string, unknown> {
  const existing = asRecord(input.existing) ?? {};
  return {
    ...existing,
    [BRABRIX_WORKSPACE_METADATA_KEY]: {
      ...(asRecord(existing[BRABRIX_WORKSPACE_METADATA_KEY]) ?? {}),
      ...input.value,
    },
  };
}

function readBrabrixWorkspaceMeta(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const root = asRecord(metadata);
  if (!root) return null;
  return asRecord(root[BRABRIX_WORKSPACE_METADATA_KEY]);
}

type RequestInput = {
  action: string;
  method?: "GET" | "POST";
  endpointTemplate: string;
  pathParams?: Record<string, string | null | undefined>;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  skipTenantHeader?: boolean;
};

export class BrabrixProjectImporterHttpError extends Error {
  constructor(
    message: string,
    readonly details: {
      action: string;
      method: "GET" | "POST";
      status?: number;
      url: string;
      responseBody?: string;
      retryable: boolean;
      attempt: number;
      maxAttempts: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "BrabrixProjectImporterHttpError";
  }
}

export function createBrabrixProjectImporter(input: {
  db: Db;
  companyId: string;
  config: BrabrixConfig;
  fetcher?: typeof fetch;
  endpoints?: BrabrixImporterEndpoints;
}) {
  const fetcher = input.fetcher ?? fetch;
  const endpoints = input.endpoints ?? defaultImporterEndpointsFromEnv();
  const log = logger.child({ service: "brabrix-project-importer", companyId: input.companyId });
  const projects = projectService(input.db);
  const goals = goalService(input.db);
  const issues = issueService(input.db);
  const skills = companySkillService(input.db);
  let resolvedTenantIdFromMemberships: string | null | undefined;

  async function resolveTenantIdForTenantScopedRequest(args: {
    action: string;
    method: "GET" | "POST";
    url: string;
  }): Promise<string | null> {
    const configuredTenantId = asNonEmptyString(input.config.tenantId);
    if (configuredTenantId) {
      if (isUuid(configuredTenantId)) {
        return configuredTenantId;
      }
      log.warn({
        action: args.action,
        method: args.method,
        url: args.url,
        tenantIdLength: configuredTenantId.length,
      }, "brabrix tenant id is not a UUID; trying auto-resolution from memberships");
    }

    if (resolvedTenantIdFromMemberships !== undefined) {
      return resolvedTenantIdFromMemberships;
    }

    try {
      const membershipsPayload = await request<unknown>({
        action: "listMemberships",
        endpointTemplate: endpoints.memberships,
        query: { size: 100 },
        skipTenantHeader: true,
      });
      const memberships = normalizeMembershipList(membershipsPayload)
        .filter((entry) => isUuid(entry.tenantId));

      if (memberships.length === 0) {
        log.warn({
          action: args.action,
          method: args.method,
          url: args.url,
        }, "brabrix tenant auto-resolution did not find any valid tenant UUID in memberships");
        resolvedTenantIdFromMemberships = null;
        return null;
      }

      const selected = memberships.find((entry) => entry.isPreferred) ?? memberships[0];
      resolvedTenantIdFromMemberships = selected.tenantId;

      if (memberships.length > 1) {
        log.warn({
          action: args.action,
          method: args.method,
          url: args.url,
          membershipsCount: memberships.length,
          selectedTenantId: selected.tenantId,
          selectedTenantName: selected.tenantName,
        }, "brabrix tenant auto-resolution selected one tenant from multiple memberships");
      } else {
        log.info({
          action: args.action,
          method: args.method,
          url: args.url,
          selectedTenantId: selected.tenantId,
          selectedTenantName: selected.tenantName,
        }, "brabrix tenant auto-resolution selected tenant from single membership");
      }
      return selected.tenantId;
    } catch (error) {
      log.warn({
        action: args.action,
        method: args.method,
        url: args.url,
        error: error instanceof Error ? error.message : String(error),
      }, "brabrix tenant auto-resolution failed; continuing without x-tenant-id");
      resolvedTenantIdFromMemberships = null;
      return null;
    }
  }

  async function request<T>(requestInput: RequestInput): Promise<T> {
    const tokenRaw = asNonEmptyString(input.config.agentToken);
    if (!tokenRaw) {
      throw new Error("Brabrix API token is not configured for this company.");
    }

    const token = normalizeAuthToken(tokenRaw);
    const urlWithoutQuery = toAbsoluteUrl(
      input.config.apiUrl,
      requestInput.endpointTemplate,
      requestInput.pathParams ?? {},
    );
    const url = requestInput.query ? withQueryString(urlWithoutQuery, requestInput.query) : urlWithoutQuery;
    const maxAttempts = Math.max(1, input.config.maxRetries + 1);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), input.config.timeoutMs);
      try {
        const headers: Record<string, string> = {
          accept: "application/json",
        };
        if (requestInput.body !== undefined) {
          headers["content-type"] = "application/json";
        }
        if (isApiKeyToken(token)) {
          headers["x-api-key"] = token;
        } else {
          headers.authorization = `Bearer ${token}`;
        }
        if (input.config.provider) {
          headers["x-brabrix-provider"] = input.config.provider;
        }
        if (input.config.agentId) {
          headers["x-brabrix-agent-id"] = input.config.agentId;
        }
        if (shouldAttachTenantHeader(url) && !requestInput.skipTenantHeader) {
          const tenantId = await resolveTenantIdForTenantScopedRequest({
            action: requestInput.action,
            method: requestInput.method ?? "GET",
            url,
          });
          if (tenantId) {
            headers["x-tenant-id"] = tenantId;
          }
        }

        const response = await fetcher(url, {
          method: requestInput.method ?? "GET",
          headers,
          body: requestInput.body !== undefined ? JSON.stringify(requestInput.body) : undefined,
          signal: controller.signal,
        });
        if (!response.ok) {
          const responseBody = truncateForLog(await response.text().catch(() => ""));
          const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
          const shouldRetry = retryable && attempt < maxAttempts;
          log.warn({
            action: requestInput.action,
            method: requestInput.method ?? "GET",
            url,
            status: response.status,
            attempt,
            maxAttempts,
            retrying: shouldRetry,
            durationMs: Date.now() - startedAt,
            responseBody,
          }, "brabrix project importer request failed");
          if (shouldRetry) {
            await new Promise((resolve) => setTimeout(resolve, input.config.retryDelayMs * attempt));
            continue;
          }
          throw new BrabrixProjectImporterHttpError(
            `Brabrix importer ${requestInput.action} failed (${response.status}).`,
            {
              action: requestInput.action,
              method: requestInput.method ?? "GET",
              status: response.status,
              url,
              responseBody,
              retryable,
              attempt,
              maxAttempts,
            },
          );
        }

        if (response.status === 204) {
          return null as T;
        }
        const body = await response.text();
        if (!body.trim()) return null as T;
        return JSON.parse(body) as T;
      } catch (error) {
        if (error instanceof BrabrixProjectImporterHttpError) {
          throw error;
        }

        const retryable = attempt < maxAttempts;
        log.warn({
          action: requestInput.action,
          method: requestInput.method ?? "GET",
          url,
          attempt,
          maxAttempts,
          retrying: retryable,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }, "brabrix project importer request errored");

        if (retryable) {
          await new Promise((resolve) => setTimeout(resolve, input.config.retryDelayMs * attempt));
          continue;
        }
        throw new BrabrixProjectImporterHttpError(
          `Brabrix importer ${requestInput.action} failed before response.`,
          {
            action: requestInput.action,
            method: requestInput.method ?? "GET",
            status: undefined,
            url,
            retryable: false,
            attempt,
            maxAttempts,
            cause: error,
          },
        );
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    throw new Error(`Brabrix importer ${requestInput.action} exhausted retries.`);
  }

  async function requestOptional<T>(requestInput: RequestInput): Promise<T | null> {
    return requestOptionalWithPolicy<T>(requestInput);
  }

  async function requestOptionalWithPolicy<T>(
    requestInput: RequestInput,
    options?: {
      toleratedStatuses?: number[];
      tolerate5xx?: boolean;
      warningLabel?: string;
      warnings?: string[];
    },
  ): Promise<T | null> {
    try {
      return await request<T>(requestInput);
    } catch (error) {
      if (error instanceof BrabrixProjectImporterHttpError) {
        const status = error.details.status ?? null;
        const toleratedStatuses = new Set<number>([404, ...(options?.toleratedStatuses ?? [])]);
        const toleratedByStatus = typeof status === "number" && toleratedStatuses.has(status);
        const toleratedBy5xx = Boolean(options?.tolerate5xx) && typeof status === "number" && status >= 500;
        if (!toleratedByStatus && !toleratedBy5xx) {
          throw error;
        }
        const requestId = extractRequestIdFromResponseBody(error.details.responseBody);
        log.warn({
          action: requestInput.action,
          method: requestInput.method ?? "GET",
          status,
          requestId,
        }, "brabrix optional endpoint failed; continuing without this section");
        if (options?.warnings) {
          const label = options.warningLabel ?? requestInput.action;
          options.warnings.push(
            requestId
              ? `${label} unavailable (${status ?? "unknown"}) [requestId: ${requestId}].`
              : `${label} unavailable (${status ?? "unknown"}).`,
          );
        }
        return null;
      }
      throw error;
    }
  }

  async function listProjects(): Promise<BrabrixProject[]> {
    const payload = await request<unknown>({
      action: "listProjects",
      endpointTemplate: endpoints.listProjects,
      query: { size: 100 },
    });
    const projectsList = normalizeProjectList(payload);
    log.info({ count: projectsList.length }, "brabrix projects listed");
    return projectsList;
  }

  async function getProjectBundle(projectId: string): Promise<BrabrixProjectBundle> {
    const bundleWarnings: string[] = [];
    const [projectPayload, contextExportPayload, backlogPayload, prdPayload, techSpecPayload, techArchPayload] = await Promise.all([
      requestOptionalWithPolicy<unknown>({
        action: "getProjectDetail",
        endpointTemplate: endpoints.projectDetail,
        pathParams: { projectId },
      }, {
        tolerate5xx: true,
        warningLabel: "Project detail",
        warnings: bundleWarnings,
      }),
      requestOptionalWithPolicy<unknown>({
        action: "getProjectContextExport",
        endpointTemplate: endpoints.projectContextExport,
        pathParams: { projectId },
      }, {
        tolerate5xx: true,
        warningLabel: "Project context export",
        warnings: bundleWarnings,
      }),
      requestOptionalWithPolicy<unknown>({
        action: "getProjectBacklog",
        endpointTemplate: endpoints.projectBacklog,
        pathParams: { projectId },
      }, {
        tolerate5xx: true,
        warningLabel: "Project backlog",
        warnings: bundleWarnings,
      }),
      requestOptionalWithPolicy<unknown>({
        action: "getWorkflowPrd",
        endpointTemplate: endpoints.projectWorkflow,
        pathParams: { projectId },
        query: { type: "PRD" },
      }, {
        tolerate5xx: true,
        warningLabel: "Workflow PRD",
        warnings: bundleWarnings,
      }),
      requestOptionalWithPolicy<unknown>({
        action: "getWorkflowTechSpec",
        endpointTemplate: endpoints.projectWorkflow,
        pathParams: { projectId },
        query: { type: "TECH_SPEC" },
      }, {
        tolerate5xx: true,
        warningLabel: "Workflow technical spec",
        warnings: bundleWarnings,
      }),
      requestOptionalWithPolicy<unknown>({
        action: "getWorkflowTechArch",
        endpointTemplate: endpoints.projectWorkflow,
        pathParams: { projectId },
        query: { type: "TECHNICAL_ARCHITECTURE" },
      }, {
        tolerate5xx: true,
        warningLabel: "Workflow technical architecture",
        warnings: bundleWarnings,
      }),
    ]);

    const project = normalizeBrabrixProject(projectPayload)
      ?? {
        projectId,
        name: `Brabrix Project ${projectId.slice(0, 8)}`,
        description: null,
      };
    const contextExportRecord = asRecord(contextExportPayload);
    const projectContext = normalizeProjectContextFromExport(project.projectId, project.name, contextExportPayload);
    const prdFromWorkflow = normalizeBrabrixPrd(prdPayload);
    const prdFromExportMarkdown = asNonEmptyString(contextExportRecord?.prdMd)
      ? {
        title: "PRD",
        content: asNonEmptyString(contextExportRecord?.prdMd)!,
        status: null,
        sourceUrl: null,
      } satisfies BrabrixPrd
      : null;
    const prd = prdFromWorkflow ?? prdFromExportMarkdown;

    const techSpecWorkflow = normalizeBrabrixSpec(techSpecPayload, "TECH_SPEC");
    const techArchWorkflow = normalizeBrabrixSpec(techArchPayload, "TECHNICAL_ARCHITECTURE");
    const techSpecFromExport = asNonEmptyString(contextExportRecord?.technicalSpecMd)
      ? {
        specId: "technical-spec-export",
        type: "TECH_SPEC",
        title: "Technical Spec",
        content: asNonEmptyString(contextExportRecord?.technicalSpecMd)!,
        status: null,
        sourceUrl: null,
      } satisfies BrabrixSpec
      : null;

    const technicalSpecs = [techSpecWorkflow, techArchWorkflow, techSpecFromExport]
      .filter((entry): entry is BrabrixSpec => entry !== null);
    const backlogItems = normalizeBacklogList(backlogPayload);
    const features = extractFeaturesFromBacklog(backlogItems);

    const skillsPayload = await requestOptionalWithPolicy<unknown>({
      action: "getProjectSkillsExport",
      endpointTemplate: endpoints.projectSkillsExport,
      pathParams: { projectId },
    }, {
      tolerate5xx: true,
      warningLabel: "Project skills export",
      warnings: bundleWarnings,
    }) ?? await requestOptionalWithPolicy<unknown>({
        action: "getProjectSkills",
        endpointTemplate: endpoints.projectSkills,
        pathParams: { projectId },
      }, {
        tolerate5xx: true,
        warningLabel: "Project skills",
        warnings: bundleWarnings,
      });
    const linkedSkills = normalizeSkillReferences(skillsPayload);

    log.info({
      projectId: project.projectId,
      backlogCount: backlogItems.length,
      featureCount: features.length,
      technicalSpecCount: technicalSpecs.length,
      linkedSkillCount: linkedSkills.length,
      hasPrd: Boolean(prd),
      warnings: bundleWarnings.length,
    }, "brabrix project bundle loaded");

    return {
      project,
      projectContext,
      prd,
      technicalSpecs,
      backlogItems,
      features,
      linkedSkills,
      warnings: bundleWarnings,
      raw: {
        projectPayload: asRecord(projectPayload),
        contextExportPayload: contextExportRecord,
      },
    };
  }

  async function findLocalProjectByBrabrixProjectId(brabrixProjectId: string) {
    const localProjects = await projects.list(input.companyId);
    return localProjects.find((project) =>
      project.workspaces.some((workspace) => {
        const meta = readBrabrixWorkspaceMeta(workspace.metadata);
        return asNonEmptyString(meta?.brabrixProjectId) === brabrixProjectId;
      })) ?? null;
  }

  async function ensureLocalProjectFromBundle(bundle: BrabrixProjectBundle, nowIso: string) {
    const existing = await findLocalProjectByBrabrixProjectId(bundle.project.projectId);
    if (existing) {
      return { project: existing, created: false };
    }

    const mappedProject = mapBrabrixProjectToProjectInput({
      project: bundle.project,
      fallbackDescription: bundle.projectContext?.description ?? null,
    });
    const created = await projects.create(input.companyId, {
      name: mappedProject.name,
      description: mappedProject.description,
      status: mappedProject.status,
      color: null,
      goalIds: [],
    });
    const localCwd = resolveManagedProjectWorkspaceDir({
      companyId: input.companyId,
      projectId: created.id,
      repoName: bundle.project.name,
    });
    await fs.mkdir(localCwd, { recursive: true });

    const metadata = mergeWorkspaceMetadata({
      existing: null,
      value: {
        ...buildBrabrixMetadata({
          projectId: bundle.project.projectId,
          sourceUrl: bundle.project.sourceUrl ?? null,
          importedAt: nowIso,
          lastSyncedAt: nowIso,
          entityType: "project",
        }),
        syncStatus: "synced",
      },
    });

    await projects.createWorkspace(created.id, {
      name: `${bundle.project.name} Workspace`,
      sourceType: "local_path",
      cwd: localCwd,
      isPrimary: true,
      metadata,
    });

    const hydrated = await projects.getById(created.id);
    if (!hydrated) {
      throw new Error("Failed to hydrate imported project.");
    }
    return { project: hydrated, created: true };
  }

  async function upsertFeatureGoals(args: {
    localProjectId: string;
    features: BrabrixFeature[];
    workspaceMetadata: Record<string, unknown> | null | undefined;
  }) {
    const workspaceMeta = readBrabrixWorkspaceMeta(args.workspaceMetadata) ?? {};
    const featureGoalMapRaw = asRecord(workspaceMeta.featureGoalMap) ?? {};
    const featureGoalMap: Record<string, string> = {};
    for (const [featureId, goalId] of Object.entries(featureGoalMapRaw)) {
      const normalizedGoalId = asNonEmptyString(goalId);
      if (normalizedGoalId) featureGoalMap[featureId] = normalizedGoalId;
    }

    const allGoals = await goals.list(input.companyId);
    let upserted = 0;
    const importedGoalIds: string[] = [];

    for (const feature of args.features) {
      const mapped = mapBrabrixFeatureToGoal({ feature });
      const mappedGoalId = featureGoalMap[feature.featureId] ?? null;
      const existingGoal = mappedGoalId
        ? allGoals.find((goal) => goal.id === mappedGoalId) ?? null
        : null;
      if (existingGoal) {
        const updated = await goals.update(existingGoal.id, {
          title: mapped.title,
          description: mapped.description,
          status: mapped.status,
          level: mapped.level,
        });
        if (updated) {
          importedGoalIds.push(updated.id);
          featureGoalMap[feature.featureId] = updated.id;
          upserted += 1;
          continue;
        }
      }

      const created = await goals.create(input.companyId, {
        title: mapped.title,
        description: mapped.description,
        status: mapped.status,
        level: mapped.level,
      });
      importedGoalIds.push(created.id);
      featureGoalMap[feature.featureId] = created.id;
      upserted += 1;
    }

    return {
      featureGoalMap,
      importedGoalIds,
      goalsUpserted: upserted,
    };
  }

  async function upsertBacklogIssues(args: {
    localProjectId: string;
    featureGoalMap: Record<string, string>;
    backlogItems: BrabrixBacklogItem[];
  }) {
    const backlog = args.backlogItems.filter((item) => {
      const type = item.type.toUpperCase();
      return type !== "EPIC" && type !== "FEATURE";
    });
    const existing = await issues.list(input.companyId, {
      projectId: args.localProjectId,
      originKind: BRABRIX_BACKLOG_ISSUE_ORIGIN_KIND,
      includeRoutineExecutions: true,
      limit: 1000,
    });
    const byOriginId = new Map(
      existing
        .filter((issue) => issue.originId)
        .map((issue) => [issue.originId as string, issue]),
    );

    const backlogIssueMap: Record<string, string> = {};
    let upserted = 0;

    for (const item of backlog) {
      const mapped = mapBrabrixBacklogItemToIssue({ backlogItem: item });
      const goalId = args.featureGoalMap[item.parentId ?? ""] ?? args.featureGoalMap[item.itemId] ?? null;
      const existingIssue = byOriginId.get(item.itemId) ?? null;
      if (existingIssue) {
        const updated = await issues.update(existingIssue.id, {
          title: mapped.title,
          description: mapped.description,
          status: mapped.status,
          priority: mapped.priority,
          goalId,
        });
        if (updated) {
          backlogIssueMap[item.itemId] = updated.id;
          upserted += 1;
        }
        continue;
      }

      const created = await issues.create(input.companyId, {
        projectId: args.localProjectId,
        goalId,
        title: mapped.title,
        description: mapped.description,
        status: mapped.status,
        priority: mapped.priority,
        originKind: BRABRIX_BACKLOG_ISSUE_ORIGIN_KIND,
        originId: item.itemId,
        originFingerprint: `brabrix:${item.projectId}:${item.itemId}`,
      });
      backlogIssueMap[item.itemId] = created.id;
      upserted += 1;
    }

    for (const item of backlog) {
      if (!item.parentId) continue;
      const issueId = backlogIssueMap[item.itemId];
      const parentIssueId = backlogIssueMap[item.parentId];
      if (!issueId || !parentIssueId || issueId === parentIssueId) continue;
      await issues.update(issueId, { parentId: parentIssueId });
    }

    return {
      backlogIssueMap,
      issuesUpserted: upserted,
    };
  }

  async function importLinkedSkills(args: {
    brabrixProjectId: string;
    linkedSkills: BrabrixSkillReference[];
  }) {
    let imported = 0;
    const warnings: string[] = [];

    for (const skillRef of args.linkedSkills) {
      const mapped = mapBrabrixSkillReferenceToSkill({
        projectId: args.brabrixProjectId,
        skill: skillRef,
      });
      try {
        if (skillRef.skillId) {
          const result = await skills.importFromProvider(input.companyId, {
            provider: "brabrix_skillhub",
            skillId: skillRef.skillId,
          });
          imported += result.imported.length;
          continue;
        }

        if (mapped.sourceUrl) {
          const result = await skills.importFromSource(input.companyId, mapped.sourceUrl);
          imported += result.imported.length;
          continue;
        }

        if (mapped.markdown) {
          await skills.createLocalSkill(input.companyId, {
            name: mapped.name,
            slug: mapped.slug,
            description: mapped.description,
            markdown: mapped.markdown,
          });
          imported += 1;
          continue;
        }

        warnings.push(`Skill "${mapped.name}" was skipped because no skillId/source/content was provided.`);
      } catch (error) {
        warnings.push(
          `Skill "${mapped.name}" failed to import: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      skillsImported: imported,
      warnings,
    };
  }

  async function persistWorkspaceBrabrixMetadata(args: {
    localProjectId: string;
    importedAt: string;
    lastSyncedAt: string;
    bundle: BrabrixProjectBundle;
    featureGoalMap: Record<string, string>;
    backlogIssueMap: Record<string, string>;
  }) {
    const project = await projects.getById(args.localProjectId);
    if (!project) throw new Error("Project not found during metadata persistence.");
    const workspace = project.primaryWorkspace ?? project.workspaces[0] ?? null;
    if (!workspace) throw new Error("Project workspace not found during metadata persistence.");

    const mappedContext = mapBrabrixPrdToProjectContext({
      projectId: args.bundle.project.projectId,
      projectName: args.bundle.project.name,
      prd: args.bundle.prd,
      projectContext: args.bundle.projectContext,
    });
    const technicalContext = mapBrabrixSpecToTechnicalContext({ specs: args.bundle.technicalSpecs });

    const metadata = mergeWorkspaceMetadata({
      existing: workspace.metadata,
      value: {
        ...buildBrabrixMetadata({
          projectId: args.bundle.project.projectId,
          sourceUrl: args.bundle.project.sourceUrl ?? null,
          importedAt: args.importedAt,
          lastSyncedAt: args.lastSyncedAt,
          entityType: "project",
        }),
        syncStatus: "synced",
        featureGoalMap: args.featureGoalMap,
        backlogIssueMap: args.backlogIssueMap,
        projectSnapshot: {
          id: args.bundle.project.projectId,
          name: args.bundle.project.name,
          status: args.bundle.project.status ?? null,
          updatedAt: args.bundle.project.updatedAt ?? null,
        },
        projectContext: mappedContext,
        prd: args.bundle.prd,
        technicalSpecs: args.bundle.technicalSpecs,
        technicalContext,
        linkedSkills: args.bundle.linkedSkills,
      },
    });

    await projects.updateWorkspace(args.localProjectId, workspace.id, { metadata });
    return workspace.id;
  }

  async function attachImportedGoalsToProject(args: {
    localProjectId: string;
    importedGoalIds: string[];
  }) {
    const project = await projects.getById(args.localProjectId);
    if (!project) return;
    const mergedGoalIds = Array.from(new Set([...project.goalIds, ...args.importedGoalIds]));
    await projects.update(args.localProjectId, { goalIds: mergedGoalIds });
  }

  async function upsertProject(args: {
    mode: "import" | "sync";
    projectId: string;
  }): Promise<BrabrixProjectImportResult> {
    const nowIso = new Date().toISOString();
    const bundle = await getProjectBundle(args.projectId);
    const local = await ensureLocalProjectFromBundle(bundle, nowIso);
    const projectInput = mapBrabrixProjectToProjectInput({
      project: bundle.project,
      fallbackDescription: bundle.projectContext?.description ?? null,
    });
    await projects.update(local.project.id, {
      name: projectInput.name,
      description: projectInput.description,
      status: projectInput.status,
    });

    const workspace = local.project.primaryWorkspace ?? local.project.workspaces[0] ?? null;
    const featureGoals = await upsertFeatureGoals({
      localProjectId: local.project.id,
      features: bundle.features,
      workspaceMetadata: workspace?.metadata,
    });
    await attachImportedGoalsToProject({
      localProjectId: local.project.id,
      importedGoalIds: featureGoals.importedGoalIds,
    });

    const backlogIssues = await upsertBacklogIssues({
      localProjectId: local.project.id,
      featureGoalMap: featureGoals.featureGoalMap,
      backlogItems: bundle.backlogItems,
    });
    const skillsImport = await importLinkedSkills({
      brabrixProjectId: bundle.project.projectId,
      linkedSkills: bundle.linkedSkills,
    });
    const importWarnings = [...(bundle.warnings ?? []), ...skillsImport.warnings];

    const workspaceId = await persistWorkspaceBrabrixMetadata({
      localProjectId: local.project.id,
      importedAt: local.created ? nowIso : asNonEmptyString(readBrabrixWorkspaceMeta(workspace?.metadata)?.brabrixImportedAt) ?? nowIso,
      lastSyncedAt: nowIso,
      bundle,
      featureGoalMap: featureGoals.featureGoalMap,
      backlogIssueMap: backlogIssues.backlogIssueMap,
    });

    log.info({
      mode: args.mode,
      brabrixProjectId: bundle.project.projectId,
      localProjectId: local.project.id,
      workspaceId,
      goalsUpserted: featureGoals.goalsUpserted,
      issuesUpserted: backlogIssues.issuesUpserted,
      skillsImported: skillsImport.skillsImported,
      specsImported: bundle.technicalSpecs.length,
      prdImported: Boolean(bundle.prd),
      warnings: importWarnings.length,
    }, "brabrix project synchronized");

    return {
      mode: args.mode,
      brabrixProjectId: bundle.project.projectId,
      localProjectId: local.project.id,
      localWorkspaceId: workspaceId,
      projectName: bundle.project.name,
      importedAt: local.created ? nowIso : asNonEmptyString(readBrabrixWorkspaceMeta(workspace?.metadata)?.brabrixImportedAt) ?? nowIso,
      lastSyncedAt: nowIso,
      counts: {
        goalsUpserted: featureGoals.goalsUpserted,
        issuesUpserted: backlogIssues.issuesUpserted,
        skillsImported: skillsImport.skillsImported,
        prdImported: Boolean(bundle.prd),
        specsImported: bundle.technicalSpecs.length,
      },
      warnings: importWarnings,
    };
  }

  async function importProject(projectId: string) {
    return upsertProject({ mode: "import", projectId });
  }

  async function syncProject(projectId: string) {
    return upsertProject({ mode: "sync", projectId });
  }

  async function listImportedProjects(): Promise<BrabrixImportedProjectSummary[]> {
    const localProjects = await projects.list(input.companyId);
    const summaries: BrabrixImportedProjectSummary[] = [];
    for (const project of localProjects) {
      for (const workspace of project.workspaces) {
        const meta = readBrabrixWorkspaceMeta(workspace.metadata);
        const brabrixProjectId = asNonEmptyString(meta?.brabrixProjectId);
        if (!brabrixProjectId) continue;
        const importedAt = asNonEmptyString(meta?.brabrixImportedAt);
        const lastSyncedAt = asNonEmptyString(meta?.brabrixLastSyncedAt);
        const outOfSync = computeOutOfSync(lastSyncedAt);
        summaries.push({
          brabrixProjectId,
          localProjectId: project.id,
          localProjectName: project.name,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          brabrixImportedAt: importedAt,
          brabrixLastSyncedAt: lastSyncedAt,
          brabrixSourceUrl: asNonEmptyString(meta?.brabrixSourceUrl),
          badges: {
            imported: true,
            synced: Boolean(lastSyncedAt),
            outOfSync,
          },
        });
      }
    }
    return summaries;
  }

  async function disconnectProject(projectId: string): Promise<{ disconnected: boolean; localProjectId: string | null }> {
    const project = await findLocalProjectByBrabrixProjectId(projectId);
    if (!project) {
      return { disconnected: false, localProjectId: null };
    }
    const workspace = project.primaryWorkspace ?? project.workspaces[0] ?? null;
    if (!workspace) {
      return { disconnected: false, localProjectId: project.id };
    }

    const existing = asRecord(workspace.metadata) ?? {};
    const brabrixMeta = readBrabrixWorkspaceMeta(workspace.metadata) ?? {};
    const nextBrabrixMeta = {
      ...brabrixMeta,
      disconnectedAt: new Date().toISOString(),
      disconnectedProjectId: projectId,
    };
    delete (nextBrabrixMeta as Record<string, unknown>).brabrixProjectId;
    delete (nextBrabrixMeta as Record<string, unknown>).featureGoalMap;
    delete (nextBrabrixMeta as Record<string, unknown>).backlogIssueMap;

    await projects.updateWorkspace(project.id, workspace.id, {
      metadata: {
        ...existing,
        [BRABRIX_WORKSPACE_METADATA_KEY]: nextBrabrixMeta,
      },
    });

    log.info({ projectId: project.id, workspaceId: workspace.id, brabrixProjectId: projectId }, "brabrix project disconnected");
    return { disconnected: true, localProjectId: project.id };
  }

  async function testConnection(): Promise<BrabrixConnectionCheckResult> {
    try {
      const projectsList = await listProjects();
      return {
        ok: true,
        message: "Brabrix connection is healthy.",
        projectCount: projectsList.length,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Brabrix connection failed.",
        projectCount: null,
      };
    }
  }

  return {
    testConnection,
    listProjects,
    getProjectBundle,
    importProject,
    syncProject,
    listImportedProjects,
    disconnectProject,
  };
}
