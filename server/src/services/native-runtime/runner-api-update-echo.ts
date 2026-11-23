/** Short values stay: the point is the resent task text, not the field itself. */
const MIN_OMITTED_CHARS = 500;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Drop what a task update only repeats: the task description, the comment body
 * the caller just sent, and related work. The provider keeps every tool result
 * in its context and reads it again on each later turn. Status, execution state
 * and changes stay. This shapes the tool result only; the saved execution
 * receipt keeps the full response.
 */
export function omitIssueUpdateEcho(result: unknown, call: unknown): unknown {
  if (!isObject(result) || result.operationId !== "PATCH /api/issues/{id}" || result.ok !== true || !isObject(result.data)) return result;
  const data = { ...result.data };
  const omitted: string[] = [];
  if (typeof data.description === "string" && data.description.length > MIN_OMITTED_CHARS) {
    delete data.description;
    omitted.push("description");
  }
  if (data.relatedWork !== undefined && (JSON.stringify(data.relatedWork) ?? "").length > MIN_OMITTED_CHARS) {
    delete data.relatedWork;
    omitted.push("relatedWork");
  }
  const body = isObject(call) && isObject(call.body) ? call.body : {};
  // A comment that differs from the request was changed by the server: keep it.
  if (isObject(data.comment) && typeof data.comment.body === "string"
    && data.comment.body.length > MIN_OMITTED_CHARS && data.comment.body === body.comment) {
    const { body: _sent, ...comment } = data.comment;
    data.comment = comment;
    omitted.push("comment.body");
  }
  if (omitted.length === 0) return result;
  return { ...result, data, omitted: { fields: omitted, guidance: "Unchanged task text is left out. Read it with GET /api/issues/{id} only if you need it." } };
}
