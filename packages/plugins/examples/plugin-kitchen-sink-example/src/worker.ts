import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  PLUGIN_STATE_SCOPE_KINDS,
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginEntityQuery,
  type PluginEvent,
  type PluginHealthDiagnostics,
  type PluginJobContext,
  type PluginLauncherRegistration,
  type PluginWebhookInput,
  type PluginWorkspace,
  type PluginStateScopeKind,
  type ScopeKey,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import type { Goal, Issue } from "@paperclipai/shared";
import {
  DEFAULT_CONFIG,
  JOB_KEYS,
  PLUGIN_ID,
  RUNTIME_LAUNCHER,
  SAFE_COMMANDS,
  STREAM_CHANNELS,
  TOOL_NAMES,
  WEBHOOK_KEYS,
} from "./constants.js";

type KitchenSinkConfig = {
  showSidebarEntry?: boolean;
  showSidebarPanel?: boolean;
  showProjectSidebarItem?: boolean;
  showCommentAnnotation?: boolean;
  showCommentContextMenuItem?: boolean;
  enableWorkspaceDemos?: boolean;
  enableProcessDemos?: boolean;
  secretRefExample?: string;
  httpDemoUrl?: string;
  allowedCommands?: string[];
  workspaceScratchFile?: string;
};

type DemoRecord = {
  id: string;
  level: "info" | "warning" | "error";
  source: string;
  message: string;
  createdAt: string;
  data?: unknown;
};

type ProcessResult = {
  commandKey: string;
  cwd: string;
  code: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
};

const recentRecords: DemoRecord[] = [];
const runtimeLaunchers = new Map<string, PluginLauncherRegistration>();
let currentContext: PluginContext | null = null;
let lastProcessResult: ProcessResult | null = null;

function isScopeKind(value: unknown): value is PluginStateScopeKind {
  return typeof value === "string" && PLUGIN_STATE_SCOPE_KINDS.includes(value as PluginStateScopeKind);
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function pushRecord(record: Omit<DemoRecord, "id" | "createdAt">): DemoRecord {
  const next: DemoRecord = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...record,
  };
  recentRecords.unshift(next);
  if (recentRecords.length > 50) recentRecords.length = 50;
  return next;
}

async function getConfig(ctx: PluginContext): Promise<KitchenSinkConfig> {
  const config = await ctx.config.get();
  return {
    ...DEFAULT_CONFIG,
    ...(config as KitchenSinkConfig),
  };
}

async function writeInstanceState(ctx: PluginContext, stateKey: string, value: unknown): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", stateKey }, value);
}

async function readInstanceState<T = unknown>(ctx: PluginContext, stateKey: string): Promise<T | null> {
  return await ctx.state.get({ scopeKind: "instance", stateKey }) as T | null;
}

async function resolveWorkspace(
  ctx: PluginContext,
  companyId: string,
  projectId: string,
  workspaceId?: string,
): Promise<PluginWorkspace> {
  const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
  if (workspaces.length === 0) {
    throw new Error("No workspaces configured for this project");
  }
  if (!workspaceId) return workspaces[0]!;
  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found");
  }
  return workspace;
}

function ensureInsideWorkspace(workspacePath: string, relativePath: string): string {
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Requested path escapes the selected workspace");
  }
  return resolved;
}

