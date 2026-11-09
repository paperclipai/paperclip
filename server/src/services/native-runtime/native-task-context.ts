import { RUNNER_TOOL_RESULT_MAX_BYTES } from "./runner-tool-results.js";

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

export function fitNativeTaskContext<T extends { activeTask: { id: string } }>(context: T) {
  if (Buffer.byteLength(JSON.stringify(context)) <= RUNNER_TOOL_RESULT_MAX_BYTES) return context;
  return {
    outcome: "failed",
    code: "paperclip_runner_task_context_too_large",
    message: "This task context exceeds its delivery limit. Read the task, history and documents separately. This response is not complete context; do not infer missing scope or approval decisions.",
    readWith: [
      { tool: "get_task", arguments: { taskId: context.activeTask.id } },
      { tool: "get_task_history", arguments: { limit: 10 } },
      { tool: "search_tasks", arguments: { limit: 10 } },
    ],
  };
}
