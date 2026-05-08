/**
 * OpenTelemetry metrics instrumentation for Bizbox.
 *
 * Initialised only when at least one of the standard OTel endpoint env vars
 * is set so that existing deployments remain zero-config (all calls become
 * no-ops via the global no-op MeterProvider when neither is set).
 *
 * Endpoint resolution follows the OTel specification priority order:
 *   1. OTEL_EXPORTER_OTLP_METRICS_ENDPOINT  (signal-specific, highest priority)
 *   2. OTEL_EXPORTER_OTLP_ENDPOINT           (generic fallback)
 *
 * The SDK resolves these automatically when no url is passed to the exporter
 * constructor, so both env vars are honoured without any custom logic here.
 */

import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { Counter, ObservableGauge, ObservableResult } from "@opentelemetry/api";
import { metrics, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _meterProvider: MeterProvider | null = null;
let _tracerProvider: NodeTracerProvider | null = null;

// Counters — lazily resolved after init so callers can import at module load
// time without worrying about init order.
let _commentsCounter: Counter | null = null;
let _humanIntervenedCounter: Counter | null = null;
let _issuesCreatedCounter: Counter | null = null;
let _issuesStatusChangedCounter: Counter | null = null;
let _runsStatusCounter: Counter | null = null;
let _issuesCountByStatusGauge: ObservableGauge | null = null;
const _issuesCountByStatusByCompanyAndProject = new Map<string, Map<string, Map<string, number>>>();

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Start the OTel SDK. Safe to call multiple times — subsequent calls are
 * no-ops. Must be called before the Express app starts handling requests.
 *
 * The SDK is started only when at least one of the following env vars is set:
 *   - OTEL_EXPORTER_OTLP_METRICS_ENDPOINT (signal-specific, takes priority)
 *   - OTEL_EXPORTER_OTLP_ENDPOINT         (generic fallback)
 *
 * When neither is set the function returns immediately and all metric calls
 * become no-ops via the global no-op MeterProvider.
 */
export function initOtel(): void {
  const hasEndpoint =
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!hasEndpoint) return;
  if (_meterProvider && _tracerProvider) return;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "bizbox",
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "unknown",
  });

  if (!_meterProvider) {
    // No url passed — the SDK reads OTEL_EXPORTER_OTLP_METRICS_ENDPOINT then
    // OTEL_EXPORTER_OTLP_ENDPOINT automatically, matching the spec priority.
    const exporter = new OTLPMetricExporter();

    _meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: Number(process.env.OTEL_EXPORT_INTERVAL_MS ?? 60_000),
        }),
      ],
    });

    // Register as the global provider so @opentelemetry/api calls anywhere in
    // the process resolve to this instance.
    metrics.setGlobalMeterProvider(_meterProvider);
  }

  if (!_tracerProvider) {
    _tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
    });
    trace.setGlobalTracerProvider(_tracerProvider);
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Flush and shut down the MeterProvider. Call during graceful server shutdown.
 */
