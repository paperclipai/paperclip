import { randomUUID } from "node:crypto";
import type {
  PaperclipPluginManifestV1,
  PluginCapability,
  PluginEventType,
  PluginIssueOriginKind,
  Company,
  Project,
  Issue,
  IssueComment,
  IssueThreadInteraction,
  CreateIssueThreadInteraction,
  IssueDocument,
  Agent,
  Goal,
} from "@paperclipai/shared";
import type {
  EventFilter,
  PluginContext,
  PluginEntityRecord,
  PluginEntityUpsert,
  PluginJobContext,
  PluginLauncherRegistration,
  PluginEvent,
  ScopeKey,
  ToolResult,
  ToolRunContext,
  PluginWorkspace,
  AgentSession,
  AgentSessionEvent,
} from "./types.js";
import type {
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentLease,
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
} from "./protocol.js";

export interface TestHarnessOptions {
  /** Plugin manifest used to seed capability checks and metadata. */
  manifest: PaperclipPluginManifestV1;
  /** Optional capability override. Defaults to `manifest.capabilities`. */
  capabilities?: PluginCapability[];
  /** Initial config returned by `ctx.config.get()`. */
  config?: Record<string, unknown>;
}

export interface TestHarnessLogEntry {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  meta?: Record<string, unknown>;
}

export interface TestHarness {
  /** Fully-typed in-memory plugin context passed to `plugin.setup(ctx)`. */
  ctx: PluginContext;
  /** Seed host entities for `ctx.companies/projects/issues/agents/goals` reads. */
  seed(input: {
    companies?: Company[];
    projects?: Project[];
    issues?: Issue[];
    issueComments?: IssueComment[];
    agents?: Agent[];
    goals?: Goal[];
  }): void;
  setConfig(config: Record<string, unknown>): void;
  /** Dispatch a host or plugin event to registered handlers. */
  emit(eventType: PluginEventType | `plugin.${string}`, payload: unknown, base?: Partial<PluginEvent>): Promise<void>;
  /** Execute a previously-registered scheduled job handler. */
  runJob(jobKey: string, partial?: Partial<PluginJobContext>): Promise<void>;
  /** Invoke a `ctx.data.register(...)` handler by key. */
  getData<T = unknown>(key: string, params?: Record<string, unknown>): Promise<T>;
  /** Invoke a `ctx.actions.register(...)` handler by key. */
  performAction<T = unknown>(key: string, params?: Record<string, unknown>): Promise<T>;
  /** Execute a registered tool handler via `ctx.tools.execute(...)`. */
  executeTool<T = ToolResult>(name: string, params: unknown, runCtx?: Partial<ToolRunContext>): Promise<T>;
  /** Read raw in-memory state for assertions. */
  getState(input: ScopeKey): unknown;
  /** Simulate a streaming event arriving for an active session. */
  simulateSessionEvent(sessionId: string, event: Omit<AgentSessionEvent, "sessionId">): void;
  logs: TestHarnessLogEntry[];
  activity: Array<{ message: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> }>;
  metrics: Array<{ name: string; value: number; tags?: Record<string, string> }>;
  telemetry: Array<{ eventName: string; dimensions?: Record<string, string | number | boolean> }>;
  dbQueries: Array<{ sql: string; params?: unknown[] }>;
  dbExecutes: Array<{ sql: string; params?: unknown[] }>;
}

// ---------------------------------------------------------------------------
// Environment test harness types
// ---------------------------------------------------------------------------