function parseJsonish(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function parseScopeKey(params: Record<string, unknown>): ScopeKey {
  const scopeKind = isScopeKind(params.scopeKind) ? params.scopeKind : "instance";
  const scopeId = typeof params.scopeId === "string" && params.scopeId.length > 0 ? params.scopeId : undefined;
  const namespace = typeof params.namespace === "string" && params.namespace.length > 0 ? params.namespace : undefined;
  const stateKey = typeof params.stateKey === "string" && params.stateKey.length > 0
    ? params.stateKey
    : "demo";
  return { scopeKind, scopeId, namespace, stateKey };
}

async function runCuratedCommand(
  ctx: PluginContext,
  config: KitchenSinkConfig,
  companyId: string,
  projectId: string,
  workspaceId: string | undefined,
  commandKey: string,
): Promise<ProcessResult> {
  if (!config.enableProcessDemos) {
    throw new Error("Process demos are disabled in plugin settings");
  }
  const allowedCommands = new Set(config.allowedCommands ?? DEFAULT_CONFIG.allowedCommands);
  if (!allowedCommands.has(commandKey)) {
    throw new Error(`Command "${commandKey}" is not allowed by plugin settings`);
  }
  const definition = SAFE_COMMANDS.find((entry) => entry.key === commandKey);
  if (!definition) {
    throw new Error(`Unknown curated command "${commandKey}"`);
  }
  const workspace = await resolveWorkspace(ctx, companyId, projectId, workspaceId);
  const cwd = workspace.path;
  const startedAt = new Date().toISOString();
  const child = spawn(definition.command, definition.args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  const result: ProcessResult = {
    commandKey,
    cwd,
    code,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  lastProcessResult = result;
  pushRecord({
    level: code === 0 ? "info" : "warning",
    source: "process",
    message: `Ran curated command "${commandKey}"`,
    data: { code, cwd },
  });
  await ctx.metrics.write("process.run", 1, { command: commandKey, exit_code: String(code ?? -1) });
  return result;
}

function getCurrentCompanyId(params: Record<string, unknown>): string {
  const companyId = typeof params.companyId === "string" ? params.companyId : "";
  if (!companyId) {
    throw new Error("companyId is required");
  }
  return companyId;
}

function getListLimit(params: Record<string, unknown>, fallback = 50): number {
  const value = typeof params.limit === "number" ? params.limit : Number(params.limit ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(200, Math.floor(value)));
}

async function listIssuesForCompany(ctx: PluginContext, companyId: string, limit = 50): Promise<Issue[]> {
  return await ctx.issues.list({ companyId, limit, offset: 0 });
}

async function listGoalsForCompany(ctx: PluginContext, companyId: string, limit = 50): Promise<Goal[]> {
  return await ctx.goals.list({ companyId, limit, offset: 0 });
}

function recentRecordsSnapshot(): DemoRecord[] {
  return recentRecords.slice(0, 20);
}

function runtimeLaunchersSnapshot(): PluginLauncherRegistration[] {
  return [...runtimeLaunchers.values()];
}

async function registerDataHandlers(ctx: PluginContext): Promise<void> {
  ctx.data.register("plugin-config", async () => {
    return await getConfig(ctx);
  });

  ctx.data.register("overview", async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    const config = await getConfig(ctx);
    const companies = await ctx.companies.list({ limit: 200, offset: 0 });
    const projects = companyId ? await ctx.projects.list({ companyId, limit: 200, offset: 0 }) : [];
    const issues = companyId ? await listIssuesForCompany(ctx, companyId, 200) : [];
    const goals = companyId ? await listGoalsForCompany(ctx, companyId, 200) : [];
    const agents = companyId ? await ctx.agents.list({ companyId, limit: 200, offset: 0 }) : [];
    const lastJob = await readInstanceState(ctx, "last-job-run");
    const lastWebhook = await readInstanceState(ctx, "last-webhook");
    const entityRecords = await ctx.entities.list({ limit: 10 } satisfies PluginEntityQuery);
    return {
      pluginId: PLUGIN_ID,
      version: ctx.manifest.version,
      capabilities: ctx.manifest.capabilities,
      config,
      runtimeLaunchers: runtimeLaunchersSnapshot(),
      recentRecords: recentRecordsSnapshot(),
      counts: {
        companies: companies.length,
        projects: projects.length,
        issues: issues.length,
        goals: goals.length,
        agents: agents.length,
        entities: entityRecords.length,
      },
      lastJob,
      lastWebhook,
      lastProcessResult,
      streamChannels: STREAM_CHANNELS,
      safeCommands: SAFE_COMMANDS,
      manifest: {
        jobs: ctx.manifest.jobs ?? [],
        webhooks: ctx.manifest.webhooks ?? [],
        tools: ctx.manifest.tools ?? [],
      },
    };
  });

  ctx.data.register("companies", async (params) => {
    return await ctx.companies.list({ limit: getListLimit(params), offset: 0 });
  });

  ctx.data.register("projects", async (params) => {
    const companyId = getCurrentCompanyId(params);
    return await ctx.projects.list({ companyId, limit: getListLimit(params), offset: 0 });
  });

  ctx.data.register("issues", async (params) => {
    const companyId = getCurrentCompanyId(params);
    return await listIssuesForCompany(ctx, companyId, getListLimit(params));
  });

  ctx.data.register("goals", async (params) => {
    const companyId = getCurrentCompanyId(params);
    return await listGoalsForCompany(ctx, companyId, getListLimit(params));
  });

  ctx.data.register("agents", async (params) => {
    const companyId = getCurrentCompanyId(params);
    return await ctx.agents.list({ companyId, limit: getListLimit(params), offset: 0 });
  });

  ctx.data.register("workspaces", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const projectId = typeof params.projectId === "string" ? params.projectId : "";
    if (!projectId) return [];
    return await ctx.projects.listWorkspaces(projectId, companyId);
  });

  ctx.data.register("state-value", async (params) => {
    const input = parseScopeKey(params);
    const value = await ctx.state.get(input);
    return {
      scope: input,
      value,
    };
  });

  ctx.data.register("entities", async (params) => {
    const query: PluginEntityQuery = {
      entityType: typeof params.entityType === "string" && params.entityType.length > 0 ? params.entityType : undefined,
      scopeKind: isScopeKind(params.scopeKind) ? params.scopeKind : undefined,
      scopeId: typeof params.scopeId === "string" && params.scopeId.length > 0 ? params.scopeId : undefined,
      limit: typeof params.limit === "number" ? params.limit : 25,
      offset: 0,
    };
    return await ctx.entities.list(query);
  });

  ctx.data.register("comment-context", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const issueId = typeof params.issueId === "string" ? params.issueId : "";
    const commentId = typeof params.commentId === "string" ? params.commentId : "";
    if (!issueId || !commentId) return null;
    const comments = await ctx.issues.listComments(issueId, companyId);
    const comment = comments.find((entry) => entry.id === commentId) ?? null;
    if (!comment) return null;
    return {
      commentId: comment.id,
      issueId,
      preview: comment.body.slice(0, 160),
      length: comment.body.length,
      copiedCount: (await ctx.entities.list({
        entityType: "copied-comment",
        scopeKind: "issue",
        scopeId: issueId,
        limit: 100,
        offset: 0,
      })).filter((entry) => entry.externalId === commentId).length,
    };
  });

  ctx.data.register("entity-context", async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    const entityId = typeof params.entityId === "string" ? params.entityId : "";
    const entityType = typeof params.entityType === "string" ? params.entityType : "";
    if (!companyId || !entityId || !entityType) return null;

    if (entityType === "project") {
      return await ctx.projects.get(entityId, companyId);
    }
    if (entityType === "issue") {
      return await ctx.issues.get(entityId, companyId);
    }
    if (entityType === "goal") {
      return await ctx.goals.get(entityId, companyId);
    }
    if (entityType === "agent") {
      return await ctx.agents.get(entityId, companyId);
    }
    return { entityId, entityType, companyId };
  });
}

