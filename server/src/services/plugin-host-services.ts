import type { Db } from "@paperclipai/db";
import type {
  HostServices,
  Company,
  Agent,
  Project,
  Issue,
  Goal,
  PluginWorkspace,
  IssueComment,
} from "@paperclipai/plugin-sdk";
import { companyService } from "./companies.js";
import { agentService } from "./agents.js";
import { projectService } from "./projects.js";
import { issueService } from "./issues.js";
import { goalService } from "./goals.js";
import { activityService } from "./activity.js";
import { costService } from "./costs.js";
import { assetService } from "./assets.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { pluginStateStore } from "./plugin-state-store.js";
import { createPluginSecretsHandler } from "./plugin-secrets-handler.js";
import { logActivity } from "./activity-log.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { logger } from "../middleware/logger.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATH_LIKE_PATTERN = /[\\/]/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

function looksLikePath(value: string): boolean {
  const normalized = value.trim();
  return (
    PATH_LIKE_PATTERN.test(normalized)
    || WINDOWS_DRIVE_PATH_PATTERN.test(normalized)
  ) && !UUID_PATTERN.test(normalized);
}

function sanitizeWorkspaceText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || UUID_PATTERN.test(trimmed)) return "";
  return trimmed;
}

function sanitizeWorkspacePath(cwd: string | null): string {
  if (!cwd) return "";
  return looksLikePath(cwd) ? cwd.trim() : "";
}

function sanitizeWorkspaceName(name: string, fallbackPath: string): string {
  const safeName = sanitizeWorkspaceText(name);
  if (safeName && !looksLikePath(safeName)) {
    return safeName;
  }
  const normalized = fallbackPath.trim().replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "Workspace";
}

/**
 * buildHostServices — creates a concrete implementation of the `HostServices`
 * interface for a specific plugin.
 *
 * This implementation delegates to the core Paperclip domain services,
 * providing the bridge between the plugin worker's SDK and the host platform.
 *
 * @param db - Database connection instance.
 * @param pluginId - The UUID of the plugin installation record.
 * @param pluginKey - The unique identifier from the plugin manifest (e.g., "acme.linear").
 * @param eventBus - The system-wide event bus for publishing plugin events.
 * @returns An object implementing the HostServices interface for the plugin SDK.
 */
