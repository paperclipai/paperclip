// LET-503 — Customer-facing labels for raw activity event identifiers.
//
// Activity events carry machine-shaped action strings (`run.completed`,
// `test_completed`, `comment.posted`, `issue.blocked_on_dependency`). The
// customer-visible runs surface must not display those raw enums; this
// helper folds them into title-cased sentences.

const ACTION_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ["run.started", "Run started"],
  ["run.completed", "Run completed"],
  ["run.failed", "Run failed"],
  ["run.tool_call", "Tool call"],
  ["test_completed", "Test completed"],
  ["test.completed", "Test completed"],
  ["comment_posted", "Comment posted"],
  ["comment.posted", "Comment posted"],
  ["document_updated", "Document updated"],
  ["document.updated", "Document updated"],
  ["issue.blocked_on_dependency", "Blocked on dependency"],
  ["blocked_on_dependency", "Blocked on dependency"],
  ["issue.created", "Mission created"],
  ["issue.updated", "Mission updated"],
  ["issue.completed", "Mission completed"],
  ["approval.requested", "Approval requested"],
  ["approval.granted", "Approval granted"],
  ["approval.rejected", "Approval rejected"],
]);

export function humanizeActivityAction(action: string): string {
  if (!action) return "Event";
  const direct = ACTION_OVERRIDES.get(action.toLowerCase());
  if (direct) return direct;
  // Strip namespace prefix and convert snake/kebab/dotted forms to a
  // sentence-cased label. Single tokens stay capitalized.
  const tail = action.includes(".") ? action.split(".").slice(1).join(".") : action;
  const tokens = tail.split(/[._-]+/).filter(Boolean);
  if (tokens.length === 0) return "Event";
  const first = tokens[0]!;
  const rest = tokens.slice(1).map((t) => t.toLowerCase());
  return [first.charAt(0).toUpperCase() + first.slice(1).toLowerCase(), ...rest].join(" ");
}

const ACTOR_LABELS: Record<string, string> = {
  agent: "Agent",
  user: "User",
  system: "System",
};

export function humanizeActorType(actorType: string | null | undefined): string {
  if (!actorType) return "System";
  return ACTOR_LABELS[actorType] ?? actorType.charAt(0).toUpperCase() + actorType.slice(1);
}
