/**
 * Event telemetry router — dispatches Paperclip domain events to typed handlers.
 *
 * Each handler is a pure-ish async function focused on one telemetry concern
 * (metrics, traces, or logs). The router calls all registered handlers for a
 * given event type via Promise.allSettled so a single handler failure never
 * blocks the others.
 */

import type { Meter, Tracer, Span } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import type {
  PluginEvent,
  PluginStateClient,
  PluginLogger,
  PluginIssuesClient,
  PluginAgentsClient,
  PluginCompaniesClient,
} from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// TelemetryContext — passed to every handler
// ---------------------------------------------------------------------------

export interface TelemetryContext {
  meter: Meter;
  /** Default tracer (service.name = "paperclip"). Use getTracerForAgent for per-agent tracers. */
  tracer: Tracer;
  state: PluginStateClient;
  logger: PluginLogger;
  /** Issues client — used to look up assigned issues for run context enrichment. */
  issues: PluginIssuesClient;
  /** Agents client — used to look up agent companyId for run context enrichment. */
  agents: PluginAgentsClient;
  /** Companies client — used to look up companyId for run context enrichment. */
  companies: PluginCompaniesClient;

  /** OTel Logger for structured log export via OTLP. Null if logs are disabled. */
  otelLogger: Logger | null;

  /** Active run spans — keyed by runId, kept open until run.finished/failed/cancelled. */
  activeRunSpans: Map<string, Span>;

  /** Active issue lifecycle spans — keyed by issueId. */
  activeIssueSpans: Map<string, Span>;

  /** Active approval lifecycle spans — keyed by approvalId. */
  activeApprovalSpans: Map<string, Span>;

  /** Active session lifecycle spans — keyed by sessionId. */
  activeSessionSpans: Map<string, Span>;

  /**
   * Get a tracer for the given agent. Currently returns the shared default
   * tracer for all agents; agent identity is captured via span attributes
   * (`paperclip.agent.id`, `gen_ai.agent.name`) rather than separate
   * service.name values.
   */
  getTracerForAgent(agentId: string, agentName: string): Tracer;

  /** projectId → projectName lookup (refreshed by collect-metrics job). */
  projectNameMap: Map<string, string>;

  /** agentId → active issue context (populated from run.started events). */
  agentIssueMap: Map<string, { issueId: string; issueIdentifier: string; projectId: string }>;

  /** issueId → { projectId, identifier, title, parentId } (refreshed by collect-metrics job). */
  issueContextMap: Map<string, { projectId: string; identifier: string; title: string; parentId?: string }>;

  /** agentId → active runId (populated on run.started, cleaned on run.finished/failed/cancelled). */
  agentActiveRunId: Map<string, string>;

  /** agentId → agentName (refreshed by collect-metrics job, also populated on run.started). */
  agentNameMap: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

export type EventHandler = (
  event: PluginEvent,
  ctx: TelemetryContext,
) => Promise<void>;

// ---------------------------------------------------------------------------
// EventTelemetryRouter
// ---------------------------------------------------------------------------

export class EventTelemetryRouter {
  private handlers = new Map<string, EventHandler[]>();

  /** Register a handler for a specific event type. */
  register(eventType: string, handler: EventHandler): void {
    const list = this.handlers.get(eventType);
    if (list) {
      list.push(handler);
    } else {
      this.handlers.set(eventType, [handler]);
    }
  }

  /** Dispatch an event to all matching handlers via Promise.allSettled. */
  async dispatch(event: PluginEvent, ctx: TelemetryContext): Promise<void> {
    const list = this.handlers.get(event.eventType);
    if (!list || list.length === 0) return;

    const results = await Promise.allSettled(
      list.map((handler) => handler(event, ctx)),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        ctx.logger.error("Telemetry handler failed", {
          eventType: event.eventType,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    }
  }
}
