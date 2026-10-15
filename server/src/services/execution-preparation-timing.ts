import { createHash } from "node:crypto";
import { isSpanContextValid, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";

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

export function createRunPreparationTiming(runId: string, scope: "heartbeat.prepare" | "native.controller" = "heartbeat.prepare") {
  let runIdHash: string | undefined;
  return <T>(phase: PreparationPhase, work: () => T | Promise<T>): Promise<T> => {
    let operation: Promise<T> | undefined;
    const run = (span?: { setStatus(status: { code: number }): void; end(): void }) => {
      operation ??= (async () => {
        try { return await work(); }
        catch (error) {
          try { span?.setStatus({ code: SpanStatusCode.ERROR }); } catch {}
          throw error;
        } finally {
          try { span?.end(); } catch {}
        }
      })();
      return operation;
    };
    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return run();
    try {
      runIdHash ??= createHash("sha256").update(runId).digest("hex").slice(0, 12);
      const trigger = trace.getActiveSpan()?.spanContext();
      const traced = trace.getTracer(scope === "heartbeat.prepare" ? "paperclip.heartbeat-preparation" : "paperclip.native-controller").startActiveSpan(
        `${scope}.${phase}`,
        {
          attributes: { "paperclip.task.run.run_id": runIdHash },
          ...(trigger && isSpanContextValid(trigger) ? { links: [{ context: trigger }] } : {}),
        },
        ROOT_CONTEXT,
        span => run(span),
      );
      void Promise.resolve(traced).catch(() => undefined);
    } catch {}
    return operation ?? run();
  };
}