/** Recorded environment lifecycle event for assertion helpers. */
export interface EnvironmentEventRecord {
  type:
    | "validateConfig"
    | "probe"
    | "acquireLease"
    | "resumeLease"
    | "releaseLease"
    | "destroyLease"
    | "realizeWorkspace"
    | "execute";
  driverKey: string;
  environmentId: string;
  timestamp: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

/** Options for creating an environment-aware test harness. */
export interface EnvironmentTestHarnessOptions extends TestHarnessOptions {
  /** Environment driver hooks provided by the plugin under test. */
  environmentDriver: {
    driverKey: string;
    onValidateConfig?: (params: PluginEnvironmentValidateConfigParams) => Promise<PluginEnvironmentValidationResult>;
    onProbe?: (params: PluginEnvironmentProbeParams) => Promise<PluginEnvironmentProbeResult>;
    onAcquireLease?: (params: PluginEnvironmentAcquireLeaseParams) => Promise<PluginEnvironmentLease>;
    onResumeLease?: (params: PluginEnvironmentResumeLeaseParams) => Promise<PluginEnvironmentLease>;
    onReleaseLease?: (params: PluginEnvironmentReleaseLeaseParams) => Promise<void>;
    onDestroyLease?: (params: PluginEnvironmentDestroyLeaseParams) => Promise<void>;
    onRealizeWorkspace?: (params: PluginEnvironmentRealizeWorkspaceParams) => Promise<PluginEnvironmentRealizeWorkspaceResult>;
    onExecute?: (params: PluginEnvironmentExecuteParams) => Promise<PluginEnvironmentExecuteResult>;
  };
}

/** Extended test harness with environment driver simulation. */
export interface EnvironmentTestHarness extends TestHarness {
  /** Recorded environment lifecycle events for assertion. */
  environmentEvents: EnvironmentEventRecord[];
  /** Invoke the environment driver's validateConfig hook. */
  validateConfig(params: PluginEnvironmentValidateConfigParams): Promise<PluginEnvironmentValidationResult>;
  /** Invoke the environment driver's probe hook. */
  probe(params: PluginEnvironmentProbeParams): Promise<PluginEnvironmentProbeResult>;
  /** Invoke the environment driver's acquireLease hook. */
  acquireLease(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease>;
  /** Invoke the environment driver's resumeLease hook. */
  resumeLease(params: PluginEnvironmentResumeLeaseParams): Promise<PluginEnvironmentLease>;
  /** Invoke the environment driver's releaseLease hook. */
  releaseLease(params: PluginEnvironmentReleaseLeaseParams): Promise<void>;
  /** Invoke the environment driver's destroyLease hook. */
  destroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<void>;
  /** Invoke the environment driver's realizeWorkspace hook. */
  realizeWorkspace(params: PluginEnvironmentRealizeWorkspaceParams): Promise<PluginEnvironmentRealizeWorkspaceResult>;
  /** Invoke the environment driver's execute hook. */
  execute(params: PluginEnvironmentExecuteParams): Promise<PluginEnvironmentExecuteResult>;
}

// ---------------------------------------------------------------------------
// Environment event assertion helpers
// ---------------------------------------------------------------------------

/** Filter environment events by type. */
export function filterEnvironmentEvents(
  events: EnvironmentEventRecord[],
  type: EnvironmentEventRecord["type"],
): EnvironmentEventRecord[] {
  return events.filter((e) => e.type === type);
}

/** Assert that environment events occurred in the expected order. */
export function assertEnvironmentEventOrder(
  events: EnvironmentEventRecord[],
  expectedOrder: EnvironmentEventRecord["type"][],
): void {
  const actual = events.map((e) => e.type);
  const matched: EnvironmentEventRecord["type"][] = [];
  let cursor = 0;
  for (const eventType of actual) {
    if (cursor < expectedOrder.length && eventType === expectedOrder[cursor]) {
      matched.push(eventType);
      cursor++;
    }
  }
  if (matched.length !== expectedOrder.length) {
    throw new Error(
      `Environment event order mismatch.\nExpected: ${JSON.stringify(expectedOrder)}\nActual:   ${JSON.stringify(actual)}`,
    );
  }
}

/** Assert that a full lease lifecycle (acquire → release) occurred for an environment. */
export function assertLeaseLifecycle(
  events: EnvironmentEventRecord[],
  environmentId: string,
): { acquire: EnvironmentEventRecord; release: EnvironmentEventRecord } {
  const acquire = events.find((e) => e.type === "acquireLease" && e.environmentId === environmentId);
  const release = events.find((e) => (e.type === "releaseLease" || e.type === "destroyLease") && e.environmentId === environmentId);
  if (!acquire) throw new Error(`No acquireLease event found for environment ${environmentId}`);
  if (!release) throw new Error(`No releaseLease/destroyLease event found for environment ${environmentId}`);
  if (acquire.timestamp > release.timestamp) {
    throw new Error(`acquireLease occurred after release for environment ${environmentId}`);
  }
  return { acquire, release };
}

/** Assert that workspace realization occurred between lease acquire and release. */
export function assertWorkspaceRealizationLifecycle(
  events: EnvironmentEventRecord[],
  environmentId: string,
): EnvironmentEventRecord {
  const lifecycle = assertLeaseLifecycle(events, environmentId);
  const realize = events.find(
    (e) => e.type === "realizeWorkspace" && e.environmentId === environmentId,
  );
  if (!realize) throw new Error(`No realizeWorkspace event found for environment ${environmentId}`);
  if (realize.timestamp < lifecycle.acquire.timestamp) {
    throw new Error(`realizeWorkspace occurred before acquireLease for environment ${environmentId}`);
  }
  if (realize.timestamp > lifecycle.release.timestamp) {
    throw new Error(`realizeWorkspace occurred after release for environment ${environmentId}`);
  }
  return realize;
}

/** Assert that an execute call occurred within the lease lifecycle. */
export function assertExecutionLifecycle(
  events: EnvironmentEventRecord[],
  environmentId: string,
): EnvironmentEventRecord[] {
  const lifecycle = assertLeaseLifecycle(events, environmentId);
  const execEvents = events.filter(
    (e) => e.type === "execute" && e.environmentId === environmentId,
  );
  if (execEvents.length === 0) {
    throw new Error(`No execute events found for environment ${environmentId}`);
  }
  for (const exec of execEvents) {
    if (exec.timestamp < lifecycle.acquire.timestamp || exec.timestamp > lifecycle.release.timestamp) {
      throw new Error(`Execute event occurred outside lease lifecycle for environment ${environmentId}`);
    }
  }
  return execEvents;
}

/** Assert that an event recorded an error. */
export function assertEnvironmentError(
  events: EnvironmentEventRecord[],
  type: EnvironmentEventRecord["type"],
  environmentId?: string,
): EnvironmentEventRecord {
  const match = events.find(
    (e) => e.type === type && e.error != null && (!environmentId || e.environmentId === environmentId),
  );
  if (!match) {
    throw new Error(`No error event of type '${type}'${environmentId ? ` for environment ${environmentId}` : ""}`);
  }
  return match;
}

// ---------------------------------------------------------------------------
// Fake environment plugin driver
// ---------------------------------------------------------------------------

/** Options for creating a fake environment driver for contract testing. */
export interface FakeEnvironmentDriverOptions {
  driverKey?: string;
  /** Simulated acquire delay in ms. */
  acquireDelayMs?: number;
  /** If true, probe will return `ok: false`. */
  probeFailure?: boolean;
  /** If true, acquireLease will throw. */
  acquireFailure?: string;
  /** If true, execute will return a non-zero exit code. */
  executeFailure?: boolean;
  /** Custom metadata returned on lease acquire. */
  leaseMetadata?: Record<string, unknown>;
}

/**
 * Create a fake environment driver suitable for contract testing.
 *
 * This returns a driver hooks object compatible with `EnvironmentTestHarnessOptions.environmentDriver`.
 * It simulates the full environment lifecycle with configurable failure injection.
 */
export function createFakeEnvironmentDriver(options: FakeEnvironmentDriverOptions = {}): EnvironmentTestHarnessOptions["environmentDriver"] {
  const driverKey = options.driverKey ?? "fake";
  const leases = new Map<string, { providerLeaseId: string; metadata: Record<string, unknown> }>();
  let leaseCounter = 0;

  return {
    driverKey,
    async onValidateConfig(params) {
      if (!params.config || typeof params.config !== "object") {
        return { ok: false, errors: ["Config must be an object"] };
      }
      return { ok: true, normalizedConfig: params.config };
    },
    async onProbe(_params) {
      if (options.probeFailure) {
        return { ok: false, summary: "Simulated probe failure", diagnostics: [{ severity: "error", message: "Probe failed" }] };
      }
      return { ok: true, summary: "Fake environment is healthy" };
    },
    async onAcquireLease(params) {
      if (options.acquireFailure) {
        throw new Error(options.acquireFailure);
      }
      if (options.acquireDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.acquireDelayMs));
      }
      const providerLeaseId = `fake-lease-${++leaseCounter}`;
      const metadata = { ...options.leaseMetadata, acquiredAt: new Date().toISOString(), runId: params.runId };
      leases.set(providerLeaseId, { providerLeaseId, metadata });
      return { providerLeaseId, metadata };
    },
    async onResumeLease(params) {
      const existing = leases.get(params.providerLeaseId);
      if (!existing) {
        throw new Error(`Lease ${params.providerLeaseId} not found — cannot resume`);
      }
      return { providerLeaseId: existing.providerLeaseId, metadata: { ...existing.metadata, resumed: true } };
    },
    async onReleaseLease(params) {
      if (params.providerLeaseId) {
        leases.delete(params.providerLeaseId);
      }
    },
    async onDestroyLease(params) {
      if (params.providerLeaseId) {
        leases.delete(params.providerLeaseId);
      }
    },
    async onRealizeWorkspace(params) {
      return {
        cwd: params.workspace.localPath ?? params.workspace.remotePath ?? "/tmp/fake-workspace",
        metadata: { realized: true },
      };
    },
    async onExecute(params) {
      if (options.executeFailure) {
        return { exitCode: 1, timedOut: false, stdout: "", stderr: "Simulated execution failure" };
      }
      return {
        exitCode: 0,
        timedOut: false,
        stdout: `Executed: ${params.command} ${(params.args ?? []).join(" ")}`.trim(),
        stderr: "",
      };
    },
  };
}