async function registerActionHandlers(ctx: PluginContext): Promise<void> {
  ctx.actions.register("emit-demo-event", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const message = typeof params.message === "string" && params.message.trim().length > 0
      ? params.message.trim()
      : "Kitchen Sink demo event";
    await ctx.events.emit("demo-event", companyId, {
      message,
      source: "kitchen-sink",
      emittedAt: new Date().toISOString(),
    });
    pushRecord({
      level: "info",
      source: "events.emit",
      message,
      data: { companyId },
    });
    await ctx.metrics.write("demo.events.emitted", 1, { source: "manual" });
    await ctx.telemetry.track("demo_event", {
      source: "manual",
      has_company: Boolean(companyId),
    });
    pushRecord({
      level: "info",
      source: "telemetry",
      message: "Tracked plugin telemetry event demo_event",
      data: { companyId },
    });
    return { ok: true, message };
  });

  ctx.actions.register("write-scoped-state", async (params) => {
    const input = parseScopeKey(params);
    const valueInput = typeof params.value === "string" ? params.value : JSON.stringify(params.value ?? "");
    const value = parseJsonish(valueInput);
    await ctx.state.set(input, value);
    pushRecord({
      level: "info",
      source: "state",
      message: `Wrote state key ${input.stateKey}`,
      data: input,
    });
    await ctx.metrics.write("demo.state.write", 1, { scope: input.scopeKind });
    return { ok: true, scope: input, value };
  });

  ctx.actions.register("delete-scoped-state", async (params) => {
    const input = parseScopeKey(params);
    await ctx.state.delete(input);
    pushRecord({
      level: "warning",
      source: "state",
      message: `Deleted state key ${input.stateKey}`,
      data: input,
    });
    return { ok: true, scope: input };
  });

  ctx.actions.register("upsert-entity", async (params) => {
    const title = typeof params.title === "string" && params.title.length > 0 ? params.title : "Kitchen Sink Entity";
    const entityType = typeof params.entityType === "string" && params.entityType.length > 0
      ? params.entityType
      : "demo-record";
    const scopeKind = isScopeKind(params.scopeKind)
      ? params.scopeKind
      : "instance";
    const scopeId = typeof params.scopeId === "string" && params.scopeId.length > 0 ? params.scopeId : undefined;
    const status = typeof params.status === "string" && params.status.length > 0 ? params.status : "active";
    const data = typeof params.data === "string" ? parseJsonish(params.data) : params.data;
    const record = await ctx.entities.upsert({
      entityType,
      scopeKind,
      scopeId,
      externalId: typeof params.externalId === "string" && params.externalId.length > 0 ? params.externalId : randomUUID(),
      title,
      status,
      data: typeof data === "object" && data !== null ? data as Record<string, unknown> : { value: data },
    });
    pushRecord({
      level: "info",
      source: "entities",
      message: `Upserted entity ${record.entityType}`,
      data: { id: record.id, scopeKind: record.scopeKind },
    });
    return record;
  });

  ctx.actions.register("create-issue", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const title = typeof params.title === "string" && params.title.trim().length > 0
      ? params.title.trim()
      : "Kitchen Sink demo issue";
    const description = typeof params.description === "string" ? params.description : undefined;
    const projectId = typeof params.projectId === "string" && params.projectId.length > 0 ? params.projectId : undefined;
    const issue = await ctx.issues.create({ companyId, projectId, title, description });
    pushRecord({
      level: "info",
      source: "issues.create",
      message: `Created issue ${issue.title}`,
      data: { issueId: issue.id },
    });
    await ctx.activity.log({
      companyId,
      entityType: "issue",
      entityId: issue.id,
      message: `Kitchen Sink created issue "${issue.title}"`,
      metadata: { plugin: PLUGIN_ID },
    });
    return issue;
  });

  ctx.actions.register("advance-issue-status", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const issueId = typeof params.issueId === "string" ? params.issueId : "";
    const status = typeof params.status === "string" ? params.status : "";
    if (!issueId || !status) {
      throw new Error("issueId and status are required");
    }
    const issue = await ctx.issues.update(issueId, { status: status as Issue["status"] }, companyId);
    pushRecord({
      level: "info",
      source: "issues.update",
      message: `Updated issue ${issue.id} to ${issue.status}`,
    });
    return issue;
  });

  ctx.actions.register("create-goal", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const title = typeof params.title === "string" && params.title.trim().length > 0
      ? params.title.trim()
      : "Kitchen Sink demo goal";
    const description = typeof params.description === "string" ? params.description : undefined;
    const goal = await ctx.goals.create({ companyId, title, description, level: "team", status: "planned" });
    pushRecord({
      level: "info",
      source: "goals.create",
      message: `Created goal ${goal.title}`,
      data: { goalId: goal.id },
    });
    return goal;
  });

  ctx.actions.register("advance-goal-status", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const goalId = typeof params.goalId === "string" ? params.goalId : "";
    const status = typeof params.status === "string" ? params.status : "";
    if (!goalId || !status) {
      throw new Error("goalId and status are required");
    }
    const goal = await ctx.goals.update(goalId, { status: status as Goal["status"] }, companyId);
    pushRecord({
      level: "info",
      source: "goals.update",
      message: `Updated goal ${goal.id} to ${goal.status}`,
    });
    return goal;
  });

  ctx.actions.register("write-activity", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const entityType = typeof params.entityType === "string" ? params.entityType : undefined;
    const entityId = typeof params.entityId === "string" ? params.entityId : undefined;
    const message = typeof params.message === "string" && params.message.length > 0
      ? params.message
      : "Kitchen Sink wrote an activity entry";
    await ctx.activity.log({
      companyId,
      entityType,
      entityId,
      message,
      metadata: { plugin: PLUGIN_ID },
    });
    pushRecord({
      level: "info",
      source: "activity",
      message,
      data: { entityType, entityId },
    });
    return { ok: true };
  });

  ctx.actions.register("write-metric", async (params) => {
    const value = typeof params.value === "number" ? params.value : Number(params.value ?? 1);
    const name = typeof params.name === "string" && params.name.length > 0 ? params.name : "manual";
    await ctx.metrics.write(`demo.${name}`, Number.isFinite(value) ? value : 1, { source: "manual" });
    pushRecord({
      level: "info",
      source: "metrics",
      message: `Wrote metric demo.${name}`,
      data: { value },
    });
    return { ok: true, value };
  });

  ctx.actions.register("http-fetch", async (params) => {
    const config = await getConfig(ctx);
    const url = typeof params.url === "string" && params.url.length > 0
      ? params.url
      : config.httpDemoUrl || DEFAULT_CONFIG.httpDemoUrl;
    const started = Date.now();
    const response = await ctx.http.fetch(url, { method: "GET" });
    const body = await response.text();
    const result = {
      ok: response.ok,
      status: response.status,
      url,
      durationMs: Date.now() - started,
      body: body.slice(0, 2000),
    };
    pushRecord({
      level: response.ok ? "info" : "warning",
      source: "http",
      message: `Fetched ${url}`,
      data: { status: response.status },
    });
    return result;
  });

  ctx.actions.register("resolve-secret", async (params) => {
    const config = await getConfig(ctx);
    const secretRef = typeof params.secretRef === "string" && params.secretRef.length > 0
      ? params.secretRef
      : config.secretRefExample || "";
    if (!secretRef) {
      throw new Error("No secret reference configured");
    }
    const resolved = await ctx.secrets.resolve(secretRef);
    pushRecord({
      level: "info",
      source: "secrets",
      message: `Resolved secret reference ${secretRef}`,
    });
    return {
      secretRef,
      resolvedLength: resolved.length,
      preview: resolved.length > 0 ? `${resolved.slice(0, 2)}***` : "",
    };
  });

  ctx.actions.register("run-process", async (params) => {
    const config = await getConfig(ctx);
    const companyId = getCurrentCompanyId(params);
    const projectId = typeof params.projectId === "string" ? params.projectId : "";
    const workspaceId = typeof params.workspaceId === "string" && params.workspaceId.length > 0 ? params.workspaceId : undefined;
    const commandKey = typeof params.commandKey === "string" ? params.commandKey : "pwd";
    if (!projectId) throw new Error("projectId is required");
    return await runCuratedCommand(ctx, config, companyId, projectId, workspaceId, commandKey);
  });

  ctx.actions.register("read-workspace-file", async (params) => {
    const config = await getConfig(ctx);
    if (!config.enableWorkspaceDemos) {
      throw new Error("Workspace demos are disabled in plugin settings");
    }
    const companyId = getCurrentCompanyId(params);
    const projectId = typeof params.projectId === "string" ? params.projectId : "";
    const workspaceId = typeof params.workspaceId === "string" && params.workspaceId.length > 0 ? params.workspaceId : undefined;
    const relativePath = typeof params.relativePath === "string" && params.relativePath.length > 0
      ? params.relativePath
      : config.workspaceScratchFile || DEFAULT_CONFIG.workspaceScratchFile;
    if (!projectId) throw new Error("projectId is required");
    const workspace = await resolveWorkspace(ctx, companyId, projectId, workspaceId);
    const fullPath = ensureInsideWorkspace(workspace.path, relativePath);
    const content = await fs.readFile(fullPath, "utf8");
    return {
      workspaceId: workspace.id,
      relativePath,
      content,
    };
  });

  ctx.actions.register("write-workspace-scratch", async (params) => {
    const config = await getConfig(ctx);
    if (!config.enableWorkspaceDemos) {
      throw new Error("Workspace demos are disabled in plugin settings");
    }
    const companyId = getCurrentCompanyId(params);
    const projectId = typeof params.projectId === "string" ? params.projectId : "";
    const workspaceId = typeof params.workspaceId === "string" && params.workspaceId.length > 0 ? params.workspaceId : undefined;
    const relativePath = typeof params.relativePath === "string" && params.relativePath.length > 0
      ? params.relativePath
      : config.workspaceScratchFile || DEFAULT_CONFIG.workspaceScratchFile;
    const content = typeof params.content === "string" ? params.content : "Kitchen Sink workspace demo";
    if (!projectId) throw new Error("projectId is required");
    const workspace = await resolveWorkspace(ctx, companyId, projectId, workspaceId);
    const fullPath = ensureInsideWorkspace(workspace.path, relativePath);
    await fs.writeFile(fullPath, content, "utf8");
    pushRecord({
      level: "info",
      source: "workspace",
      message: `Wrote scratch file ${relativePath}`,
      data: { workspaceId: workspace.id },
    });
    return {
      workspaceId: workspace.id,
      relativePath,
      bytes: Buffer.byteLength(content, "utf8"),
    };
  });

  ctx.actions.register("start-progress-stream", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const steps = typeof params.steps === "number" ? params.steps : 5;
    void (async () => {
      ctx.streams.open(STREAM_CHANNELS.progress, companyId);
      try {
        for (let index = 1; index <= steps; index += 1) {
          ctx.streams.emit(STREAM_CHANNELS.progress, {
            step: index,
            total: steps,
            message: `Progress step ${index}/${steps}`,
          });
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      } finally {
        ctx.streams.close(STREAM_CHANNELS.progress);
      }
    })();
    return { ok: true, channel: STREAM_CHANNELS.progress };
  });

  ctx.actions.register("invoke-agent", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const agentId = typeof params.agentId === "string" ? params.agentId : "";
    const prompt = typeof params.prompt === "string" && params.prompt.length > 0
      ? params.prompt
      : "Kitchen Sink test invocation";
    if (!agentId) throw new Error("agentId is required");
    const result = await ctx.agents.invoke(agentId, companyId, { prompt, reason: "Kitchen Sink plugin demo" });
    pushRecord({
      level: "info",
      source: "agents.invoke",
      message: `Invoked agent ${agentId}`,
      data: result,
    });
    return result;
  });

  ctx.actions.register("pause-agent", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const agentId = typeof params.agentId === "string" ? params.agentId : "";
    if (!agentId) throw new Error("agentId is required");
    return await ctx.agents.pause(agentId, companyId);
  });

  ctx.actions.register("resume-agent", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const agentId = typeof params.agentId === "string" ? params.agentId : "";
    if (!agentId) throw new Error("agentId is required");
    return await ctx.agents.resume(agentId, companyId);
  });

  ctx.actions.register("ask-agent", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const agentId = typeof params.agentId === "string" ? params.agentId : "";
    const prompt = typeof params.prompt === "string" && params.prompt.length > 0
      ? params.prompt
      : "Say hello from the Kitchen Sink plugin.";
    if (!agentId) throw new Error("agentId is required");

    ctx.streams.open(STREAM_CHANNELS.agentChat, companyId);
    const session = await ctx.agents.sessions.create(agentId, companyId, {
      reason: "Kitchen Sink plugin chat demo",
    });

    await ctx.agents.sessions.sendMessage(session.sessionId, companyId, {
      prompt,
      reason: "Kitchen Sink demo",
      onEvent: (event) => {
        ctx.streams.emit(STREAM_CHANNELS.agentChat, {
          eventType: event.eventType,
          stream: event.stream,
          message: event.message,
          payload: event.payload,
        });
        if (event.eventType === "done" || event.eventType === "error") {
          ctx.streams.close(STREAM_CHANNELS.agentChat);
        }
      },
    });

    pushRecord({
      level: "info",
      source: "agent.sessions",
      message: `Started agent session ${session.sessionId}`,
      data: { agentId, sessionId: session.sessionId },
    });
    return { channel: STREAM_CHANNELS.agentChat, sessionId: session.sessionId };
  });

  ctx.actions.register("copy-comment-context", async (params) => {
    const companyId = getCurrentCompanyId(params);
    const issueId = typeof params.issueId === "string" ? params.issueId : "";
    const commentId = typeof params.commentId === "string" ? params.commentId : "";
    if (!issueId || !commentId) {
      throw new Error("issueId and commentId are required");
    }
    const comments = await ctx.issues.listComments(issueId, companyId);
    const comment = comments.find((entry) => entry.id === commentId);
    if (!comment) {
      throw new Error("Comment not found");
    }
    const record = await ctx.entities.upsert({
      entityType: "copied-comment",
      scopeKind: "issue",
      scopeId: issueId,
      externalId: comment.id,
      title: `Copied comment ${comment.id.slice(0, 8)}`,
      status: "captured",
      data: {
        commentId: comment.id,
        issueId,
        body: comment.body,
      },
    });
    pushRecord({
      level: "info",
      source: "comments",
      message: `Copied comment ${comment.id} into plugin entities`,
      data: { recordId: record.id },
    });
    return record;
  });
}

