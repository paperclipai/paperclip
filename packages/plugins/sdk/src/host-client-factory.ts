/**
 * Host-side client factory — creates capability-gated handler maps for
 * servicing worker→host JSON-RPC calls.
 *
 * When a plugin worker calls `ctx.state.get(...)` inside its process, the
 * SDK serializes the call as a JSON-RPC request over stdio. On the host side,
 * the `PluginWorkerManager` receives the request and dispatches it to the
 * handler registered for that method. This module provides a factory that
 * creates those handlers for all `WorkerToHostMethods`, with automatic
 * capability enforcement.
 *
 * ## Design
 *
 * 1. **Capability gating**: Each handler checks the plugin's declared
 *    capabilities before executing. If the plugin lacks a required capability,
 *    the handler throws a `CapabilityDeniedError` (which the worker manager
 *    translates into a JSON-RPC error response with code
 *    `CAPABILITY_DENIED`).
 *
 * 2. **Service adapters**: The caller provides a `HostServices` object with
 *    concrete implementations of each platform service. The factory wires
 *    each handler to the appropriate service method.
 *
 * 3. **Type safety**: The returned handler map is typed as
 *    `WorkerToHostHandlers` (from `plugin-worker-manager.ts`) so it plugs
 *    directly into `WorkerStartOptions.hostHandlers`.
 *
 * @example
 * ```ts
 * const handlers = createHostClientHandlers({
 *   pluginId: "acme.linear",
 *   capabilities: manifest.capabilities,
 *   services: {
 *     config:    { get: () => registry.getConfig(pluginId) },
 *     state:     { get: ..., set: ..., delete: ... },
 *     entities:  { upsert: ..., list: ... },
 *     // ... all services
 *   },
 * });
 *
 * await workerManager.startWorker("acme.linear", {
 *   // ...
 *   hostHandlers: handlers,
 * });
 * ```
 *
 * @see PLUGIN_SPEC.md §13 — Host-Worker Protocol
 * @see PLUGIN_SPEC.md §15 — Capability Model
 */

import type { PluginCapability } from "@paperclipai/shared";
import type { WorkerToHostMethods, WorkerToHostMethodName } from "./protocol.js";
import { PLUGIN_RPC_ERROR_CODES } from "./protocol.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when a plugin calls a host method it does not have the capability for.
 *
 * The `code` field is set to `PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED` so
 * the worker manager can propagate it as the correct JSON-RPC error code.
 */
export class CapabilityDeniedError extends Error {
  override readonly name = "CapabilityDeniedError";
  readonly code = PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED;