type EventRegistration = {
  name: PluginEventType | `plugin.${string}`;
  filter?: EventFilter;
  fn: (event: PluginEvent) => Promise<void>;
};

function normalizeScope(input: ScopeKey): Required<Pick<ScopeKey, "scopeKind" | "stateKey">> & Pick<ScopeKey, "scopeId" | "namespace"> {
  return {
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    namespace: input.namespace ?? "default",
    stateKey: input.stateKey,
  };
}

function stateMapKey(input: ScopeKey): string {
  const normalized = normalizeScope(input);
  return `${normalized.scopeKind}|${normalized.scopeId ?? ""}|${normalized.namespace}|${normalized.stateKey}`;
}

function allowsEvent(filter: EventFilter | undefined, event: PluginEvent): boolean {
  if (!filter) return true;
  if (filter.companyId && filter.companyId !== String((event.payload as Record<string, unknown> | undefined)?.companyId ?? "")) return false;
  if (filter.projectId && filter.projectId !== String((event.payload as Record<string, unknown> | undefined)?.projectId ?? "")) return false;
  if (filter.agentId && filter.agentId !== String((event.payload as Record<string, unknown> | undefined)?.agentId ?? "")) return false;
  return true;
}

function requireCapability(manifest: PaperclipPluginManifestV1, allowed: Set<PluginCapability>, capability: PluginCapability) {
  if (allowed.has(capability)) return;
  throw new Error(`Plugin '${manifest.id}' is missing required capability '${capability}' in test harness`);
}

function requireCompanyId(companyId?: string): string {
  if (!companyId) throw new Error("companyId is required for this operation");
  return companyId;
}

function isInCompany<T extends { companyId: string | null | undefined }>(
  record: T | null | undefined,
  companyId: string,
): record is T {
  return Boolean(record && record.companyId === companyId);
}

/**
 * Create an in-memory host harness for plugin worker tests.
 *
 * The harness enforces declared capabilities and simulates host APIs, so tests
 * can validate plugin behavior without spinning up the Paperclip server runtime.
 */