async function registerToolHandlers(ctx: PluginContext): Promise<void> {
  ctx.tools.register(
    TOOL_NAMES.echo,
    {
      displayName: "Kitchen Sink Echo",
      description: "Echoes the provided message back to the caller.",
      parametersSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      const payload = params as { message?: string };
      return {
        content: payload.message ?? "No message provided",
        data: {
          runCtx,
          message: payload.message ?? "",
        },
      };
    },
  );

  ctx.tools.register(
    TOOL_NAMES.companySummary,
    {
      displayName: "Kitchen Sink Company Summary",
      description: "Summarizes current company counts from the Paperclip APIs.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (_params, runCtx): Promise<ToolResult> => {
      const projects = await ctx.projects.list({ companyId: runCtx.companyId, limit: 50, offset: 0 });
      const issues = await ctx.issues.list({ companyId: runCtx.companyId, limit: 50, offset: 0 });
      const goals = await ctx.goals.list({ companyId: runCtx.companyId, limit: 50, offset: 0 });
      const agents = await ctx.agents.list({ companyId: runCtx.companyId, limit: 50, offset: 0 });
      return {
        content: `Company has ${projects.length} projects, ${issues.length} issues, ${goals.length} goals, and ${agents.length} agents.`,
        data: {
          companyId: runCtx.companyId,
          projects: projects.length,
          issues: issues.length,
          goals: goals.length,
          agents: agents.length,
        },
      };
    },
  );

  ctx.tools.register(
    TOOL_NAMES.createIssue,
    {
      displayName: "Kitchen Sink Create Issue",
      description: "Creates an issue in the current run context.",
      parametersSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["title"],
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      const payload = params as { title?: string; description?: string };
      if (!payload.title) {
        return { error: "title is required" };
      }
      const issue = await ctx.issues.create({
        companyId: runCtx.companyId,
        projectId: runCtx.projectId,
        title: payload.title,
        description: payload.description,
      });
      return {
        content: `Created issue ${issue.title}`,
        data: issue,
      };
    },
  );
}

