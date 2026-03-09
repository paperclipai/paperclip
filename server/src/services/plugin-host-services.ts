import type { Db } from "@paperclipai/db";
import { pluginLogs, agentTaskSessions as agentTaskSessionsTable } from "@paperclipai/db";
import { eq, and, like, desc } from "drizzle-orm";
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
import { heartbeatService } from "./heartbeat.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";
import { randomUUID } from "node:crypto";
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
  notifyWorker?: (method: string, params: unknown) => void,
): HostServices {
  const registry = pluginRegistryService(db);
  const stateStore = pluginStateStore(db);
  const secretsHandler = createPluginSecretsHandler({ db, pluginId });
  const companies = companyService(db);
  const agents = agentService(db);
  const heartbeat = heartbeatService(db);
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
        logger.debug({ pluginId, ...params }, "Plugin metric write");

        // Persist metrics to plugin_logs with level "metric" so they are
        // queryable alongside regular logs via the same API (§26).
        db.insert(pluginLogs)
          .values({
            pluginId,
            level: "metric",
            message: params.name,
            meta: { value: params.value, tags: params.tags ?? null },
          })
          .catch(() => {
            // Swallow DB write errors to avoid disrupting the plugin.
          });
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

        // Persist to plugin_logs table for queryable log history (§26.1).
        // Fire-and-forget — logging should never block the worker.
        db.insert(pluginLogs)
          .values({
            pluginId,
            level: level ?? "info",
            message: message ?? "",
            meta: meta ?? null,
          })
          .catch(() => {
            // Swallow DB write errors to avoid disrupting the plugin.
          });
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

      async getWorkspaceForIssue(params) {
        const companyId = ensureCompanyId(params.companyId);
        const issue = await issues.getById(params.issueId);
        if (!inCompany(issue, companyId)) return null;
        const projectId = (issue as Record<string, unknown>).projectId as string | null;
        if (!projectId) return null;
        const project = await projects.getById(projectId);
        if (!inCompany(project, companyId)) return null;
        const row = await projects.getPrimaryWorkspace(projectId);
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
      async pause(params) {
        const companyId = ensureCompanyId(params.companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        return (await agents.pause(params.agentId)) as Agent;
      },
      async resume(params) {
        const companyId = ensureCompanyId(params.companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        return (await agents.resume(params.agentId)) as Agent;
      },
      async invoke(params) {
        const companyId = ensureCompanyId(params.companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        const run = await heartbeat.wakeup(params.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: params.reason ?? null,
          payload: { prompt: params.prompt },
          requestedByActorType: "system",
          requestedByActorId: pluginId,
        });
        if (!run) throw new Error("Agent wakeup was skipped by heartbeat policy");
        return { runId: run.id };
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
      async create(params) {
        const companyId = ensureCompanyId(params.companyId);
        return (await goals.create(companyId, {
          title: params.title,
          description: params.description,
          level: params.level as any,
          status: params.status as any,
          parentId: params.parentId,
          ownerAgentId: params.ownerAgentId,
        })) as Goal;
      },
      async update(params) {
        const companyId = ensureCompanyId(params.companyId);
        requireInCompany("Goal", await goals.getById(params.goalId), companyId);
        return (await goals.update(params.goalId, params.patch as any)) as Goal;
      },
    },

    agentSessions: {
      async create(params) {
        const companyId = ensureCompanyId(params.companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        const taskKey = params.taskKey ?? `plugin:${pluginKey}:session:${randomUUID()}`;

        const row = await db
          .insert(agentTaskSessionsTable)
          .values({
            companyId,
            agentId: params.agentId,
            adapterType: agent!.adapterType,
            taskKey,
            sessionParamsJson: null,
            sessionDisplayId: null,
            lastRunId: null,
            lastError: null,
          })
          .returning()
          .then((rows) => rows[0]);

        return {
          sessionId: row!.id,
          agentId: params.agentId,
          companyId,
          status: "active" as const,
          createdAt: row!.createdAt.toISOString(),
        };
      },

      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        const rows = await db
          .select()
          .from(agentTaskSessionsTable)
          .where(
            and(
              eq(agentTaskSessionsTable.agentId, params.agentId),
              eq(agentTaskSessionsTable.companyId, companyId),
              like(agentTaskSessionsTable.taskKey, `plugin:${pluginKey}:session:%`),
            ),
          )
          .orderBy(desc(agentTaskSessionsTable.createdAt));

        return rows.map((row) => ({
          sessionId: row.id,
          agentId: row.agentId,
          companyId: row.companyId,
          status: "active" as const,
          createdAt: row.createdAt.toISOString(),
        }));
      },

      async sendMessage(params) {
        const companyId = ensureCompanyId(params.companyId);

        // Verify session exists and belongs to this plugin
        const session = await db
          .select()
          .from(agentTaskSessionsTable)
          .where(
            and(
              eq(agentTaskSessionsTable.id, params.sessionId),
              eq(agentTaskSessionsTable.companyId, companyId),
              like(agentTaskSessionsTable.taskKey, `plugin:${pluginKey}:session:%`),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!session) throw new Error(`Session not found: ${params.sessionId}`);

        const run = await heartbeat.wakeup(session.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: params.reason ?? null,
          payload: { prompt: params.prompt },
          contextSnapshot: {
            taskKey: session.taskKey,
            wakeSource: "automation",
            wakeTriggerDetail: "system",
          },
          requestedByActorType: "system",
          requestedByActorId: pluginId,
        });
        if (!run) throw new Error("Agent wakeup was skipped by heartbeat policy");

        // Subscribe to live events and forward to the plugin worker as notifications
        if (notifyWorker) {
          const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
          const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
            const payload = event.payload as Record<string, unknown> | undefined;
            if (!payload || payload.runId !== run.id) return;

            if (event.type === "heartbeat.run.log" || event.type === "heartbeat.run.event") {
              notifyWorker("agents.sessions.event", {
                sessionId: params.sessionId,
                runId: run.id,
                seq: (payload.seq as number) ?? 0,
                eventType: "chunk",
                stream: (payload.stream as string) ?? null,
                message: (payload.chunk as string) ?? (payload.message as string) ?? null,
                payload: payload,
              });
            } else if (event.type === "heartbeat.run.status") {
              const status = payload.status as string;
              if (TERMINAL_STATUSES.has(status)) {
                notifyWorker("agents.sessions.event", {
                  sessionId: params.sessionId,
                  runId: run.id,
                  seq: 0,
                  eventType: status === "succeeded" ? "done" : "error",
                  stream: "system",
                  message: status === "succeeded" ? "Run completed" : `Run ${status}`,
                  payload: payload,
                });
                unsubscribe();
              } else {
                notifyWorker("agents.sessions.event", {
                  sessionId: params.sessionId,
                  runId: run.id,
                  seq: 0,
                  eventType: "status",
                  stream: "system",
                  message: `Run status: ${status}`,
                  payload: payload,
                });
              }
            }
          });
        }

        return { runId: run.id };
      },

      async close(params) {
        const companyId = ensureCompanyId(params.companyId);
        const deleted = await db
          .delete(agentTaskSessionsTable)
          .where(
            and(
              eq(agentTaskSessionsTable.id, params.sessionId),
              eq(agentTaskSessionsTable.companyId, companyId),
              like(agentTaskSessionsTable.taskKey, `plugin:${pluginKey}:session:%`),
            ),
          )
          .returning()
          .then((rows) => rows.length);
        if (deleted === 0) throw new Error(`Session not found: ${params.sessionId}`);
      },
    },
  };
}
