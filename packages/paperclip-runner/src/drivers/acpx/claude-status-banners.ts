/**
 * claude-agent-acp 0.73 reports harness lifecycle (compaction, model fallback,
 * SDK informational notices) as plain `agent_message_chunk` text because ACP
 * has no status update. Each banner is sent as one complete chunk with no
 * `messageId`, while model output always carries the streamed message's id.
 * Both conditions must hold, so a model that writes "Compacting..." itself
 * stays in the answer.
 *
 * Source: `dist/acp-agent.js` `status`, `informational` and
 * `model_refusal_fallback` handlers.
 */

export interface ClaudeStatusBanner {
  category: "context_compaction" | "model_fallback" | "provider_informational";
  severity: "info" | "warning";
  summary: string;
  details: Array<{ name: string; value: string }>;
  /** Compaction start and end update the same notice. */
  phase?: "running" | "completed" | "failed";
}

const INFORMATIONAL = /^\*\*(Notice|Suggestion|Warning):\*\* ([\s\S]+)$/;
const FALLBACK = /^\*\*Model fallback:\*\* ([\s\S]+)$/;
const FALLBACK_SUMMARY = /^(\S+) declined this request(?: \(([^)]+)\))?; retried with (\S+?)\./;

function bounded(value: string): string {
  return value.trim().slice(0, 4000);
}

export function classifyClaudeStatusBanner(
  chunk: string,
  messageId: string | null,
): ClaudeStatusBanner | null {
  if (messageId) return null;
  const text = chunk.trim();
  if (text === "Compacting...") {
    return { category: "context_compaction", severity: "info", summary: "Compacting context", details: [], phase: "running" };
  }
  if (text === "Compacting completed.") {
    return { category: "context_compaction", severity: "info", summary: "Context compacted", details: [], phase: "completed" };
  }
  if (text.startsWith("Compacting failed")) {
    const reason = text.slice("Compacting failed".length).replace(/^[:.]\s*/, "");
    return {
      category: "context_compaction",
      severity: "warning",
      summary: bounded(reason || "Context compaction failed."),
      details: [],
      phase: "failed",
    };
  }
  const fallback = FALLBACK.exec(text);
  if (fallback) {
    const summary = bounded(fallback[1]);
    const parsed = FALLBACK_SUMMARY.exec(summary);
    const details = parsed
      ? [
          { name: "Original model", value: parsed[1].slice(0, 160) },
          { name: "Fallback model", value: parsed[3].slice(0, 160) },
          { name: "Reason", value: (parsed[2] ? `declined the request (${parsed[2]})` : "declined the request").slice(0, 4000) },
        ]
      : [];
    return { category: "model_fallback", severity: "warning", summary, details };
  }
  const informational = INFORMATIONAL.exec(text);
  if (informational) {
    return {
      category: "provider_informational",
      severity: informational[1] === "Warning" ? "warning" : "info",
      summary: bounded(informational[2]),
      details: [],
    };
  }
  return null;
}
