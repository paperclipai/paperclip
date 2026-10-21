import { AsyncLocalStorage } from "node:async_hooks";
import { EXECUTION_PREPARATION_SPAN_ATTRS, runWithRuntimeParent } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import { createHash } from "node:crypto";
import { isSpanContextValid, ROOT_CONTEXT, SpanStatusCode, trace, type Context } from "@opentelemetry/api";

type PreparationPhase = "environment_selection" | "execution_configuration" | "session"
  | "workspace" | "github_environment" | "github_launchers" | "run_output"
  | "workspace_validation" | "runtime_services" | "instructions" | "runtime_selection"
  | "configuration_mentions" | "configuration_github_identity" | "configuration_secrets"
  | "configuration_ai_runtime" | "configuration_skills" | "configuration_connector_assignments"
  | "configuration_connector_skills" | "configuration_connector_delivery"
  | "configuration_connection_instructions" | "configuration_agent_identity"
  | "workspace_source_resolution"
  | "workspace_provision_policy"
  | "workspace_base_validation"
  | "workspace_source_authorization"
  | "workspace_source_materialize"
  | "workspace_ownership_read"
  | "workspace_environment_acquire"
  | "workspace_environment_realize"
  | "workspace_provision"
  | "workspace_source_retention"
  | "workspace_binding"
  | "workspace_record_update"
  | "workspace_record_create"
  | "workspace_operation_binding"
  | "workspace_config_recording"
  | "workspace_repository_admission"
  | "workspace_project_repositories"
  | "workspace_recovery_root"
  | "github_access" | "wake_binding" | "backend_setup" | "connector_assignments"
  | "assigned_mcp" | "tool_authority" | "companion_selection" | "runner_binary"
  | "github_stop" | "coordinator_release" | "instruction_checkpoint"
  | "instruction_changes" | "warm_release" | "instruction_collection";

