import { SpanStatusCode, trace } from "@opentelemetry/api";

// Closed, content-free dimensions. OTel remains a no-op without an operator
// endpoint; Server-Timing also makes the same phases inspectable in DevTools.
type IssueReadPhase = "lookup" | "authorization" | "project_goal" | "ancestors"
  | "mentions" | "documents" | "relations" | "blockers" | "review"
  | "references" | "handoff" | "retry" | "recovery" | "cases" | "inbox"
  | "channel" | "workspace" | "work_products" | "created_from" | "execution_blocker"
  | "relation_recovery" | "revalidate_recovery" | "mentioned_projects";

export function createIssueReadTiming() {
  const start = performance.now();
  const durations = new Map<IssueReadPhase, number>();
  return {
    time<T>(phase: IssueReadPhase, read: () => Promise<T>): Promise<T> {
      return trace.getTracer("paperclip.issue-read").startActiveSpan(`issue.read.${phase}`, async (span) => {
        const phaseStart = performance.now();
        try {
          return await read();
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          durations.set(phase, performance.now() - phaseStart);
          span.end();
        }
      });
    },
    header() {
      return [
        `paperclip_issue;dur=${(performance.now() - start).toFixed(1)}`,
        ...[...durations].map(([phase, duration]) => `issue_${phase};dur=${duration.toFixed(1)}`),
      ].join(", ");
    },
  };
}