export function createTestHarness(options: TestHarnessOptions): TestHarness {
  const manifest = options.manifest;
  const capabilitySet = new Set(options.capabilities ?? manifest.capabilities);
  let currentConfig = { ...(options.config ?? {}) };

  const logs: TestHarnessLogEntry[] = [];
  const activity: TestHarness["activity"] = [];
  const metrics: TestHarness["metrics"] = [];
  const telemetry: TestHarness["telemetry"] = [];
  const dbQueries: TestHarness["dbQueries"] = [];
  const dbExecutes: TestHarness["dbExecutes"] = [];

  const state = new Map<string, unknown>();
  const entities = new Map<string, PluginEntityRecord>();
  const entityExternalIndex = new Map<string, string>();
  const companies = new Map<string, Company>();
  const projects = new Map<string, Project>();
  const issues = new Map<string, Issue>();
  const blockedByIssueIds = new Map<string, string[]>();
  const issueComments = new Map<string, IssueComment[]>();
  const issueInteractions = new Map<string, IssueThreadInteraction[]>();
  const issueDocuments = new Map<string, IssueDocument>();
  const agents = new Map<string, Agent>();
  const goals = new Map<string, Goal>();
  const projectWorkspaces = new Map<string, PluginWorkspace[]>();

  const sessions = new Map<string, AgentSession>();
  const sessionEventCallbacks = new Map<string, (event: AgentSessionEvent) => void>();

  const events: EventRegistration[] = [];
  const jobs = new Map<string, (job: PluginJobContext) => Promise<void>>();
  const launchers = new Map<string, PluginLauncherRegistration>();
  const dataHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const actionHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const toolHandlers = new Map<string, (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>>();

  function issueRelationSummary(issueId: string) {
    const issue = issues.get(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const summarize = (candidateId: string) => {
      const related = issues.get(candidateId);
      if (!related || related.companyId !== issue.companyId) return null;
      return {
        id: related.id,
        identifier: related.identifier,
        title: related.title,
        status: related.status,
        priority: related.priority,
        assigneeAgentId: related.assigneeAgentId,
        assigneeUserId: related.assigneeUserId,
      };
    };
    const blockedBy = (blockedByIssueIds.get(issueId) ?? [])
      .map(summarize)
      .filter((value): value is NonNullable<typeof value> => value !== null);
    const blocks = [...blockedByIssueIds.entries()]
      .filter(([, blockers]) => blockers.includes(issueId))
      .map(([blockedIssueId]) => summarize(blockedIssueId))
      .filter((value): value is NonNullable<typeof value> => value !== null);
    return { blockedBy, blocks };
  }

  const defaultPluginOriginKind: PluginIssueOriginKind = `plugin:${manifest.id}`;
  function normalizePluginOriginKind(originKind: unknown = defaultPluginOriginKind): PluginIssueOriginKind {
    if (originKind == null || originKind === "") return defaultPluginOriginKind;
    if (typeof originKind !== "string") throw new Error("Plugin issue originKind must be a string");
    if (originKind === defaultPluginOriginKind || originKind.startsWith(`${defaultPluginOriginKind}:`)) {
      return originKind as PluginIssueOriginKind;
    }
    throw new Error(`Plugin may only use originKind values under ${defaultPluginOriginKind}`);
  }

  const ctx: PluginContext = {
    manifest,
    config: {
      async get() {
        return { ...currentConfig };
      },
    },
    events: {
      on(name: PluginEventType | `plugin.${string}`, filterOrFn: EventFilter | ((event: PluginEvent) => Promise<void>), maybeFn?: (event: PluginEvent) => Promise<void>): () => void {
        requireCapability(manifest, capabilitySet, "events.subscribe");
        let registration: EventRegistration;
        if (typeof filterOrFn === "function") {
          registration = { name, fn: filterOrFn };
        } else {
          if (!maybeFn) throw new Error("event handler is required");
          registration = { name, filter: filterOrFn, fn: maybeFn };
        }
        events.push(registration);
        return () => {
          const idx = events.indexOf(registration);
          if (idx !== -1) events.splice(idx, 1);
        };
      },
      async emit(name, companyId, payload) {
        requireCapability(manifest, capabilitySet, "events.emit");
        await harness.emit(`plugin.${manifest.id}.${name}`, payload, { companyId });
      },
    },
    jobs: {
      register(key, fn) {
        requireCapability(manifest, capabilitySet, "jobs.schedule");
        jobs.set(key, fn);
      },
    },
    launchers: {
      register(launcher) {
        launchers.set(launcher.id, launcher);
      },
    },
    db: {
      namespace: manifest.database ? `test_${manifest.id.replace(/[^a-z0-9_]+/g, "_")}` : "",
      async query(sql, params) {
        requireCapability(manifest, capabilitySet, "database.namespace.read");
        dbQueries.push({ sql, params });
        return [];
      },
      async execute(sql, params) {
        requireCapability(manifest, capabilitySet, "database.namespace.write");
        dbExecutes.push({ sql, params });
        return { rowCount: 0 };
      },
    },
    http: {
      async fetch(url, init) {
        requireCapability(manifest, capabilitySet, "http.outbound");
        return fetch(url, init);
      },
    },
    secrets: {
      async resolve(secretRef) {
        requireCapability(manifest, capabilitySet, "secrets.read-ref");
        return `resolved:${secretRef}`;
      },
    },
    activity: {
      async log(entry) {
        requireCapability(manifest, capabilitySet, "activity.log.write");
        activity.push(entry);
      },
    },
    state: {
      async get(input) {
        requireCapability(manifest, capabilitySet, "plugin.state.read");
        return state.has(stateMapKey(input)) ? state.get(stateMapKey(input)) : null;
      },
      async set(input, value) {
        requireCapability(manifest, capabilitySet, "plugin.state.write");
        state.set(stateMapKey(input), value);
      },
      async delete(input) {
        requireCapability(manifest, capabilitySet, "plugin.state.write");
        state.delete(stateMapKey(input));
      },
    },
    entities: {
      async upsert(input: PluginEntityUpsert) {
        const externalKey = input.externalId
          ? `${input.entityType}|${input.scopeKind}|${input.scopeId ?? ""}|${input.externalId}`
          : null;
        const existingId = externalKey ? entityExternalIndex.get(externalKey) : undefined;
        const existing = existingId ? entities.get(existingId) : undefined;
        const now = new Date().toISOString();
        const previousExternalKey = existing?.externalId
          ? `${existing.entityType}|${existing.scopeKind}|${existing.scopeId ?? ""}|${existing.externalId}`
          : null;
        const record: PluginEntityRecord = existing
          ? {
            ...existing,
            entityType: input.entityType,
            scopeKind: input.scopeKind,
            scopeId: input.scopeId ?? null,
            externalId: input.externalId ?? null,
            title: input.title ?? null,
            status: input.status ?? null,
            data: input.data,
            updatedAt: now,
          }
          : {
            id: randomUUID(),
            entityType: input.entityType,
            scopeKind: input.scopeKind,
            scopeId: input.scopeId ?? null,
            externalId: input.externalId ?? null,
            title: input.title ?? null,
            status: input.status ?? null,
            data: input.data,
            createdAt: now,
            updatedAt: now,
          };
        entities.set(record.id, record);
        if (previousExternalKey && previousExternalKey !== externalKey) {
          entityExternalIndex.delete(previousExternalKey);
        }
        if (externalKey) entityExternalIndex.set(externalKey, record.id);
        return record;
      },
      async list(query) {
        let out = [...entities.values()];
        if (query.entityType) out = out.filter((r) => r.entityType === query.entityType);
        if (query.scopeKind) out = out.filter((r) => r.scopeKind === query.scopeKind);
        if (query.scopeId) out = out.filter((r) => r.scopeId === query.scopeId);
        if (query.externalId) out = out.filter((r) => r.externalId === query.externalId);
        if (query.offset) out = out.slice(query.offset);
        if (query.limit) out = out.slice(0, query.limit);
        return out;
      },
    },
    projects: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "projects.read");
        const companyId = requireCompanyId(input?.companyId);
        let out = [...projects.values()];
        out = out.filter((project) => project.companyId === companyId);
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(projectId, companyId) {
        requireCapability(manifest, capabilitySet, "projects.read");
        const project = projects.get(projectId);
        return isInCompany(project, companyId) ? project : null;
      },
      async listWorkspaces(projectId, companyId) {
        requireCapability(manifest, capabilitySet, "project.workspaces.read");
        if (!isInCompany(projects.get(projectId), companyId)) return [];
        return projectWorkspaces.get(projectId) ?? [];
      },
      async getPrimaryWorkspace(projectId, companyId) {
        requireCapability(manifest, capabilitySet, "project.workspaces.read");
        if (!isInCompany(projects.get(projectId), companyId)) return null;
        const workspaces = projectWorkspaces.get(projectId) ?? [];
        return workspaces.find((workspace) => workspace.isPrimary) ?? null;
      },
      async getWorkspaceForIssue(issueId, companyId) {
        requireCapability(manifest, capabilitySet, "project.workspaces.read");
        const issue = issues.get(issueId);
        if (!isInCompany(issue, companyId)) return null;
        const projectId = (issue as unknown as Record<string, unknown>)?.projectId as string | undefined;
        if (!projectId) return null;
        if (!isInCompany(projects.get(projectId), companyId)) return null;
        const workspaces = projectWorkspaces.get(projectId) ?? [];
        return workspaces.find((workspace) => workspace.isPrimary) ?? null;
      },
    },
    companies: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "companies.read");
        let out = [...companies.values()];
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(companyId) {
        requireCapability(manifest, capabilitySet, "companies.read");
        return companies.get(companyId) ?? null;
      },
    },
    issues: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "issues.read");
        const companyId = requireCompanyId(input?.companyId);
        let out = [...issues.values()];
        out = out.filter((issue) => issue.companyId === companyId);
        if (input?.projectId) out = out.filter((issue) => issue.projectId === input.projectId);
        if (input?.assigneeAgentId) out = out.filter((issue) => issue.assigneeAgentId === input.assigneeAgentId);
        if (input?.originKind) {
          if (input.originKind.startsWith("plugin:")) normalizePluginOriginKind(input.originKind);
          out = out.filter((issue) => issue.originKind === input.originKind);
        }
        if (input?.originId) out = out.filter((issue) => issue.originId === input.originId);
        if (input?.status) out = out.filter((issue) => issue.status === input.status);
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(issueId, companyId) {
        requireCapability(manifest, capabilitySet, "issues.read");
        const issue = issues.get(issueId);
        return isInCompany(issue, companyId) ? issue : null;
      },
      async create(input) {
        requireCapability(manifest, capabilitySet, "issues.create");
        const now = new Date();
        const record: Issue = {
          id: randomUUID(),
          companyId: input.companyId,
          projectId: input.projectId ?? null,
          projectWorkspaceId: null,
          goalId: input.goalId ?? null,
          parentId: input.parentId ?? null,
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? "todo",
          priority: input.priority ?? "medium",
          assigneeAgentId: input.assigneeAgentId ?? null,
          assigneeUserId: input.assigneeUserId ?? null,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          createdByAgentId: null,
          createdByUserId: null,
          issueNumber: null,
          identifier: null,
          originKind: normalizePluginOriginKind(input.originKind),
          originId: input.originId ?? null,
          originRunId: input.originRunId ?? null,
          requestDepth: input.requestDepth ?? 0,
          billingCode: input.billingCode ?? null,
          assigneeAdapterOverrides: null,
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          executionWorkspacePreference: input.executionWorkspacePreference ?? null,
          executionWorkspaceSettings: input.executionWorkspaceSettings ?? null,
          scheduledFor: null,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
          hiddenAt: null,
          createdAt: now,
          updatedAt: now,
        };
        issues.set(record.id, record);
        if (input.blockedByIssueIds) blockedByIssueIds.set(record.id, [...new Set(input.blockedByIssueIds)]);
        return record;
      },
      async update(issueId, patch, companyId) {
        requireCapability(manifest, capabilitySet, "issues.update");
        const record = issues.get(issueId);
        if (!isInCompany(record, companyId)) throw new Error(`Issue not found: ${issueId}`);
        const { blockedByIssueIds: nextBlockedByIssueIds, ...issuePatch } = patch;
        if (issuePatch.originKind !== undefined) {
          issuePatch.originKind = normalizePluginOriginKind(issuePatch.originKind);
        }
        const updated: Issue = {
          ...record,
          ...issuePatch,
          updatedAt: new Date(),
        };
        issues.set(issueId, updated);
        if (nextBlockedByIssueIds !== undefined) {
          blockedByIssueIds.set(issueId, [...new Set(nextBlockedByIssueIds)]);
        }
        return updated;
      },
      async assertCheckoutOwner(input) {
        requireCapability(manifest, capabilitySet, "issues.checkout");
        const record = issues.get(input.issueId);
        if (!isInCompany(record, input.companyId)) throw new Error(`Issue not found: ${input.issueId}`);
        if (
          record.status !== "in_progress" ||
          record.assigneeAgentId !== input.actorAgentId ||
          (record.checkoutRunId !== null && record.checkoutRunId !== input.actorRunId)
        ) {
          throw new Error("Issue run ownership conflict");
        }
        return {
          issueId: record.id,
          status: record.status,
          assigneeAgentId: record.assigneeAgentId,
          checkoutRunId: record.checkoutRunId,
          adoptedFromRunId: null,
        };
      },
      async requestWakeup(issueId, companyId) {
        requireCapability(manifest, capabilitySet, "issues.wakeup");
        const record = issues.get(issueId);
        if (!isInCompany(record, companyId)) throw new Error(`Issue not found: ${issueId}`);
        if (!record.assigneeAgentId) throw new Error("Issue has no assigned agent to wake");
        if (["backlog", "done", "cancelled"].includes(record.status)) {
          throw new Error(`Issue is not wakeable in status: ${record.status}`);
        }
        const unresolved = issueRelationSummary(issueId).blockedBy.filter((blocker) => blocker.status !== "done");
        if (unresolved.length > 0) throw new Error("Issue is blocked by unresolved blockers");
        return { queued: true, runId: randomUUID() };
      },
      async requestWakeups(issueIds, companyId) {
        requireCapability(manifest, capabilitySet, "issues.wakeup");
        const results = [];
        for (const issueId of issueIds) {
          const record = issues.get(issueId);
          if (!isInCompany(record, companyId)) throw new Error(`Issue not found: ${issueId}`);
          if (!record.assigneeAgentId) throw new Error("Issue has no assigned agent to wake");
          if (["backlog", "done", "cancelled"].includes(record.status)) {
            throw new Error(`Issue is not wakeable in status: ${record.status}`);
          }
          const unresolved = issueRelationSummary(issueId).blockedBy.filter((blocker) => blocker.status !== "done");
          if (unresolved.length > 0) throw new Error("Issue is blocked by unresolved blockers");
          results.push({ issueId, queued: true, runId: randomUUID() });
        }
        return results;
      },
      async listComments(issueId, companyId) {
        requireCapability(manifest, capabilitySet, "issue.comments.read");
        if (!isInCompany(issues.get(issueId), companyId)) return [];
        return issueComments.get(issueId) ?? [];
      },
      async createComment(issueId, body, companyId, options) {
        requireCapability(manifest, capabilitySet, "issue.comments.create");
        const parentIssue = issues.get(issueId);
        if (!isInCompany(parentIssue, companyId)) {
          throw new Error(`Issue not found: ${issueId}`);
        }
        const now = new Date();
        const comment: IssueComment = {
          id: randomUUID(),
          companyId: parentIssue.companyId,
          issueId,
          authorAgentId: options?.authorAgentId ?? null,
          authorUserId: null,
          body,
          createdAt: now,
          updatedAt: now,
        };
        const current = issueComments.get(issueId) ?? [];
        current.push(comment);
        issueComments.set(issueId, current);
        return comment;
      },
      async createInteraction(issueId, interaction, companyId, options) {
        requireCapability(manifest, capabilitySet, "issue.interactions.create");
        const parentIssue = issues.get(issueId);
        if (!isInCompany(parentIssue, companyId)) {
          throw new Error(`Issue not found: ${issueId}`);
        }
        const now = new Date();
        const current = issueInteractions.get(issueId) ?? [];
        if (interaction.idempotencyKey) {
          const existing = current.find((entry) => entry.idempotencyKey === interaction.idempotencyKey);
          if (existing) return existing;
        }
        const created: IssueThreadInteraction = {
          id: randomUUID(),
          companyId: parentIssue.companyId,
          issueId,
          kind: interaction.kind,
          status: "pending",
          continuationPolicy: interaction.continuationPolicy ?? "wake_assignee",
          idempotencyKey: interaction.idempotencyKey ?? null,
          sourceCommentId: interaction.sourceCommentId ?? null,
          sourceRunId: interaction.sourceRunId ?? null,
          title: interaction.title ?? null,
          summary: interaction.summary ?? null,
          createdByAgentId: options?.authorAgentId ?? null,
          createdByUserId: null,
          payload: interaction.payload,
          result: null,
          createdAt: now,
          updatedAt: now,
        } as IssueThreadInteraction;
        current.push(created);
        issueInteractions.set(issueId, current);
        return created;
      },
      async suggestTasks(issueId, interaction, companyId, options) {
        return this.createInteraction(issueId, { ...interaction, kind: "suggest_tasks" }, companyId, options) as Promise<any>;
      },
      async askUserQuestions(issueId, interaction, companyId, options) {
        return this.createInteraction(issueId, { ...interaction, kind: "ask_user_questions" }, companyId, options) as Promise<any>;
      },
      async requestConfirmation(issueId, interaction, companyId, options) {
        return this.createInteraction(issueId, { ...interaction, kind: "request_confirmation" }, companyId, options) as Promise<any>;
      },
      documents: {
        async list(issueId, companyId) {
          requireCapability(manifest, capabilitySet, "issue.documents.read");
          if (!isInCompany(issues.get(issueId), companyId)) return [];
          return [...issueDocuments.values()]
            .filter((document) => document.issueId === issueId && document.companyId === companyId)
            .map(({ body: _body, ...summary }) => summary);
        },
        async get(issueId, key, companyId) {
          requireCapability(manifest, capabilitySet, "issue.documents.read");
          if (!isInCompany(issues.get(issueId), companyId)) return null;
          return issueDocuments.get(`${issueId}|${key}`) ?? null;
        },
        async upsert(input) {
          requireCapability(manifest, capabilitySet, "issue.documents.write");
          const parentIssue = issues.get(input.issueId);
          if (!isInCompany(parentIssue, input.companyId)) {
            throw new Error(`Issue not found: ${input.issueId}`);
          }
          const now = new Date();
          const existing = issueDocuments.get(`${input.issueId}|${input.key}`);
          const document: IssueDocument = {
            id: existing?.id ?? randomUUID(),
            companyId: input.companyId,
            issueId: input.issueId,
            key: input.key,
            title: input.title ?? existing?.title ?? null,
            format: "markdown",
            latestRevisionId: randomUUID(),
            latestRevisionNumber: (existing?.latestRevisionNumber ?? 0) + 1,
            createdByAgentId: existing?.createdByAgentId ?? null,
            createdByUserId: existing?.createdByUserId ?? null,
            updatedByAgentId: null,
            updatedByUserId: null,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            body: input.body,
          };
          issueDocuments.set(`${input.issueId}|${input.key}`, document);
          return document;
        },
        async delete(issueId, _key, companyId) {
          requireCapability(manifest, capabilitySet, "issue.documents.write");
          const parentIssue = issues.get(issueId);
          if (!isInCompany(parentIssue, companyId)) {
            throw new Error(`Issue not found: ${issueId}`);
          }
          issueDocuments.delete(`${issueId}|${_key}`);
        },
      },
      relations: {
        async get(issueId, companyId) {
          requireCapability(manifest, capabilitySet, "issue.relations.read");
          if (!isInCompany(issues.get(issueId), companyId)) throw new Error(`Issue not found: ${issueId}`);
          return issueRelationSummary(issueId);
        },
        async setBlockedBy(issueId, nextBlockedByIssueIds, companyId) {
          requireCapability(manifest, capabilitySet, "issue.relations.write");
          if (!isInCompany(issues.get(issueId), companyId)) throw new Error(`Issue not found: ${issueId}`);
          blockedByIssueIds.set(issueId, [...new Set(nextBlockedByIssueIds)]);
          return issueRelationSummary(issueId);
        },
        async addBlockers(issueId, blockerIssueIds, companyId) {
          requireCapability(manifest, capabilitySet, "issue.relations.write");
          if (!isInCompany(issues.get(issueId), companyId)) throw new Error(`Issue not found: ${issueId}`);
          const next = new Set(blockedByIssueIds.get(issueId) ?? []);
          for (const blockerIssueId of blockerIssueIds) next.add(blockerIssueId);
          blockedByIssueIds.set(issueId, [...next]);
          return issueRelationSummary(issueId);
        },
        async removeBlockers(issueId, blockerIssueIds, companyId) {
          requireCapability(manifest, capabilitySet, "issue.relations.write");
          if (!isInCompany(issues.get(issueId), companyId)) throw new Error(`Issue not found: ${issueId}`);
          const removals = new Set(blockerIssueIds);
          blockedByIssueIds.set(
            issueId,
            (blockedByIssueIds.get(issueId) ?? []).filter((blockerIssueId) => !removals.has(blockerIssueId)),
          );
          return issueRelationSummary(issueId);
        },
      },
      async getSubtree(issueId, companyId, options) {
        requireCapability(manifest, capabilitySet, "issue.subtree.read");
        const root = issues.get(issueId);
        if (!isInCompany(root, companyId)) throw new Error(`Issue not found: ${issueId}`);
        const includeRoot = options?.includeRoot !== false;
        const allIds = [root.id];
        let frontier = [root.id];
        while (frontier.length > 0) {
          const children = [...issues.values()]
            .filter((issue) => issue.companyId === companyId && frontier.includes(issue.parentId ?? ""))
            .map((issue) => issue.id)
            .filter((id) => !allIds.includes(id));
          allIds.push(...children);
          frontier = children;
        }
        const issueIds = includeRoot ? allIds : allIds.filter((id) => id !== root.id);
        const subtreeIssues = issueIds.map((id) => issues.get(id)).filter((candidate): candidate is Issue => Boolean(candidate));
        return {
          rootIssueId: root.id,
          companyId,
          issueIds,
          issues: subtreeIssues,
          ...(options?.includeRelations
            ? { relations: Object.fromEntries(issueIds.map((id) => [id, issueRelationSummary(id)])) }
            : {}),
          ...(options?.includeDocuments ? { documents: Object.fromEntries(issueIds.map((id) => [id, []])) } : {}),
          ...(options?.includeActiveRuns ? { activeRuns: Object.fromEntries(issueIds.map((id) => [id, []])) } : {}),
          ...(options?.includeAssignees ? { assignees: {} } : {}),
        };
      },
      summaries: {
        async getOrchestration(input) {
          requireCapability(manifest, capabilitySet, "issues.orchestration.read");
          const root = issues.get(input.issueId);
          if (!isInCompany(root, input.companyId)) throw new Error(`Issue not found: ${input.issueId}`);
          const subtreeIssueIds = [root.id];
          if (input.includeSubtree) {
            let frontier = [root.id];
            while (frontier.length > 0) {
              const children = [...issues.values()]
                .filter((issue) => issue.companyId === input.companyId && frontier.includes(issue.parentId ?? ""))
                .map((issue) => issue.id)
                .filter((id) => !subtreeIssueIds.includes(id));
              subtreeIssueIds.push(...children);
              frontier = children;
            }
          }
          return {
            issueId: root.id,
            companyId: input.companyId,
            subtreeIssueIds,
            relations: Object.fromEntries(subtreeIssueIds.map((id) => [id, issueRelationSummary(id)])),
            approvals: [],
            runs: [],
            costs: {
              costCents: 0,
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              billingCode: input.billingCode ?? null,
            },
            openBudgetIncidents: [],
            invocationBlocks: [],
          };
        },
      },
    },
    agents: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "agents.read");
        const companyId = requireCompanyId(input?.companyId);
        let out = [...agents.values()];
        out = out.filter((agent) => agent.companyId === companyId);
        if (input?.status) out = out.filter((agent) => agent.status === input.status);
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(agentId, companyId) {
        requireCapability(manifest, capabilitySet, "agents.read");
        const agent = agents.get(agentId);
        return isInCompany(agent, companyId) ? agent : null;
      },
      async pause(agentId, companyId) {
        requireCapability(manifest, capabilitySet, "agents.pause");
        const cid = requireCompanyId(companyId);
        const agent = agents.get(agentId);
        if (!isInCompany(agent, cid)) throw new Error(`Agent not found: ${agentId}`);
        if (agent!.status === "terminated") throw new Error("Cannot pause terminated agent");
        const updated: Agent = { ...agent!, status: "paused", updatedAt: new Date() };
        agents.set(agentId, updated);
        return updated;
      },
      async resume(agentId, companyId) {
        requireCapability(manifest, capabilitySet, "agents.resume");
        const cid = requireCompanyId(companyId);
        const agent = agents.get(agentId);
        if (!isInCompany(agent, cid)) throw new Error(`Agent not found: ${agentId}`);
        if (agent!.status === "terminated") throw new Error("Cannot resume terminated agent");
        if (agent!.status === "pending_approval") throw new Error("Pending approval agents cannot be resumed");
        const updated: Agent = { ...agent!, status: "idle", updatedAt: new Date() };
        agents.set(agentId, updated);
        return updated;
      },
      async invoke(agentId, companyId, opts) {
        requireCapability(manifest, capabilitySet, "agents.invoke");
        const cid = requireCompanyId(companyId);
        const agent = agents.get(agentId);
        if (!isInCompany(agent, cid)) throw new Error(`Agent not found: ${agentId}`);
        if (
          agent!.status === "paused" ||
          agent!.status === "terminated" ||
          agent!.status === "pending_approval"
        ) {
          throw new Error(`Agent is not invokable in its current state: ${agent!.status}`);
        }
        return { runId: randomUUID() };
      },
      sessions: {
        async create(agentId, companyId, opts) {
          requireCapability(manifest, capabilitySet, "agent.sessions.create");
          const cid = requireCompanyId(companyId);
          const agent = agents.get(agentId);
          if (!isInCompany(agent, cid)) throw new Error(`Agent not found: ${agentId}`);
          const session: AgentSession = {
            sessionId: randomUUID(),
            agentId,
            companyId: cid,
            status: "active",
            createdAt: new Date().toISOString(),
          };
          sessions.set(session.sessionId, session);
          return session;
        },
        async list(agentId, companyId) {
          requireCapability(manifest, capabilitySet, "agent.sessions.list");
          const cid = requireCompanyId(companyId);
          return [...sessions.values()].filter(
            (s) => s.agentId === agentId && s.companyId === cid && s.status === "active",
          );
        },
        async sendMessage(sessionId, companyId, opts) {
          requireCapability(manifest, capabilitySet, "agent.sessions.send");
          const session = sessions.get(sessionId);
          if (!session || session.status !== "active") throw new Error(`Session not found or closed: ${sessionId}`);
          if (session.companyId !== companyId) throw new Error(`Session not found: ${sessionId}`);
          if (opts.onEvent) {
            sessionEventCallbacks.set(sessionId, opts.onEvent);
          }
          return { runId: randomUUID() };
        },
        async close(sessionId, companyId) {
          requireCapability(manifest, capabilitySet, "agent.sessions.close");
          const session = sessions.get(sessionId);
          if (!session) throw new Error(`Session not found: ${sessionId}`);
          if (session.companyId !== companyId) throw new Error(`Session not found: ${sessionId}`);
          session.status = "closed";
          sessionEventCallbacks.delete(sessionId);
        },
      },
    },
    goals: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "goals.read");
        const companyId = requireCompanyId(input?.companyId);
        let out = [...goals.values()];
        out = out.filter((goal) => goal.companyId === companyId);
        if (input?.level) out = out.filter((goal) => goal.level === input.level);
        if (input?.status) out = out.filter((goal) => goal.status === input.status);
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(goalId, companyId) {
        requireCapability(manifest, capabilitySet, "goals.read");
        const goal = goals.get(goalId);
        return isInCompany(goal, companyId) ? goal : null;
      },
      async create(input) {
        requireCapability(manifest, capabilitySet, "goals.create");
        const now = new Date();
        const record: Goal = {
          id: randomUUID(),
          companyId: input.companyId,
          title: input.title,
          description: input.description ?? null,
          level: input.level ?? "task",
          status: input.status ?? "planned",
          parentId: input.parentId ?? null,
          ownerAgentId: input.ownerAgentId ?? null,
          createdAt: now,
          updatedAt: now,
        };
        goals.set(record.id, record);
        return record;
      },
      async update(goalId, patch, companyId) {
        requireCapability(manifest, capabilitySet, "goals.update");
        const record = goals.get(goalId);
        if (!isInCompany(record, companyId)) throw new Error(`Goal not found: ${goalId}`);
        const updated: Goal = {
          ...record,
          ...patch,
          updatedAt: new Date(),
        };
        goals.set(goalId, updated);
        return updated;
      },
    },
    data: {
      register(key, handler) {
        dataHandlers.set(key, handler);
      },
    },
    actions: {
      register(key, handler) {
        actionHandlers.set(key, handler);
      },
    },
    streams: (() => {
      const channelCompanyMap = new Map<string, string>();
      return {
        open(channel: string, companyId: string) {
          channelCompanyMap.set(channel, companyId);
        },
        emit(_channel: string, _event: unknown) {
          // No-op in test harness — events are not forwarded
        },
        close(channel: string) {
          channelCompanyMap.delete(channel);
        },
      };
    })(),
    tools: {
      register(name, _decl, fn) {
        requireCapability(manifest, capabilitySet, "agent.tools.register");
        toolHandlers.set(name, fn);
      },
    },
    metrics: {
      async write(name, value, tags) {
        requireCapability(manifest, capabilitySet, "metrics.write");
        metrics.push({ name, value, tags });
      },
    },
    telemetry: {
      async track(eventName, dimensions) {
        requireCapability(manifest, capabilitySet, "telemetry.track");
        telemetry.push({ eventName, dimensions });
      },
    },
    logger: {
      info(message, meta) {
        logs.push({ level: "info", message, meta });
      },
      warn(message, meta) {
        logs.push({ level: "warn", message, meta });
      },
      error(message, meta) {
        logs.push({ level: "error", message, meta });
      },
      debug(message, meta) {
        logs.push({ level: "debug", message, meta });
      },
    },
  };

  const harness: TestHarness = {
    ctx,
    seed(input) {
      for (const row of input.companies ?? []) companies.set(row.id, row);
      for (const row of input.projects ?? []) projects.set(row.id, row);
      for (const row of input.issues ?? []) {
        issues.set(row.id, row);
        if (row.blockedBy) {
          blockedByIssueIds.set(row.id, row.blockedBy.map((blocker) => blocker.id));
        }
      }
      for (const row of input.issueComments ?? []) {
        const list = issueComments.get(row.issueId) ?? [];
        list.push(row);
        issueComments.set(row.issueId, list);
      }
      for (const row of input.agents ?? []) agents.set(row.id, row);
      for (const row of input.goals ?? []) goals.set(row.id, row);
    },
    setConfig(config) {
      currentConfig = { ...config };
    },
    async emit(eventType, payload, base) {
      const event: PluginEvent = {
        eventId: base?.eventId ?? randomUUID(),
        eventType,
        companyId: base?.companyId ?? "test-company",
        occurredAt: base?.occurredAt ?? new Date().toISOString(),
        actorId: base?.actorId,
        actorType: base?.actorType,
        entityId: base?.entityId,
        entityType: base?.entityType,
        payload,
      };

      for (const handler of events) {
        const exactMatch = handler.name === event.eventType;
        const wildcardPluginAll = handler.name === "plugin.*" && String(event.eventType).startsWith("plugin.");
        const wildcardPluginOne = String(handler.name).endsWith(".*")
          && String(event.eventType).startsWith(String(handler.name).slice(0, -1));
        if (!exactMatch && !wildcardPluginAll && !wildcardPluginOne) continue;
        if (!allowsEvent(handler.filter, event)) continue;
        await handler.fn(event);
      }
    },
    async runJob(jobKey, partial = {}) {
      const handler = jobs.get(jobKey);
      if (!handler) throw new Error(`No job handler registered for '${jobKey}'`);
      await handler({
        jobKey,
        runId: partial.runId ?? randomUUID(),
        trigger: partial.trigger ?? "manual",
        scheduledAt: partial.scheduledAt ?? new Date().toISOString(),
      });
    },
    async getData<T = unknown>(key: string, params: Record<string, unknown> = {}) {
      const handler = dataHandlers.get(key);
      if (!handler) throw new Error(`No data handler registered for '${key}'`);
      return await handler(params) as T;
    },
    async performAction<T = unknown>(key: string, params: Record<string, unknown> = {}) {
      const handler = actionHandlers.get(key);
      if (!handler) throw new Error(`No action handler registered for '${key}'`);
      return await handler(params) as T;
    },
    async executeTool<T = ToolResult>(name: string, params: unknown, runCtx: Partial<ToolRunContext> = {}) {
      const handler = toolHandlers.get(name);
      if (!handler) throw new Error(`No tool handler registered for '${name}'`);
      const ctxToPass: ToolRunContext = {
        agentId: runCtx.agentId ?? "agent-test",
        runId: runCtx.runId ?? randomUUID(),
        companyId: runCtx.companyId ?? "company-test",
        projectId: runCtx.projectId ?? "project-test",
      };
      return await handler(params, ctxToPass) as T;
    },
    getState(input) {
      return state.get(stateMapKey(input));
    },
    simulateSessionEvent(sessionId, event) {
      const cb = sessionEventCallbacks.get(sessionId);
      if (!cb) throw new Error(`No active session event callback for session: ${sessionId}`);
      cb({ ...event, sessionId });
    },
    logs,
    activity,
    metrics,
    telemetry,
    dbQueries,
    dbExecutes,
  };

  return harness;
}

