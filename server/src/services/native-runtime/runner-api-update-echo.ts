const MIN_OMITTED_CHARS = 500;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
  if (isObject(data.comment) && typeof data.comment.body === "string"
    && data.comment.body.length > MIN_OMITTED_CHARS && data.comment.body === body.comment) {
    const { body: _sent, ...comment } = data.comment;
    data.comment = comment;
    omitted.push("comment.body");
  }
  if (omitted.length === 0) return result;
  return { ...result, data, omitted: { fields: omitted, guidance: "Unchanged task text is left out. If you need it, read the task with GET /api/issues/{id} and a comment with GET /api/issues/{id}/comments/{commentId}." } };
}
