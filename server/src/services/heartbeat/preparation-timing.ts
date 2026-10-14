import { createHash } from "node:crypto";
import { isSpanContextValid, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";

type PreparationPhase = "environment_selection" | "execution_configuration" | "session"
  | "workspace" | "github_environment" | "github_launchers" | "run_output"
  | "workspace_validation" | "runtime_services" | "instructions" | "runtime_selection";

export function createHeartbeatPreparationTiming(runId: string) {
  const runIdHash = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return <T>(phase: PreparationPhase, work: () => Promise<T>): Promise<T> => {
    const trigger = trace.getActiveSpan()?.spanContext();
    return trace.getTracer("paperclip.heartbeat-preparation").startActiveSpan(
      `heartbeat.prepare.${phase}`,
      {
        attributes: { "paperclip.task.run.run_id": runIdHash },
        ...(trigger && isSpanContextValid(trigger) ? { links: [{ context: trigger }] } : {}),
      },
      ROOT_CONTEXT,
      async (span) => {
        try {
          return await work();
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  };
}