export type ExecutionPhase =
  | "workspace.transaction" | "workspace.transaction.entry" | "workspace.transaction.commit" | "workspace.transaction.rollback"
  | "workspace.identity_read" | "workspace.row_lock" | "workspace.provenance" | "workspace.notification" | "workspace.write"
  | "workspace.sources" | "workspace.sources.canonicalize" | "workspace.sources.inventory" | "workspace.sources.alias_scan"
  | "workspace.sources.repository_scan" | "workspace.sources.project_scan" | "workspace.provenance_lock"
  | "workspace.readers" | "workspace.readers.identity" | "workspace.readers.trust" | "workspace.readers.projects" | "workspace.readers.sources"
  | "workspace.access" | "workspace.access.privacy" | "workspace.access.inventory" | "workspace.access.authorization"
  | "workspace.access.execution" | "workspace.access.task_read" | "workspace.access.agent_read" | "workspace.access.run_read"
  | "workspace.access.workspace_read" | "workspace.access.source_read" | "workspace.access.projects_read"
  | "workspace.access.task_authorization" | "workspace.access.trust" | "workspace.access.trust.project_read"
  | "authorization.base" | "authorization.responsible_user" | "authorization.authorizing_user"
  | "authorization.task_privacy" | "authorization.project_privacy"
  | "workspace.repository.binding" | "workspace.repository.current_policy" | "workspace.repository.acquisition"
  | "workspace.repository.catalog" | "workspace.repository.receipts" | "workspace.repository.paths"
  | "workspace.repository.fs_prepare" | "workspace.repository.publication" | "workspace.repository.lock_wait"
  | "workspace.repository.critical_section" | "workspace.repository.lock_release" | "workspace.repository.checkout_identity"
  | "workspace.repository.state_write" | "workspace.repository.ownership_read" | "workspace.repository.ownership_verify"
  | "workspace.repository.materialize" | "workspace.repository.git_origin" | "workspace.repository.git_branch"
  | "workspace.repository.git_commit" | "workspace.repository.ownership_write" | "workspace.repository.ignore_rules"
  | "workspace.repository.db.issue" | "workspace.repository.db.workspace" | "workspace.repository.db.agent"
  | "workspace.repository.db.project" | "workspace.repository.db.run"
  | "connectors.github.catalog" | "connectors.github.connections" | "connectors.github.grants"
  | "connectors.github.grant_members" | "connectors.github.membership"
  | "connectors.github.refresh" | "connectors.github.credentials" | "connectors.github.repositories"
  | "connectors.github.grant_lock" | "connectors.github.grant_write" | "connectors.github.webhooks"
  | "connectors.github.refresh.transaction" | "connectors.github.refresh.transaction.entry"
  | "connectors.github.refresh.transaction.commit" | "connectors.github.refresh.transaction.rollback"
  | "workspace.materialize.directories" | "workspace.materialize.source_identity"
  | "workspace.checkout.lookup" | "workspace.checkout.git_auth" | "workspace.checkout.git_clone"
  | "workspace.checkout.git_ref" | "workspace.checkout.publish"
  | "workspace.checkout.cache_lookup" | "workspace.checkout.cache_publish"
  | "runtime_selection.review" | "runtime_selection.contract_read" | "runtime_selection.contract_ensure"
  | "runtime_selection.resume" | "runtime_selection.recovery_profile" | "runtime_selection.profile" | "runtime_selection.interactions"
  | "runtime_selection.provider_discovery" | "runtime_selection.bootstrap" | "runtime_selection.run_write" | "runtime_selection.finalization_write"
  | "runtime_selection.transaction" | "runtime_selection.transaction.entry" | "runtime_selection.transaction.commit" | "runtime_selection.transaction.rollback"
  | "runtime_selection.row_lock" | "runtime_selection.workspace_sync"
  | "runtime_context.instructions" | "runtime_context.skills" | "runtime_context.mcp"
  | "runtime_context.asset_read" | "runtime_context.asset_manifest" | "runtime_context.asset_cache" | "runtime_context.asset_materialize" | "runtime_context.asset_verify"
  | "workspace_sync.snapshot_git" | "workspace_sync.snapshot_baseline" | "workspace_sync.pack" | "workspace_sync.seed_verify" | "workspace_sync.stage_workspace" | "workspace_sync.restore"
  | "workspace_sync.run_read" | "workspace_sync.descriptor_directory" | "workspace_sync.descriptor_read"
  | "workspace_sync.prepare_host_current" | "workspace_sync.prepare_durable_seed" | "workspace_sync.prepare_adopt_remote"
  | "workspace_sync.archive_hash" | "workspace_sync.warm_stamp" | "workspace_sync.durable_seed_verify"
  | "workspace_sync.manifests_persist" | "workspace_sync.descriptor_write" | "workspace_sync.reference_write"
  | "workspace_sync.source_root" | "workspace_sync.repositories" | "workspace_sync.ignore_rules"
  | "workspace_sync.seed_generation" | "workspace_sync.seed_lookup" | "workspace_sync.seed_publish"
  | "workspace_sync.git_clone" | "workspace_sync.git_archive" | "workspace_sync.seed_replay" | "workspace_sync.seed_persist"
  | "workspace_sync.overlay_copy" | "workspace_sync.overlay_archive" | "workspace_sync.deleted_manifest"
  | "workspace_sync.seed_extract" | "workspace_sync.seed_snapshot" | "workspace_sync.seed_cleanup"
  | "workspace_sync.inbound_barrier" | "workspace_sync.transfer" | "workspace_sync.progress"
  | "connectors.browser_use.resolve" | "connectors.speko.resolve" | "connectors.slack.resolve" | "connectors.agentmail.resolve"
  | "connectors.browser_use.connection" | "connectors.browser_use.catalog" | "connectors.browser_use.grant"
  | "connectors.discovery.scheduled" | "connectors.discovery.queue" | "connectors.discovery.build" | "connectors.discovery.agent"
  | "connectors.discovery.connections" | "connectors.discovery.github" | "connectors.discovery.slack" | "connectors.discovery.speko"
  | "connectors.discovery.policy" | "connectors.discovery.on_demand_policy"
  | "connectors.slack.candidates" | "connectors.slack.authority" | "connectors.slack.profile"
  | "connectors.slack.settings" | "connectors.slack.identity" | "connectors.slack.credentials" | "connectors.slack.revision"
  | "connectors.slack.authority.transaction" | "connectors.slack.authority.transaction.entry" | "connectors.slack.authority.transaction.commit" | "connectors.slack.authority.transaction.rollback"
  | "connectors.slack.catalog.transaction" | "connectors.slack.catalog.transaction.entry" | "connectors.slack.catalog.transaction.commit" | "connectors.slack.catalog.transaction.rollback"
  | "connectors.slack.catalog.lock" | "connectors.slack.catalog.entries" | "connectors.slack.catalog.write" | "connectors.slack.catalog.profile"
  | "execution.runtime" | "execution.workspace_ownership" | "execution.workspace_finalize" | "execution.workspace_restore" | "execution.workspace_commit"
  | "execution.workspace_ownership_wait" | "execution.realtime"
  | "execution.usage" | "execution.native_finalize"
  | "execution.usage_startup" | "execution.mcp_handoff" | "execution.dispatch_admission" | "execution.budget_reservation"
  | "completion.run" | "completion.output" | "completion.terminal_write" | "completion.cost" | "completion.liveness" | "completion.summary"
  | "response.transaction" | "response.transaction.entry" | "response.transaction.commit" | "response.transaction.rollback" | "response.row_lock" | "response.write"
  | "response.resolve" | "response.authorize" | "response.add_comment" | "response.activity" | "response.publish";

