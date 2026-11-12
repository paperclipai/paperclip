import { RUNNER_TOOL_RESULT_MAX_BYTES } from "./runner-tool-results.js";
import { createHash } from "node:crypto";

const CHILD_CONTEXT_MAX_BYTES = 128 * 1024;
const CHILD_TEXT_MAX_BYTES = 1024;

function excerpt(text: string) {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > CHILD_TEXT_MAX_BYTES) break;
    bytes += size;
    end += character.length;
  }
  return { text: text.slice(0, end), truncated: end < text.length };
}

export function nativeChildTaskContext<T extends { title: string; description: string | null }>(rows: readonly T[]) {
  const tasks: Array<T & { titleTruncated?: boolean; descriptionTruncated?: boolean }> = [];
  let bytes = 2;
  for (const row of rows.slice(0, 100)) {
    const title = excerpt(row.title);
    const description = row.description === null ? null : excerpt(row.description);
    const task = {
      ...row,
      title: title.text,
      description: description?.text ?? null,
      ...(title.truncated ? { titleTruncated: true } : {}),
      ...(description?.truncated ? { descriptionTruncated: true } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(task)) + (tasks.length ? 1 : 0);
    if (bytes + size > CHILD_CONTEXT_MAX_BYTES) break;
    tasks.push(task);
    bytes += size;
  }
  return { tasks, truncated: tasks.length < rows.length };
}

export function nativeTaskContextPage(context: unknown, input: Record<string, unknown>) {
  const text = JSON.stringify(context);
  const contextDigest = createHash("sha256").update(text).digest("hex");
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > text.length ||
      (Number(offset) > 0 && typeof input.contextDigest !== "string")) {
    return { outcome: "failed", code: "paperclip_runner_context_page_invalid" };
  }
  if (input.contextDigest !== undefined && input.contextDigest !== contextDigest) {
    return { outcome: "failed", code: "paperclip_runner_context_changed",
      message: "Discard prior pages and restart at offset 0. Do not combine different context snapshots." };
  }
  let end = Math.min(Number(offset) + 32_000, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return { contextDigest, offset, jsonText: text.slice(Number(offset), end),
    nextOffset: end < text.length ? end : null,
    guidance: "This is a fragment of the complete authorized context JSON, not standalone JSON. Continue with view=full, nextOffset and the same contextDigest. Do not infer missing scope or approval decisions from an incomplete set of pages." };
}

export function fitNativeTaskContext<T extends { activeTask: { id: string }; acceptedPlan?: unknown; sourcePlanApproval?: unknown }>(context: T) {
  if (Buffer.byteLength(JSON.stringify(context)) <= RUNNER_TOOL_RESULT_MAX_BYTES) return context;
  return {
    outcome: "failed",
    code: "paperclip_runner_task_context_too_large",
    message: "This task context exceeds its delivery limit. Read its complete authorized JSON using get_task_context with view=full. This response is not complete context; do not infer missing scope or approval decisions.",
    ...planReferences(context),
    readWith: [{ tool: "get_task_context", arguments: { view: "full", offset: 0 } }],
  };
}

function planReferences(context: { acceptedPlan?: unknown; sourcePlanApproval?: unknown }) {
  const refs: Record<string, unknown> = {};
  for (const key of ["acceptedPlan", "sourcePlanApproval"] as const) {
    const plan = context[key];
    if (!plan || typeof plan !== "object") continue;
    const { markdown: _markdown, ...reference } = plan as Record<string, unknown>;
    refs[key] = Buffer.byteLength(JSON.stringify(reference)) < 32_000 ? reference : {
      ...Object.fromEntries(["documentId", "revisionId", "revisionNumber", "sourceIssueId", "interactionId"]
        .filter(field => field in reference).map(field => [field, reference[field]])),
      metadataTruncated: true,
    };
  }
  return refs;
}