/**
 * Create an environment-aware test harness that wraps the base harness with
 * environment driver simulation and lifecycle event recording.
 *
 * Use this to test environment plugins through the full host contract:
 * validateConfig → probe → acquireLease → realizeWorkspace → execute → releaseLease.
 */
export function createEnvironmentTestHarness(options: EnvironmentTestHarnessOptions): EnvironmentTestHarness {
  const base = createTestHarness(options);
  const environmentEvents: EnvironmentEventRecord[] = [];
  const driver = options.environmentDriver;

  function record(
    type: EnvironmentEventRecord["type"],
    params: Record<string, unknown>,
    result?: unknown,
    error?: string,
  ): EnvironmentEventRecord {
    const event: EnvironmentEventRecord = {
      type,
      driverKey: (params as { driverKey?: string }).driverKey ?? driver.driverKey,
      environmentId: (params as { environmentId?: string }).environmentId ?? "unknown",
      timestamp: new Date().toISOString(),
      params,
      result,
      error,
    };
    environmentEvents.push(event);
    return event;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function callHook<R>(
    type: EnvironmentEventRecord["type"],
    hook: ((...args: any[]) => Promise<R>) | undefined,
    params: unknown,
    hookName: string,
  ): Promise<R> {
    if (!hook) {
      const err = `Environment driver '${driver.driverKey}' does not implement ${hookName}`;
      record(type, params as Record<string, unknown>, undefined, err);
      throw new Error(err);
    }
    try {
      const result = await hook(params);
      record(type, params as Record<string, unknown>, result);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      record(type, params as Record<string, unknown>, undefined, msg);
      throw e;
    }
  }

  const envHarness: EnvironmentTestHarness = {
    ...base,
    environmentEvents,
    async validateConfig(params) {
      return callHook("validateConfig", driver.onValidateConfig, params, "onValidateConfig");
    },
    async probe(params) {
      return callHook("probe", driver.onProbe, params, "onProbe");
    },
    async acquireLease(params) {
      return callHook("acquireLease", driver.onAcquireLease, params, "onAcquireLease");
    },
    async resumeLease(params) {
      return callHook("resumeLease", driver.onResumeLease, params, "onResumeLease");
    },
    async releaseLease(params) {
      return callHook("releaseLease", driver.onReleaseLease, params, "onReleaseLease");
    },
    async destroyLease(params) {
      return callHook("destroyLease", driver.onDestroyLease, params, "onDestroyLease");
    },
    async realizeWorkspace(params) {
      return callHook("realizeWorkspace", driver.onRealizeWorkspace, params, "onRealizeWorkspace");
    },
    async execute(params) {
      return callHook("execute", driver.onExecute, params, "onExecute");
    },
  };

  return envHarness;
}