type RunScope = { runId: string; phase: string; parent?: Context; ended: boolean; details: Map<string, number> };
const ownership = new AsyncLocalStorage<RunScope>();
const endpointEnabled = () => Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim());

const repositoryCacheOutcomes = ["disabled", "hit", "miss", "published", "already_present", "contended", "capacity", "budget", "invalid", "error"] as const;
export type RepositoryObjectCacheOutcome = typeof repositoryCacheOutcomes[number];

export function recordRepositoryObjectCacheDetail(detail: {
  outcome?: RepositoryObjectCacheOutcome;
  referenceSupplied?: boolean;
}): void {
  const owned = ownership.getStore();
  if (!endpointEnabled() || !owned?.parent || owned.ended) return;
  try {
    const span = trace.getSpan(owned.parent);
    if (detail.outcome && repositoryCacheOutcomes.includes(detail.outcome)) {
      span?.setAttribute(EXECUTION_PREPARATION_SPAN_ATTRS.repositoryCacheOutcome, detail.outcome);
    }
    if (typeof detail.referenceSupplied === "boolean") {
      span?.setAttribute(EXECUTION_PREPARATION_SPAN_ATTRS.repositoryCacheReferenceSupplied, detail.referenceSupplied);
    }
  } catch {}
}

export function getRunExecutionTraceContext(runId: string): Context | undefined {
  const owned = ownership.getStore();
  return endpointEnabled() && owned?.runId === runId && !owned.ended ? owned.parent : undefined;
}

/** Inspect only the current async scope; unrelated authorization must not consume its detail budget. */
export function isRunPhaseActive(phase: ExecutionPhase): boolean {
  const owned = ownership.getStore();
  return endpointEnabled() && owned?.phase === phase && !owned.ended;
}

function measure<T>(runId: string, name: string, work: () => T | Promise<T>, independent = false, counts: { fileCount?: number; bytes?: number } = {}): Promise<T> {
  let operation: Promise<T> | undefined;
  const run = (span?: { setStatus(status: { code: number }): void; end(): void }, parent?: Context) => {
    if (operation) return operation;
    const previous = ownership.getStore();
    const owned: RunScope = { runId, phase: name,
      parent: parent ?? (!independent && previous?.runId === runId && !previous.ended ? previous.parent : undefined),
      ended: false,
      details: !independent && previous?.runId === runId ? previous.details : new Map<string, number>(),
    };
    operation = Promise.resolve().then(() =>
      ownership.run(owned, () => runWithRuntimeParent(owned.parent, work))).then(value => {
        try { span?.end(); } catch {}
        owned.ended = true;
        return value;
      }, error => {
        try { span?.setStatus({ code: SpanStatusCode.ERROR }); } catch {}
        try { span?.end(); } catch {}
        owned.ended = true;
        throw error;
      });
    return operation;
  };
  if (!endpointEnabled()) return (async () => work())();
  try {
    const parent = independent ? undefined : getRunExecutionTraceContext(runId);
    const trigger = parent ? undefined : trace.getActiveSpan()?.spanContext();
    const traced = trace.getTracer(name.startsWith("heartbeat.prepare.") ? "paperclip.heartbeat-preparation"
      : name.startsWith("native.controller.") ? "paperclip.native-controller" : "paperclip.execution").startActiveSpan(name, {
      attributes: { [EXECUTION_PREPARATION_SPAN_ATTRS.runId]: createHash("sha256").update(runId).digest("hex").slice(0, 12),
        ...Object.fromEntries((["fileCount", "bytes"] as const).flatMap(key =>
          typeof counts[key] === "number" && Number.isSafeInteger(counts[key]) && counts[key]! >= 0
            ? [[EXECUTION_PREPARATION_SPAN_ATTRS[key], counts[key]!]] : [])),
      },
      ...(trigger && isSpanContextValid(trigger) ? { links: [{ context: trigger }] } : {}),
    }, parent ?? ROOT_CONTEXT, span => {
      let childContext: Context | undefined;
      try { childContext = trace.setSpan(parent ?? ROOT_CONTEXT, span); } catch {}
      return run(span, childContext);
    });
    void Promise.resolve(traced).catch(() => undefined);
  } catch {}
  return operation ?? run();
}

