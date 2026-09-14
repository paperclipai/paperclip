import { codexThreadLineage } from "./codex-thread-normalization.js";

export type CodexNotificationIdentity =
  | "root"
  | "descendant"
  | "stale_turn"
  | "unrelated_information"
  | "invalid_authority";
const informational = new Set([
  "thread/started",
  "thread/status/changed",
  "thread/closed",
  "thread/tokenUsage/updated",
  "warning",
  "configWarning",
  "guardianWarning",
  "deprecationNotice",
]);
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** Only provider-originated lineage admits a descendant; tool requests never use this classifier. */
export function classifyCodexNotification(input: {
  method: string;
  params: Record<string, unknown>;
  runId: string;
  rootThreadId: string;
  activeTurnId: string | null;
  knownThreads: ReadonlySet<string>;
  settledTurns: ReadonlySet<string>;
}): {
  classification: CodexNotificationIdentity;
  threadId: string | null;
  turnId: string | null;
} {
  const { params, method } = input;
  const isInformation = informational.has(method) ||
    (method === "paperclip/canonicalProviderEvent" &&
      ["provider.notice.recorded", "harness.diagnostic"].includes(String(params.eventType)));
  const threads = [
    params.threadId,
    record(params.thread).id,
    record(params.turn).threadId,
  ].filter((v) => v !== undefined && v !== null);
  const turns = [params.turnId, record(params.turn).id].filter(
    (v) => v !== undefined && v !== null,
  );
  const threadId = typeof threads[0] === "string" ? threads[0] : null;
  const turnId = typeof turns[0] === "string" ? turns[0] : null;
  const result = (classification: CodexNotificationIdentity) => ({
    classification,
    threadId,
    turnId,
  });
  if (
    [...threads, ...turns].some(
      (v) => typeof v !== "string" || v.length === 0,
    ) ||
    new Set(threads).size > 1 ||
    new Set(turns).size > 1 ||
    [params.runId, params.paperclipRunId].some(
      (v) => v !== undefined && v !== input.runId,
    )
  )
    return result("invalid_authority");
  if (threadId === null && isInformation) return result("root");
  if (threadId === input.rootThreadId) {
    if (
      input.activeTurnId !== null &&
      turnId &&
      turnId !== input.activeTurnId &&
      input.settledTurns.has(turnId)
    )
      return result("stale_turn");
    return result("root");
  }
  const lineage = codexThreadLineage(params.thread);
  if (
    threadId &&
    (input.knownThreads.has(threadId) ||
      (method === "thread/started" &&
        lineage.parentThreadId !== null &&
        input.knownThreads.has(lineage.parentThreadId)))
  ) {
    // A descendant may report its own terminal, but never supply a root result or workspace authority.
    return result(
      method.startsWith("paperclip/") ? "invalid_authority" : "descendant",
    );
  }
  return result(
    isInformation ? "unrelated_information" : "invalid_authority",
  );
}