export function buildHostServices(
  db: Db,
  pluginId: string,
  pluginKey: string,
  eventBus: PluginEventBus,
): HostServices {
  const registry = pluginRegistryService(db);
  const stateStore = pluginStateStore(db);
  const secretsHandler = createPluginSecretsHandler({ db, pluginId });
  const companies = companyService(db);
  const agents = agentService(db);
  const projects = projectService(db);
  const issues = issueService(db);
  const goals = goalService(db);
  const activity = activityService(db);
  const costs = costService(db);
  const assets = assetService(db);
  const scopedBus = eventBus.forPlugin(pluginKey);

  const ensureCompanyId = (companyId?: string) => {
    if (!companyId) throw new Error("companyId is required for this operation");
    return companyId;
  };

  const inCompany = <T extends { companyId: string | null | undefined }>(
    record: T | null | undefined,
    companyId: string,
  ): record is T => Boolean(record && record.companyId === companyId);

  const requireInCompany = <T extends { companyId: string | null | undefined }>(
    entityName: string,
    record: T | null | undefined,
    companyId: string,
  ): T => {
    if (!inCompany(record, companyId)) {
      throw new Error(`${entityName} not found`);
    }
    return record;
  };

  return {
    config: {
      async get() {
        const configRow = await registry.getConfig(pluginId);
        return configRow?.configJson ?? {};
      },
    },

    state: {
      async get(params) {
        return stateStore.get(pluginId, params.scopeKind as any, params.stateKey, {
          scopeId: params.scopeId,
          namespace: params.namespace,
        });
      },
      async set(params) {
        await stateStore.set(pluginId, {
          scopeKind: params.scopeKind as any,
          scopeId: params.scopeId,
          namespace: params.namespace,
          stateKey: params.stateKey,
          value: params.value,
        });
      },
      async delete(params) {
        await stateStore.delete(pluginId, params.scopeKind as any, params.stateKey, {
          scopeId: params.scopeId,
          namespace: params.namespace,
        });
      },
    },

    entities: {
      async upsert(params) {
        return registry.upsertEntity(pluginId, params as any) as any;
      },
      async list(params) {
        return registry.listEntities(pluginId, params as any) as any;
      },
    },

    events: {
      async emit(params) {
        await scopedBus.emit(params.name, params.companyId, params.payload);
      },
    },

    http: {
      async fetch(params) {
        const response = await fetch(params.url, params.init as RequestInit);
        const body = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          headers[k] = v;
        });

        return {
          status: response.status,
          statusText: response.statusText,
          headers,
          body,
        };
      },
    },

    secrets: {
      async resolve(params) {
        return secretsHandler.resolve(params);
      },
    },

    assets: {
      async upload(params) {
        const data = Buffer.from(params.data, "base64");
        return assets.uploadPluginAsset(pluginId, params.filename, params.contentType, data);
      },
      async getUrl(params) {
        return assets.getPluginAssetUrl(pluginId, params.assetId);
      },
    },

    activity: {
      async log(params) {
        await logActivity(db, {
          companyId: ensureCompanyId(params.companyId),
          actorType: "plugin",
          actorId: pluginId,
          action: params.message,
          entityType: params.entityType ?? "plugin",
          entityId: params.entityId ?? pluginId,
          details: params.metadata,
        });
      },
    },

    metrics: {
      async write(params) {
        logger.debug({ pluginId, ...params }, "Plugin metric write (no-op)");
      },
    },

    logger: {
      async log(params) {
        const { level, message, meta } = params;
        const pluginLogger = logger.child({ service: "plugin-worker", pluginId });
        const logFields = {
          ...meta,
          pluginLogLevel: level,
          pluginTimestamp: new Date().toISOString(),
        };

        if (level === "error") pluginLogger.error(logFields, `[plugin] ${message}`);
        else if (level === "warn") pluginLogger.warn(logFields, `[plugin] ${message}`);
        else if (level === "debug") pluginLogger.debug(logFields, `[plugin] ${message}`);
        else pluginLogger.info(logFields, `[plugin] ${message}`);
      },
    },

    companies: {
      async list(_params) {
        return (await companies.list()) as Company[];
      },
      async get(params) {
        return (await companies.getById(params.companyId)) as Company;
      },
    },

    projects: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        return (await projects.list(companyId)) as Project[];
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        const project = await projects.getById(params.projectId);
        return (inCompany(project, companyId) ? project : null) as Project | null;
      },
      async listWorkspaces(params) {
        const companyId = ensureCompanyId(params.companyId);
        const project = await projects.getById(params.projectId);
        if (!inCompany(project, companyId)) return [];
        const rows = await projects.listWorkspaces(params.projectId);
        return rows.map((row) => {
          const path = sanitizeWorkspacePath(row.cwd);
          const name = sanitizeWorkspaceName(row.name, path);
          return {
            id: row.id,
            projectId: row.projectId,
            name,
            path,
            isPrimary: row.isPrimary,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          };
        });
      },
      async getPrimaryWorkspace(params) {
        const companyId = ensureCompanyId(params.companyId);
        const project = await projects.getById(params.projectId);
        if (!inCompany(project, companyId)) return null;
        const row = await projects.getPrimaryWorkspace(params.projectId);
        if (!row) return null;
        const path = sanitizeWorkspacePath(row.cwd);
        const name = sanitizeWorkspaceName(row.name, path);
        return {
          id: row.id,
          projectId: row.projectId,
          name,
          path,
          isPrimary: row.isPrimary,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      },
    },

    issues: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        return (await issues.list(companyId, params as any)) as Issue[];
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        const issue = await issues.getById(params.issueId);
        return (inCompany(issue, companyId) ? issue : null) as Issue | null;
      },
      async create(params) {
        const companyId = ensureCompanyId(params.companyId);
        return (await issues.create(companyId, params as any)) as Issue;
      },
      async update(params) {
        const companyId = ensureCompanyId(params.companyId);
        requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        return (await issues.update(params.issueId, params.patch as any)) as Issue;
      },
      async listComments(params) {
        const companyId = ensureCompanyId(params.companyId);
        if (!inCompany(await issues.getById(params.issueId), companyId)) return [];
        return (await issues.listComments(params.issueId)) as IssueComment[];
      },
      async createComment(params) {
        const companyId = ensureCompanyId(params.companyId);
        requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        return (await issues.addComment(
          params.issueId,
          params.body,
          {},
        )) as IssueComment;
      },
    },

    agents: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        return (await agents.list(companyId, {
          status: params.status as any,
        })) as Agent[];
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        const agent = await agents.getById(params.agentId);
        return (inCompany(agent, companyId) ? agent : null) as Agent | null;
      },
    },

    goals: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        return (await goals.list(
          companyId,
          params.level as any,
          params.status as any,
        )) as Goal[];
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        const goal = await goals.getById(params.goalId);
        return (inCompany(goal, companyId) ? goal : null) as Goal | null;
      },
    },
  };
}