export async function shutdownOtel(): Promise<void> {
  if (_meterProvider || _tracerProvider) {
    await Promise.all([
      _meterProvider?.shutdown(),
      _tracerProvider?.shutdown(),
    ]);
    _meterProvider = null;
    _tracerProvider = null;
    _commentsCounter = null;
    _humanIntervenedCounter = null;
    _issuesCreatedCounter = null;
    _issuesStatusChangedCounter = null;
    _runsStatusCounter = null;
    _issuesCountByStatusGauge = null;
    _issuesCountByStatusByCompanyAndProject.clear();
  }
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

function getCommentsCounter(): Counter {
  if (!_commentsCounter) {
    const meter = metrics.getMeter("bizbox");
    _commentsCounter = meter.createCounter("bizbox.issues.comments", {
      description:
        "Total number of comments posted on an issue. " +
        "Use the actor_type attribute to distinguish human (board user) vs agent comments.",
      unit: "{comment}",
    });
  }
  return _commentsCounter;
}

function getHumanIntervenedCounter(): Counter {
  if (!_humanIntervenedCounter) {
    const meter = metrics.getMeter("bizbox");
    _humanIntervenedCounter = meter.createCounter("bizbox.issues.human_intervened.count", {
      description: "Total number of issues where a human intervened at least once.",
      unit: "{issue}",
    });
  }
  return _humanIntervenedCounter;
}

function getIssuesCreatedCounter(): Counter {
  if (!_issuesCreatedCounter) {
    const meter = metrics.getMeter("bizbox");
    _issuesCreatedCounter = meter.createCounter("bizbox.issues.created", {
      description: "Total number of created issues.",
      unit: "{issue}",
    });
  }
  return _issuesCreatedCounter;
}

function getIssuesStatusChangedCounter(): Counter {
  if (!_issuesStatusChangedCounter) {
    const meter = metrics.getMeter("bizbox");
    _issuesStatusChangedCounter = meter.createCounter("bizbox.issues.status_changed", {
      description: "Total number of issue status change events.",
      unit: "{issue}",
    });
  }
  return _issuesStatusChangedCounter;
}

function getRunsStatusCounter(): Counter {
  if (!_runsStatusCounter) {
    const meter = metrics.getMeter("bizbox");
    _runsStatusCounter = meter.createCounter("bizbox.runs.status", {
      description: "Total number of run terminal status events.",
      unit: "{run}",
    });
  }
  return _runsStatusCounter;
}

function normalizeRunStatus(status: string): string {
  return status === "canceled" ? "cancelled" : status;
}

/**
 * Increment `bizbox.issues.comments`.
 *
 * Call this after a comment is successfully persisted.
 *
 * @param attributes - OTel attributes attached to the data point.
 */
export function recordComment(attributes: {
  company_id: string;
  project_id: string | undefined;
  issue_status: string;
  actor_type: string;
  commenter_id: string;
  assignee_agent_id: string | undefined;
  assignee_user_id: string | undefined;
}): void {
  getCommentsCounter().add(1, attributes);
}

/**
 * Increment `bizbox.issues.human_intervened.total`.
 */
export function recordHumanIntervened(attributes: {
  company_id: string;
  project_id: string | undefined;
  issue_status: string;
  intervention_kind: string;
  intervener_id: string;
  assignee_agent_id: string | undefined;
}): void {
  getHumanIntervenedCounter().add(1, attributes);
}

/**
 * Increment `bizbox.issues.created`.
 */
export function recordIssueCreated(attributes: {
  company_id: string;
  project_id: string | undefined;
  actor_type: string;
  actor_id: string;
  initial_status: string;
  assignee_agent_id: string | undefined;
  assignee_user_id: string | undefined;
  origin_kind: string;
}): void {
  getIssuesCreatedCounter().add(1, attributes);
}

/**
 * Increment `bizbox.issues.status_changed`.
 */
export function recordIssueStatusChanged(attributes: {
  company_id: string;
  project_id: string | undefined;
  from_status: string;
  to_status: string;
  actor_type: string;
  actor_id: string;
}): void {
  getIssuesStatusChangedCounter().add(1, attributes);
}

/**
 * Increment `bizbox.runs.status`.
 */
export function recordRunStatus(attributes: {
  company_id: string;
  agent_id: string;
  status: string;
  invocation_source: string;
  trigger_detail: string | undefined;
}): void {
  getRunsStatusCounter().add(1, {
    ...attributes,
    status: normalizeRunStatus(attributes.status),
  });
}

/**
 * Emit a trace span when a human posts an issue comment.
 */
export function traceHumanCommentPosted(attributes: {
  company_id: string;
  project_id: string | undefined;
  issue_id: string;
  issue_identifier: string | undefined;
  issue_status: string;
  comment_id: string;
  commenter_id: string;
  assignee_agent_id: string | undefined;
  assignee_user_id: string | undefined;
  body_length: number;
}): void {
  const tracer = trace.getTracer("bizbox");
  const span = tracer.startSpan("issue.comment.human_posted", {
    attributes: {
      "company.id": attributes.company_id,
      ...(attributes.project_id ? { "project.id": attributes.project_id } : {}),
      "issue.id": attributes.issue_id,
      ...(attributes.issue_identifier ? { "issue.identifier": attributes.issue_identifier } : {}),
      "issue.status": attributes.issue_status,
      "comment.id": attributes.comment_id,
      "comment.actor_type": "user",
      "comment.actor_id": attributes.commenter_id,
      ...(attributes.assignee_agent_id ? { "issue.assignee_agent_id": attributes.assignee_agent_id } : {}),
      ...(attributes.assignee_user_id ? { "issue.assignee_user_id": attributes.assignee_user_id } : {}),
      "comment.body_length": attributes.body_length,
    },
  });
  span.end();
}

function observeIssuesCountByStatus(result: ObservableResult): void {
  for (const [companyId, countsByProject] of _issuesCountByStatusByCompanyAndProject.entries()) {
    for (const [projectIdKey, countsByStatus] of countsByProject.entries()) {
      const projectId = projectIdKey === "__none__" ? undefined : projectIdKey;
      for (const [status, count] of countsByStatus.entries()) {
        result.observe(count, {
          company_id: companyId,
          issue_status: status,
          ...(projectId ? { project_id: projectId } : {}),
        });
      }
    }
  }
}

function getIssuesCountByStatusGauge(): ObservableGauge {
  if (!_issuesCountByStatusGauge) {
    const meter = metrics.getMeter("bizbox");
    _issuesCountByStatusGauge = meter.createObservableGauge("bizbox.issues.count", {
      description: "Current number of issues in each status.",
      unit: "{issue}",
    });
    _issuesCountByStatusGauge.addCallback(observeIssuesCountByStatus);
  }
  return _issuesCountByStatusGauge;
}

/**
 * Update the in-memory status snapshot used by `bizbox.issues.count`.
 */
export function recordIssueStatusCounts(attributes: {
  company_id: string;
  project_id: string | undefined;
  counts_by_status: Record<string, number>;
}): void {
  getIssuesCountByStatusGauge();
  const byProject = _issuesCountByStatusByCompanyAndProject.get(attributes.company_id) ?? new Map<string, Map<string, number>>();
  const projectKey = attributes.project_id ?? "__none__";
  byProject.set(projectKey, new Map(Object.entries(attributes.counts_by_status)));
  _issuesCountByStatusByCompanyAndProject.set(attributes.company_id, byProject);
}

/**
 * Clear all cached status snapshots for a company.
 */
export function clearIssueStatusCountsForCompany(companyId: string): void {
  _issuesCountByStatusByCompanyAndProject.delete(companyId);
}