  constructor(pluginId: string, method: string, capability: PluginCapability) {
    super(
      `Plugin "${pluginId}" is missing required capability "${capability}" for method "${method}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Host service interfaces
// ---------------------------------------------------------------------------

/**
 * Service adapters that the host must provide. Each property maps to a group
 * of `WorkerToHostMethods`. The factory wires JSON-RPC params to these
 * function signatures.
 *
 * All methods return promises to support async I/O (database, HTTP, etc.).
 */
export interface HostServices {
  /** Provides `config.get`. */
  config: {
    get(): Promise<Record<string, unknown>>;
  };

  /** Provides trusted company-scoped local folder helpers. */
  localFolders: {
    declarations(params: WorkerToHostMethods["localFolders.declarations"][0]): Promise<WorkerToHostMethods["localFolders.declarations"][1]>;
    configure(params: WorkerToHostMethods["localFolders.configure"][0]): Promise<WorkerToHostMethods["localFolders.configure"][1]>;
    status(params: WorkerToHostMethods["localFolders.status"][0]): Promise<WorkerToHostMethods["localFolders.status"][1]>;
    list(params: WorkerToHostMethods["localFolders.list"][0]): Promise<WorkerToHostMethods["localFolders.list"][1]>;
    readText(params: WorkerToHostMethods["localFolders.readText"][0]): Promise<WorkerToHostMethods["localFolders.readText"][1]>;
    writeTextAtomic(params: WorkerToHostMethods["localFolders.writeTextAtomic"][0]): Promise<WorkerToHostMethods["localFolders.writeTextAtomic"][1]>;
    deleteFile(params: WorkerToHostMethods["localFolders.deleteFile"][0]): Promise<WorkerToHostMethods["localFolders.deleteFile"][1]>;
  };

  /** Provides `state.get`, `state.set`, `state.delete`. */
  state: {
    get(params: WorkerToHostMethods["state.get"][0]): Promise<WorkerToHostMethods["state.get"][1]>;
    set(params: WorkerToHostMethods["state.set"][0]): Promise<void>;
    delete(params: WorkerToHostMethods["state.delete"][0]): Promise<void>;
  };

  /** Provides restricted plugin database namespace methods. */
  db: {
    namespace(params: WorkerToHostMethods["db.namespace"][0]): Promise<WorkerToHostMethods["db.namespace"][1]>;
    query(params: WorkerToHostMethods["db.query"][0]): Promise<WorkerToHostMethods["db.query"][1]>;
    execute(params: WorkerToHostMethods["db.execute"][0]): Promise<WorkerToHostMethods["db.execute"][1]>;
  };

  /** Provides `entities.upsert`, `entities.list`. */
  entities: {
    upsert(params: WorkerToHostMethods["entities.upsert"][0]): Promise<WorkerToHostMethods["entities.upsert"][1]>;
    list(params: WorkerToHostMethods["entities.list"][0]): Promise<WorkerToHostMethods["entities.list"][1]>;
  };

  /** Provides `events.emit` and `events.subscribe`. */
  events: {
    emit(params: WorkerToHostMethods["events.emit"][0]): Promise<void>;
    subscribe(params: WorkerToHostMethods["events.subscribe"][0]): Promise<void>;
  };

  /** Provides `http.fetch`. */
  http: {
    fetch(params: WorkerToHostMethods["http.fetch"][0]): Promise<WorkerToHostMethods["http.fetch"][1]>;
  };

  /** Provides `secrets.resolve`. */
  secrets: {
    resolve(params: WorkerToHostMethods["secrets.resolve"][0]): Promise<string>;
  };

  /** Provides `activity.log`. */
  activity: {
    log(params: {
      companyId: string;
      message: string;
      entityType?: string;
      entityId?: string;
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };

  /** Provides `metrics.write`. */
  metrics: {
    write(params: WorkerToHostMethods["metrics.write"][0]): Promise<void>;
  };

  /** Provides `telemetry.track`. */
  telemetry: {
    track(params: WorkerToHostMethods["telemetry.track"][0]): Promise<void>;
  };

  /** Provides `log`. */
  logger: {
    log(params: WorkerToHostMethods["log"][0]): Promise<void>;
  };

  /** Provides `companies.list`, `companies.get`. */
  companies: {
    list(params: WorkerToHostMethods["companies.list"][0]): Promise<WorkerToHostMethods["companies.list"][1]>;
    get(params: WorkerToHostMethods["companies.get"][0]): Promise<WorkerToHostMethods["companies.get"][1]>;
  };

  /** Provides `projects.list`, `projects.get`, `projects.listWorkspaces`, `projects.getPrimaryWorkspace`, `projects.getWorkspaceForIssue`. */
  projects: {
    list(params: WorkerToHostMethods["projects.list"][0]): Promise<WorkerToHostMethods["projects.list"][1]>;
    get(params: WorkerToHostMethods["projects.get"][0]): Promise<WorkerToHostMethods["projects.get"][1]>;
    listWorkspaces(params: WorkerToHostMethods["projects.listWorkspaces"][0]): Promise<WorkerToHostMethods["projects.listWorkspaces"][1]>;
    getPrimaryWorkspace(params: WorkerToHostMethods["projects.getPrimaryWorkspace"][0]): Promise<WorkerToHostMethods["projects.getPrimaryWorkspace"][1]>;
    getWorkspaceForIssue(params: WorkerToHostMethods["projects.getWorkspaceForIssue"][0]): Promise<WorkerToHostMethods["projects.getWorkspaceForIssue"][1]>;
    getManaged(params: WorkerToHostMethods["projects.managed.get"][0]): Promise<WorkerToHostMethods["projects.managed.get"][1]>;
    reconcileManaged(params: WorkerToHostMethods["projects.managed.reconcile"][0]): Promise<WorkerToHostMethods["projects.managed.reconcile"][1]>;
    resetManaged(params: WorkerToHostMethods["projects.managed.reset"][0]): Promise<WorkerToHostMethods["projects.managed.reset"][1]>;
  };

  /** Provides `routines.managed.*`. */
  routines: {
    managedGet(params: WorkerToHostMethods["routines.managed.get"][0]): Promise<WorkerToHostMethods["routines.managed.get"][1]>;
    managedReconcile(params: WorkerToHostMethods["routines.managed.reconcile"][0]): Promise<WorkerToHostMethods["routines.managed.reconcile"][1]>;
    managedReset(params: WorkerToHostMethods["routines.managed.reset"][0]): Promise<WorkerToHostMethods["routines.managed.reset"][1]>;
    managedUpdate(params: WorkerToHostMethods["routines.managed.update"][0]): Promise<WorkerToHostMethods["routines.managed.update"][1]>;
    managedRun(params: WorkerToHostMethods["routines.managed.run"][0]): Promise<WorkerToHostMethods["routines.managed.run"][1]>;
  };

  /** Provides `skills.managed.*`. */
  skills: {
    managedGet(params: WorkerToHostMethods["skills.managed.get"][0]): Promise<WorkerToHostMethods["skills.managed.get"][1]>;
    managedReconcile(params: WorkerToHostMethods["skills.managed.reconcile"][0]): Promise<WorkerToHostMethods["skills.managed.reconcile"][1]>;
    managedReset(params: WorkerToHostMethods["skills.managed.reset"][0]): Promise<WorkerToHostMethods["skills.managed.reset"][1]>;
  };

  /** Provides issue read/write, relation, checkout, wakeup, summary, comment methods. */
  issues: {
    list(params: WorkerToHostMethods["issues.list"][0]): Promise<WorkerToHostMethods["issues.list"][1]>;
    get(params: WorkerToHostMethods["issues.get"][0]): Promise<WorkerToHostMethods["issues.get"][1]>;
    create(params: WorkerToHostMethods["issues.create"][0]): Promise<WorkerToHostMethods["issues.create"][1]>;
    update(params: WorkerToHostMethods["issues.update"][0]): Promise<WorkerToHostMethods["issues.update"][1]>;
    getRelations(params: WorkerToHostMethods["issues.relations.get"][0]): Promise<WorkerToHostMethods["issues.relations.get"][1]>;
    setBlockedBy(params: WorkerToHostMethods["issues.relations.setBlockedBy"][0]): Promise<WorkerToHostMethods["issues.relations.setBlockedBy"][1]>;
    addBlockers(params: WorkerToHostMethods["issues.relations.addBlockers"][0]): Promise<WorkerToHostMethods["issues.relations.addBlockers"][1]>;
    removeBlockers(params: WorkerToHostMethods["issues.relations.removeBlockers"][0]): Promise<WorkerToHostMethods["issues.relations.removeBlockers"][1]>;
    assertCheckoutOwner(params: WorkerToHostMethods["issues.assertCheckoutOwner"][0]): Promise<WorkerToHostMethods["issues.assertCheckoutOwner"][1]>;
    getSubtree(params: WorkerToHostMethods["issues.getSubtree"][0]): Promise<WorkerToHostMethods["issues.getSubtree"][1]>;
    requestWakeup(params: WorkerToHostMethods["issues.requestWakeup"][0]): Promise<WorkerToHostMethods["issues.requestWakeup"][1]>;
    requestWakeups(params: WorkerToHostMethods["issues.requestWakeups"][0]): Promise<WorkerToHostMethods["issues.requestWakeups"][1]>;
    getOrchestrationSummary(params: WorkerToHostMethods["issues.summaries.getOrchestration"][0]): Promise<WorkerToHostMethods["issues.summaries.getOrchestration"][1]>;
    listComments(params: WorkerToHostMethods["issues.listComments"][0]): Promise<WorkerToHostMethods["issues.listComments"][1]>;
    createComment(params: WorkerToHostMethods["issues.createComment"][0]): Promise<WorkerToHostMethods["issues.createComment"][1]>;
    createInteraction(params: WorkerToHostMethods["issues.createInteraction"][0]): Promise<WorkerToHostMethods["issues.createInteraction"][1]>;
  };

  /** Provides `issues.documents.list`, `issues.documents.get`, `issues.documents.upsert`, `issues.documents.delete`. */
  issueDocuments: {
    list(params: WorkerToHostMethods["issues.documents.list"][0]): Promise<WorkerToHostMethods["issues.documents.list"][1]>;
    get(params: WorkerToHostMethods["issues.documents.get"][0]): Promise<WorkerToHostMethods["issues.documents.get"][1]>;
    upsert(params: WorkerToHostMethods["issues.documents.upsert"][0]): Promise<WorkerToHostMethods["issues.documents.upsert"][1]>;
    delete(params: WorkerToHostMethods["issues.documents.delete"][0]): Promise<WorkerToHostMethods["issues.documents.delete"][1]>;
  };

  /** Provides `agents.list`, `agents.get`, `agents.pause`, `agents.resume`, `agents.invoke`. */
  agents: {
    list(params: WorkerToHostMethods["agents.list"][0]): Promise<WorkerToHostMethods["agents.list"][1]>;
    get(params: WorkerToHostMethods["agents.get"][0]): Promise<WorkerToHostMethods["agents.get"][1]>;
    pause(params: WorkerToHostMethods["agents.pause"][0]): Promise<WorkerToHostMethods["agents.pause"][1]>;
    resume(params: WorkerToHostMethods["agents.resume"][0]): Promise<WorkerToHostMethods["agents.resume"][1]>;
    invoke(params: WorkerToHostMethods["agents.invoke"][0]): Promise<WorkerToHostMethods["agents.invoke"][1]>;
    managedGet(params: WorkerToHostMethods["agents.managed.get"][0]): Promise<WorkerToHostMethods["agents.managed.get"][1]>;
    managedReconcile(params: WorkerToHostMethods["agents.managed.reconcile"][0]): Promise<WorkerToHostMethods["agents.managed.reconcile"][1]>;
    managedReset(params: WorkerToHostMethods["agents.managed.reset"][0]): Promise<WorkerToHostMethods["agents.managed.reset"][1]>;
  };

  /** Provides `agents.sessions.create`, `agents.sessions.list`, `agents.sessions.sendMessage`, `agents.sessions.close`. */
  agentSessions: {
    create(params: WorkerToHostMethods["agents.sessions.create"][0]): Promise<WorkerToHostMethods["agents.sessions.create"][1]>;
    list(params: WorkerToHostMethods["agents.sessions.list"][0]): Promise<WorkerToHostMethods["agents.sessions.list"][1]>;
    sendMessage(params: WorkerToHostMethods["agents.sessions.sendMessage"][0]): Promise<WorkerToHostMethods["agents.sessions.sendMessage"][1]>;
    close(params: WorkerToHostMethods["agents.sessions.close"][0]): Promise<void>;
  };

  /** Provides `goals.list`, `goals.get`, `goals.create`, `goals.update`. */
  goals: {
    list(params: WorkerToHostMethods["goals.list"][0]): Promise<WorkerToHostMethods["goals.list"][1]>;
    get(params: WorkerToHostMethods["goals.get"][0]): Promise<WorkerToHostMethods["goals.get"][1]>;
    create(params: WorkerToHostMethods["goals.create"][0]): Promise<WorkerToHostMethods["goals.create"][1]>;
    update(params: WorkerToHostMethods["goals.update"][0]): Promise<WorkerToHostMethods["goals.update"][1]>;
  };
}

// ---------------------------------------------------------------------------
// Factory input
// ---------------------------------------------------------------------------

/**
 * Options for `createHostClientHandlers`.
 */
export interface HostClientFactoryOptions {
  /** The plugin ID. Used for error messages and logging. */
  pluginId: string;

  /**
   * The capabilities declared by the plugin in its manifest. The factory
   * enforces these at runtime before delegating to the service adapter.
   */
  capabilities: readonly PluginCapability[];

  /**
   * Concrete implementations of host platform services. Each handler in the
   * returned map delegates to the corresponding service method.
   */
  services: HostServices;
}

// ---------------------------------------------------------------------------
// Handler map type (compatible with WorkerToHostHandlers from worker manager)
// ---------------------------------------------------------------------------

/**
 * A handler function for a specific worker→host method.
 */
type HostHandler<M extends WorkerToHostMethodName> = (
  params: WorkerToHostMethods[M][0],
) => Promise<WorkerToHostMethods[M][1]>;

/**
 * A complete map of all worker→host method handlers.
 *
 * This type matches `WorkerToHostHandlers` from `plugin-worker-manager.ts`
 * but makes every handler required (the factory always provides all handlers).
 */
export type HostClientHandlers = {
  [M in WorkerToHostMethodName]: HostHandler<M>;
};

// ---------------------------------------------------------------------------
// Capability → method mapping
// ---------------------------------------------------------------------------

/**
 * Maps each worker→host RPC method to the capability required to invoke it.
 * Methods without a capability requirement (e.g. `config.get`, `log`) are
 * mapped to `null`.
 *
 * @see PLUGIN_SPEC.md §15 — Capability Model
 */
const METHOD_CAPABILITY_MAP: Record<WorkerToHostMethodName, PluginCapability | null> = {
  // Config — always allowed
  "config.get": null,

  // Trusted local folders
  "localFolders.declarations": null,
  "localFolders.configure": "local.folders",
  "localFolders.status": "local.folders",
  "localFolders.list": "local.folders",
  "localFolders.readText": "local.folders",
  "localFolders.writeTextAtomic": "local.folders",
  "localFolders.deleteFile": "local.folders",

  // State
  "state.get": "plugin.state.read",
  "state.set": "plugin.state.write",
  "state.delete": "plugin.state.write",

  "db.namespace": "database.namespace.read",
  "db.query": "database.namespace.read",
  "db.execute": "database.namespace.write",

  // Entities — no specific capability required (plugin-scoped by design)
  "entities.upsert": null,
  "entities.list": null,

  // Events
  "events.emit": "events.emit",
  "events.subscribe": "events.subscribe",

  // HTTP
  "http.fetch": "http.outbound",

  // Secrets
  "secrets.resolve": "secrets.read-ref",

  // Activity
  "activity.log": "activity.log.write",

  // Metrics
  "metrics.write": "metrics.write",

  // Telemetry
  "telemetry.track": "telemetry.track",

  // Logger — always allowed
  "log": null,

  // Companies
  "companies.list": "companies.read",
  "companies.get": "companies.read",

  // Projects
  "projects.list": "projects.read",
  "projects.get": "projects.read",
  "projects.listWorkspaces": "project.workspaces.read",
  "projects.getPrimaryWorkspace": "project.workspaces.read",
  "projects.getWorkspaceForIssue": "project.workspaces.read",
  "projects.managed.get": "projects.managed",
  "projects.managed.reconcile": "projects.managed",
    "projects.managed.reset": "projects.managed",
    "routines.managed.get": "routines.managed",
    "routines.managed.reconcile": "routines.managed",
    "routines.managed.reset": "routines.managed",
    "routines.managed.update": "routines.managed",
    "routines.managed.run": "routines.managed",
    "skills.managed.get": "skills.managed",
    "skills.managed.reconcile": "skills.managed",
    "skills.managed.reset": "skills.managed",

  // Issues
  "issues.list": "issues.read",
  "issues.get": "issues.read",
  "issues.create": "issues.create",
  "issues.update": "issues.update",
  "issues.relations.get": "issue.relations.read",
  "issues.relations.setBlockedBy": "issue.relations.write",
  "issues.relations.addBlockers": "issue.relations.write",
  "issues.relations.removeBlockers": "issue.relations.write",
  "issues.assertCheckoutOwner": "issues.checkout",
  "issues.getSubtree": "issue.subtree.read",
  "issues.requestWakeup": "issues.wakeup",
  "issues.requestWakeups": "issues.wakeup",
  "issues.summaries.getOrchestration": "issues.orchestration.read",
  "issues.listComments": "issue.comments.read",
  "issues.createComment": "issue.comments.create",
  "issues.createInteraction": "issue.interactions.create",

  // Issue Documents
  "issues.documents.list": "issue.documents.read",
  "issues.documents.get": "issue.documents.read",
  "issues.documents.upsert": "issue.documents.write",
  "issues.documents.delete": "issue.documents.write",

  // Agents
  "agents.list": "agents.read",
  "agents.get": "agents.read",
  "agents.pause": "agents.pause",
  "agents.resume": "agents.resume",
  "agents.invoke": "agents.invoke",
  "agents.managed.get": "agents.managed",
  "agents.managed.reconcile": "agents.managed",
  "agents.managed.reset": "agents.managed",

  // Agent Sessions
  "agents.sessions.create": "agent.sessions.create",
  "agents.sessions.list": "agent.sessions.list",
  "agents.sessions.sendMessage": "agent.sessions.send",
  "agents.sessions.close": "agent.sessions.close",

  // Goals
  "goals.list": "goals.read",
  "goals.get": "goals.read",
  "goals.create": "goals.create",
  "goals.update": "goals.update",
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a complete handler map for all worker→host JSON-RPC methods.
 *
 * Each handler:
 * 1. Checks the plugin's declared capabilities against the required capability
 *    for the method (if any).
 * 2. Delegates to the corresponding service adapter method.
 * 3. Returns the service result, which is serialized as the JSON-RPC response
 *    by the worker manager.
 *
 * If a capability check fails, the handler throws a `CapabilityDeniedError`
 * with code `CAPABILITY_DENIED`. The worker manager catches this and sends a
 * JSON-RPC error response to the worker, which surfaces as a `JsonRpcCallError`
 * in the plugin's SDK client.
 *
 * @param options - Plugin ID, capabilities, and service adapters
 * @returns A handler map suitable for `WorkerStartOptions.hostHandlers`
 */
export function createHostClientHandlers(
  options: HostClientFactoryOptions,
): HostClientHandlers {
  const { pluginId, services } = options;
  const capabilitySet = new Set<PluginCapability>(options.capabilities);

  /**
   * Assert that the plugin has the required capability for a method.
   * Throws `CapabilityDeniedError` if the capability is missing.
   */
  function requireCapability(
    method: WorkerToHostMethodName,
  ): void {
    const required = METHOD_CAPABILITY_MAP[method];
    if (required === null) return; // No capability required
    if (capabilitySet.has(required)) return;
    throw new CapabilityDeniedError(pluginId, method, required);
  }

  /**
   * Create a capability-gated proxy handler for a method.
   *
   * @param method - The RPC method name (used for capability lookup)
   * @param handler - The actual handler implementation
   * @returns A wrapper that checks capabilities before delegating
   */
  function gated<M extends WorkerToHostMethodName>(
    method: M,
    handler: HostHandler<M>,
  ): HostHandler<M> {
    return async (params: WorkerToHostMethods[M][0]) => {
      requireCapability(method);
      return handler(params);
    };
  }

  // -------------------------------------------------------------------------
  // Build the complete handler map
  // -------------------------------------------------------------------------

  return {
    // Config
    "config.get": gated("config.get", async () => {
      return services.config.get();
    }),

    "localFolders.declarations": gated("localFolders.declarations", async (params) => {
      return services.localFolders.declarations(params);
    }),
    "localFolders.configure": gated("localFolders.configure", async (params) => {
      return services.localFolders.configure(params);
    }),
    "localFolders.status": gated("localFolders.status", async (params) => {
      return services.localFolders.status(params);
    }),
    "localFolders.list": gated("localFolders.list", async (params) => {
      return services.localFolders.list(params);
    }),
    "localFolders.readText": gated("localFolders.readText", async (params) => {
      return services.localFolders.readText(params);
    }),
    "localFolders.writeTextAtomic": gated("localFolders.writeTextAtomic", async (params) => {
      return services.localFolders.writeTextAtomic(params);
    }),
    "localFolders.deleteFile": gated("localFolders.deleteFile", async (params) => {
      return services.localFolders.deleteFile(params);
    }),

    // State
    "state.get": gated("state.get", async (params) => {
      return services.state.get(params);
    }),
    "state.set": gated("state.set", async (params) => {
      return services.state.set(params);
    }),
    "state.delete": gated("state.delete", async (params) => {
      return services.state.delete(params);
    }),

    "db.namespace": gated("db.namespace", async (params) => {
      return services.db.namespace(params);
    }),
    "db.query": gated("db.query", async (params) => {
      return services.db.query(params);
    }),
    "db.execute": gated("db.execute", async (params) => {
      return services.db.execute(params);
    }),

    // Entities
    "entities.upsert": gated("entities.upsert", async (params) => {
      return services.entities.upsert(params);
    }),
    "entities.list": gated("entities.list", async (params) => {
      return services.entities.list(params);
    }),

    // Events
    "events.emit": gated("events.emit", async (params) => {
      return services.events.emit(params);
    }),
    "events.subscribe": gated("events.subscribe", async (params) => {
      return services.events.subscribe(params);
    }),

    // HTTP
    "http.fetch": gated("http.fetch", async (params) => {
      return services.http.fetch(params);
    }),

    // Secrets
    "secrets.resolve": gated("secrets.resolve", async (params) => {
      return services.secrets.resolve(params);
    }),

    // Activity
    "activity.log": gated("activity.log", async (params) => {
      return services.activity.log(params);
    }),

    // Metrics
    "metrics.write": gated("metrics.write", async (params) => {
      return services.metrics.write(params);
    }),

    // Telemetry
    "telemetry.track": gated("telemetry.track", async (params) => {
      return services.telemetry.track(params);
    }),

    // Logger
    "log": gated("log", async (params) => {
      return services.logger.log(params);
    }),

    // Companies
    "companies.list": gated("companies.list", async (params) => {
      return services.companies.list(params);
    }),
    "companies.get": gated("companies.get", async (params) => {
      return services.companies.get(params);
    }),

    // Projects
    "projects.list": gated("projects.list", async (params) => {
      return services.projects.list(params);
    }),
    "projects.get": gated("projects.get", async (params) => {
      return services.projects.get(params);
    }),
    "projects.listWorkspaces": gated("projects.listWorkspaces", async (params) => {
      return services.projects.listWorkspaces(params);
    }),
    "projects.getPrimaryWorkspace": gated("projects.getPrimaryWorkspace", async (params) => {
      return services.projects.getPrimaryWorkspace(params);
    }),
    "projects.getWorkspaceForIssue": gated("projects.getWorkspaceForIssue", async (params) => {
      return services.projects.getWorkspaceForIssue(params);
    }),
    "projects.managed.get": gated("projects.managed.get", async (params) => {
      return services.projects.getManaged(params);
    }),
    "projects.managed.reconcile": gated("projects.managed.reconcile", async (params) => {
      return services.projects.reconcileManaged(params);
    }),
    "projects.managed.reset": gated("projects.managed.reset", async (params) => {
      return services.projects.resetManaged(params);
    }),

    // Routines
    "routines.managed.get": gated("routines.managed.get", async (params) => {
      return services.routines.managedGet(params);
    }),
    "routines.managed.reconcile": gated("routines.managed.reconcile", async (params) => {
      return services.routines.managedReconcile(params);
    }),
    "routines.managed.reset": gated("routines.managed.reset", async (params) => {
      return services.routines.managedReset(params);
    }),
    "routines.managed.update": gated("routines.managed.update", async (params) => {
      return services.routines.managedUpdate(params);
    }),
    "routines.managed.run": gated("routines.managed.run", async (params) => {
      return services.routines.managedRun(params);
    }),

    // Skills
    "skills.managed.get": gated("skills.managed.get", async (params) => {
      return services.skills.managedGet(params);
    }),
    "skills.managed.reconcile": gated("skills.managed.reconcile", async (params) => {
      return services.skills.managedReconcile(params);
    }),
    "skills.managed.reset": gated("skills.managed.reset", async (params) => {
      return services.skills.managedReset(params);
    }),

    // Issues
    "issues.list": gated("issues.list", async (params) => {
      return services.issues.list(params);
    }),
    "issues.get": gated("issues.get", async (params) => {
      return services.issues.get(params);
    }),
    "issues.create": gated("issues.create", async (params) => {
      return services.issues.create(params);
    }),
    "issues.update": gated("issues.update", async (params) => {
      return services.issues.update(params);
    }),
    "issues.relations.get": gated("issues.relations.get", async (params) => {
      return services.issues.getRelations(params);
    }),
    "issues.relations.setBlockedBy": gated("issues.relations.setBlockedBy", async (params) => {
      return services.issues.setBlockedBy(params);
    }),
    "issues.relations.addBlockers": gated("issues.relations.addBlockers", async (params) => {
      return services.issues.addBlockers(params);
    }),
    "issues.relations.removeBlockers": gated("issues.relations.removeBlockers", async (params) => {
      return services.issues.removeBlockers(params);
    }),
    "issues.assertCheckoutOwner": gated("issues.assertCheckoutOwner", async (params) => {
      return services.issues.assertCheckoutOwner(params);
    }),
    "issues.getSubtree": gated("issues.getSubtree", async (params) => {
      return services.issues.getSubtree(params);
    }),
    "issues.requestWakeup": gated("issues.requestWakeup", async (params) => {
      return services.issues.requestWakeup(params);
    }),
    "issues.requestWakeups": gated("issues.requestWakeups", async (params) => {
      return services.issues.requestWakeups(params);
    }),
    "issues.summaries.getOrchestration": gated("issues.summaries.getOrchestration", async (params) => {
      return services.issues.getOrchestrationSummary(params);
    }),
    "issues.listComments": gated("issues.listComments", async (params) => {
      return services.issues.listComments(params);
    }),
    "issues.createComment": gated("issues.createComment", async (params) => {
      return services.issues.createComment(params);
    }),
    "issues.createInteraction": gated("issues.createInteraction", async (params) => {
      return services.issues.createInteraction(params);
    }),

    // Issue Documents
    "issues.documents.list": gated("issues.documents.list", async (params) => {
      return services.issueDocuments.list(params);
    }),
    "issues.documents.get": gated("issues.documents.get", async (params) => {
      return services.issueDocuments.get(params);
    }),
    "issues.documents.upsert": gated("issues.documents.upsert", async (params) => {
      return services.issueDocuments.upsert(params);
    }),
    "issues.documents.delete": gated("issues.documents.delete", async (params) => {
      return services.issueDocuments.delete(params);
    }),

    // Agents
    "agents.list": gated("agents.list", async (params) => {
      return services.agents.list(params);
    }),
    "agents.get": gated("agents.get", async (params) => {
      return services.agents.get(params);
    }),
    "agents.pause": gated("agents.pause", async (params) => {
      return services.agents.pause(params);
    }),
    "agents.resume": gated("agents.resume", async (params) => {
      return services.agents.resume(params);
    }),
    "agents.invoke": gated("agents.invoke", async (params) => {
      return services.agents.invoke(params);
    }),
    "agents.managed.get": gated("agents.managed.get", async (params) => {
      return services.agents.managedGet(params);
    }),
    "agents.managed.reconcile": gated("agents.managed.reconcile", async (params) => {
      return services.agents.managedReconcile(params);
    }),
    "agents.managed.reset": gated("agents.managed.reset", async (params) => {
      return services.agents.managedReset(params);
    }),

    // Agent Sessions
    "agents.sessions.create": gated("agents.sessions.create", async (params) => {
      return services.agentSessions.create(params);
    }),
    "agents.sessions.list": gated("agents.sessions.list", async (params) => {
      return services.agentSessions.list(params);
    }),
    "agents.sessions.sendMessage": gated("agents.sessions.sendMessage", async (params) => {
      return services.agentSessions.sendMessage(params);
    }),
    "agents.sessions.close": gated("agents.sessions.close", async (params) => {
      return services.agentSessions.close(params);
    }),

    // Goals
    "goals.list": gated("goals.list", async (params) => {
      return services.goals.list(params);
    }),
    "goals.get": gated("goals.get", async (params) => {
      return services.goals.get(params);
    }),
    "goals.create": gated("goals.create", async (params) => {
      return services.goals.create(params);
    }),
    "goals.update": gated("goals.update", async (params) => {
      return services.goals.update(params);
    }),
  };
}

// ---------------------------------------------------------------------------
// Utility: getRequiredCapability
// ---------------------------------------------------------------------------

/**
 * Get the capability required for a given worker→host method, or `null` if
 * no capability is required.
 *
 * Useful for inspecting capability requirements without calling the factory.
 *
 * @param method - The worker→host method name
 * @returns The required capability, or `null`
 */
export function getRequiredCapability(
  method: WorkerToHostMethodName,
): PluginCapability | null {
  return METHOD_CAPABILITY_MAP[method];
}
