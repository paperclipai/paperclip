const WORKABLE_STATUSES = new Set(["todo", "in_progress"]);
const TARGETED_WAKE_STATUSES = new Set(["todo", "in_progress", "in_review"]);

export function pickWorkableIssue(rows, preferredIssueId = "") {
  const list = Array.isArray(rows) ? rows : rows?.issues || rows?.data || [];
  // A comment/Hold continuation targets one specific review issue through
  // PAPERCLIP_TASK_ID. Let that targeted wake inspect the interaction and
  // feedback. Do not make arbitrary/periodic runs select every in_review item:
  // a still-pending approval must not starve ordinary todo work.
  if (preferredIssueId) {
    const preferred = list.find(
      (issue) =>
        String(issue?.id || "") === String(preferredIssueId)
        && TARGETED_WAKE_STATUSES.has(String(issue?.status || "").toLowerCase()),
    );
    if (preferred) return preferred;
  }
  const workable = list.filter((issue) =>
    WORKABLE_STATUSES.has(String(issue?.status || "").toLowerCase()),
  );
  workable.sort((left, right) =>
    String(right.updatedAt || right.createdAt || "").localeCompare(
      String(left.updatedAt || left.createdAt || ""),
    ),
  );
  return workable[0] || null;
}

export function checkoutExpectedStatuses(issue, preferredIssueId = "") {
  const targetedReview =
    String(issue?.id || "") === String(preferredIssueId)
    && String(issue?.status || "").toLowerCase() === "in_review";
  return targetedReview
    ? ["todo", "in_progress", "in_review"]
    : ["todo", "in_progress"];
}