export function withRunExecutionTiming<T>(runId: string, work: () => T | Promise<T>): Promise<T> {
  return measure(runId, "task.execution_attempt", work, true);
}

export async function measureRunPhase<T>(phase: ExecutionPhase, work: () => T | Promise<T>, counts?: { fileCount?: number; bytes?: number }): Promise<T> {
  const owned = ownership.getStore();
  if (!endpointEnabled() || !owned || owned.ended) return work();
  const count = owned.details.get(phase) ?? 0;
  if (count >= 16) return work();
  owned.details.set(phase, count + 1);
  return measure(owned.runId, phase, work, false, counts);
}

export function beginRunPhase(phase: ExecutionPhase): (failed?: boolean) => void {
  const owned = ownership.getStore();
  if (!endpointEnabled() || !owned?.parent || owned.ended) return () => {};
  const count = owned.details.get(phase) ?? 0;
  if (count >= 16) return () => {};
  owned.details.set(phase, count + 1);
  try {
    const span = trace.getTracer("paperclip.execution").startSpan(phase, {
      attributes: { [EXECUTION_PREPARATION_SPAN_ATTRS.runId]: createHash("sha256").update(owned.runId).digest("hex").slice(0, 12) },
    }, owned.parent);
    let ended = false;
    return failed => {
      if (ended) return;
      ended = true;
      if (failed) { try { span.setStatus({ code: SpanStatusCode.ERROR }); } catch {} }
      try { span.end(); } catch {}
    };
  } catch { return () => {}; }
}

export function measureToolDiscovery<T>(schedule: (work: () => Promise<T>) => Promise<T>, work: () => Promise<T>): Promise<T> {
  return measureRunPhase("connectors.discovery.scheduled", async () => {
    const queued = beginRunPhase("connectors.discovery.queue");
    const build = AsyncLocalStorage.bind(() => {
      queued();
      return measureRunPhase("connectors.discovery.build", work);
    });
    let failed = false;
    try { return await schedule(build); }
    catch (error) { failed = true; throw error; }
    finally { queued(failed); }
  });
}

export function createRunPreparationTiming(runId: string, scope: "heartbeat.prepare" | "native.controller" = "heartbeat.prepare") {
  return <T>(phase: PreparationPhase, work: () => T | Promise<T>): Promise<T> => measure(runId, `${scope}.${phase}`, work);
}

const workspaceSyncDetailPhases = {
  "workspace.source_root": "workspace_sync.source_root",
  "workspace.repositories": "workspace_sync.repositories",
  "workspace.ignore_rules": "workspace_sync.ignore_rules",
  "workspace.seed_generation": "workspace_sync.seed_generation",
  "workspace.seed_lookup": "workspace_sync.seed_lookup",
  "workspace.seed_publish": "workspace_sync.seed_publish",
  "workspace.git_clone": "workspace_sync.git_clone",
  "workspace.git_archive": "workspace_sync.git_archive",
  "workspace.seed_replay": "workspace_sync.seed_replay",
  "workspace.seed_persist": "workspace_sync.seed_persist",
  "workspace.overlay_copy": "workspace_sync.overlay_copy",
  "workspace.overlay_archive": "workspace_sync.overlay_archive",
  "workspace.deleted_manifest": "workspace_sync.deleted_manifest",
  "workspace.seed_extract": "workspace_sync.seed_extract",
  "workspace.seed_snapshot": "workspace_sync.seed_snapshot",
  "workspace.seed_cleanup": "workspace_sync.seed_cleanup",
  "workspace.inbound_barrier": "workspace_sync.inbound_barrier",
  "workspace.transfer": "workspace_sync.transfer",
  "workspace.progress": "workspace_sync.progress",
} as const satisfies Record<string, ExecutionPhase>;

export function isWorkspaceSyncDetailPhase(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(workspaceSyncDetailPhases, name);
}

const workspaceSyncPhases: Readonly<Record<string, ExecutionPhase>> = {
  ...workspaceSyncDetailPhases,
  "snapshot.git": "workspace_sync.snapshot_git", "snapshot.baseline": "workspace_sync.snapshot_baseline",
  pack: "workspace_sync.pack", "seed.verify": "workspace_sync.seed_verify",
  "stage.workspace": "workspace_sync.stage_workspace", "restore.workspace": "workspace_sync.restore",
  "workspace.restore": "execution.workspace_restore",
};

export function measureWorkspaceSyncPhase<T>(name: string, work: () => Promise<T>): Promise<T> {
  return Object.prototype.hasOwnProperty.call(workspaceSyncPhases, name) ? measureRunPhase(workspaceSyncPhases[name]!, work) : work();
}