async function registerEventHandlers(ctx: PluginContext): Promise<void> {
  ctx.events.on("issue.created", async (event: PluginEvent) => {
    pushRecord({
      level: "info",
      source: "events.subscribe",
      message: "Observed issue.created",
      data: event,
    });
  });

  ctx.events.on("issue.updated", async (event: PluginEvent) => {
    pushRecord({
      level: "info",
      source: "events.subscribe",
      message: "Observed issue.updated",
      data: event,
    });
  });

  ctx.events.on(`plugin.${PLUGIN_ID}.demo-event`, async (event: PluginEvent) => {
    pushRecord({
      level: "info",
      source: "plugin-event",
      message: "Observed plugin demo event",
      data: event,
    });
  });
}

async function registerJobs(ctx: PluginContext): Promise<void> {
  ctx.jobs.register(JOB_KEYS.heartbeat, async (job: PluginJobContext) => {
    const payload = {
      jobKey: job.jobKey,
      runId: job.runId,
      trigger: job.trigger,
      scheduledAt: job.scheduledAt,
      completedAt: new Date().toISOString(),
    };
    await writeInstanceState(ctx, "last-job-run", payload);
    pushRecord({
      level: "info",
      source: "jobs",
      message: "Kitchen Sink demo job ran",
      data: payload,
    });
    await ctx.metrics.write("jobs.demo_heartbeat", 1, { trigger: job.trigger });
  });
}

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    runtimeLaunchers.set(RUNTIME_LAUNCHER.id, RUNTIME_LAUNCHER);
    ctx.launchers.register(RUNTIME_LAUNCHER);
    pushRecord({
      level: "info",
      source: "setup",
      message: "Kitchen Sink plugin setup complete",
      data: { pluginId: PLUGIN_ID },
    });
    await registerEventHandlers(ctx);
    await registerJobs(ctx);
    await registerDataHandlers(ctx);
    await registerActionHandlers(ctx);
    await registerToolHandlers(ctx);
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentContext;
    const config = ctx ? await getConfig(ctx) : DEFAULT_CONFIG;
    return {
      status: "ok",
      message: "Kitchen Sink plugin ready",
      details: {
        recordsTracked: recentRecords.length,
        runtimeLaunchers: runtimeLaunchers.size,
        processDemosEnabled: config.enableProcessDemos === true,
        workspaceDemosEnabled: config.enableWorkspaceDemos !== false,
      },
    };
  },

  async onConfigChanged(newConfig) {
    pushRecord({
      level: "info",
      source: "config",
      message: "Kitchen Sink config changed",
      data: newConfig,
    });
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const typed = config as KitchenSinkConfig;
    if (typed.httpDemoUrl && typeof typed.httpDemoUrl !== "string") {
      errors.push("httpDemoUrl must be a string");
    }
    if (typed.allowedCommands && !Array.isArray(typed.allowedCommands)) {
      errors.push("allowedCommands must be an array");
    }
    if (Array.isArray(typed.allowedCommands)) {
      const allowed = new Set<string>(SAFE_COMMANDS.map((command) => command.key));
      const invalid = typed.allowedCommands.filter((value) => typeof value !== "string" || !allowed.has(value));
      if (invalid.length > 0) {
        errors.push(`allowedCommands contains unsupported values: ${invalid.join(", ")}`);
      }
    }
    if (typed.enableProcessDemos) {
      warnings.push("Process demos run local child processes and are intended only for trusted development environments.");
    }
    return {
      ok: errors.length === 0,
      warnings,
      errors,
    };
  },

  async onWebhook(input: PluginWebhookInput) {
    const payload = {
      endpointKey: input.endpointKey,
      requestId: input.requestId,
      rawBody: input.rawBody,
      parsedBody: input.parsedBody,
      receivedAt: new Date().toISOString(),
    };
    const ctx = currentContext;
    if (ctx) {
      await writeInstanceState(ctx, "last-webhook", payload);
    }
    pushRecord({
      level: "info",
      source: "webhook",
      message: `Received webhook ${input.endpointKey}`,
      data: payload,
    });
    if (input.endpointKey !== WEBHOOK_KEYS.demo) {
      throw new Error(`Unsupported webhook endpoint "${input.endpointKey}"`);
    }
  },

  async onShutdown() {
    pushRecord({
      level: "warning",
      source: "shutdown",
      message: "Kitchen Sink plugin shutting down",
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
