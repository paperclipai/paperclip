import type { GeneratedAcpxBackgroundTasks } from "./generated-sidecar-contract.js";

export const CLAUDE_ASYNC_TASKS_CAPABILITY = "asyncTasks";

export type ClaudeBackgroundTaskState = GeneratedAcpxBackgroundTasks;

const MAX_TRACKED_TASKS = 256;
const MAX_PENDING_REQUESTS = 256;
const MAX_TASK_ID_CHARS = 256;
const IDLE_ACTIVITY = new Set(["tool_call", "tool_call_update", "agent_message_chunk", "agent_thought_chunk", "plan"]);
const SCHEDULING_TOOLS = new Set(["CronCreate", "ScheduleWakeup"]);
const LIVE_STATES = new Set(["running", "paused"]);
const TERMINAL_STATES = new Set(["completed", "failed", "stopped"]);

type Task = { shell: boolean; live: boolean };
type RequestId = string | number;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function advertisesAsyncTasks(meta: unknown): boolean {
  const air = record(record(record(meta).jetbrains).air);
  return typeof air.version === "number" && Number.isInteger(air.version) && air.version >= 1
    && Array.isArray(air.capabilities) && air.capabilities.includes(CLAUDE_ASYNC_TASKS_CAPABILITY);
}

export class ClaudeBackgroundTaskTracker {
  #negotiated = false;
  #unknown = false;
  #observedTask = false;
  readonly #tasks = new Map<string, Task>();
  readonly #pending = new Map<RequestId, { method: string; advertised: boolean }>();

  observe(direction: "inbound" | "outbound", message: unknown): void {
    if (this.#unknown) return;
    try {
      if (direction === "outbound") this.#outbound(record(message));
      else this.#inbound(record(message));
    } catch {
      this.#unknown = true;
    }
  }

  state(): ClaudeBackgroundTaskState | null {
    if (this.#unknown || !this.#negotiated) return null;
    if (!this.#observedTask) return { live: 0 };
    let live = 0;
    for (const task of this.#tasks.values()) {
      if (!task.live) continue;
      if (!task.shell) return null;
      live += 1;
    }
    return live > 0 ? { live } : null;
  }

  #outbound(message: Record<string, unknown>): void {
    const id = message.id;
    if ((typeof id !== "string" && typeof id !== "number") || typeof message.method !== "string") return;
    if (this.#pending.has(id) || this.#pending.size >= MAX_PENDING_REQUESTS) {
      this.#unknown = true;
      return;
    }
    const advertised = message.method === "initialize"
      && advertisesAsyncTasks(record(record(message.params).clientCapabilities)._meta);
    this.#pending.set(id, { method: message.method, advertised });
  }

  #inbound(message: Record<string, unknown>): void {
    const id = message.id;
    const hasId = typeof id === "string" || typeof id === "number";
    if (hasId && message.method === undefined) {
      const request = this.#pending.get(id);
      if (!request) return;
      this.#pending.delete(id);
      if (request.method !== "initialize") return;
      if (request.advertised && message.error === undefined && advertisesAsyncTasks(record(message.result)._meta)) {
        this.#negotiated = true;
      } else {
        this.#unknown = true;
      }
      return;
    }
    if (hasId) {
      if (this.#pending.size === 0) this.#unknown = true;
      return;
    }
    if (message.method !== "session/update") return;
    const update = record(record(message.params).update);
    const kind = update.sessionUpdate;
    if (typeof kind !== "string") return;
    if (kind.startsWith("async_task_")) {
      this.#observedTask = true;
      this.#asyncTask(kind, update);
      return;
    }
    const claudeCode = record(record(update._meta).claudeCode);
    const backgroundTaskId = record(claudeCode.toolResponse).backgroundTaskId;
    if (backgroundTaskId !== undefined) {
      this.#observedTask = true;
      const taskId = this.#taskId(backgroundTaskId);
      if (taskId !== null && !this.#tasks.has(taskId)) this.#track(taskId, { shell: true, live: true });
    }
    if (kind === "tool_call" && typeof claudeCode.toolName === "string" && SCHEDULING_TOOLS.has(claudeCode.toolName)) {
      this.#unknown = true;
    }
    const origin = record(update._meta)["_claude/origin"];
    if (this.#pending.size === 0 && (IDLE_ACTIVITY.has(kind) || (kind === "usage_update" && origin !== undefined))) {
      this.#unknown = true;
    }
  }

  #asyncTask(kind: string, update: Record<string, unknown>): void {
    const taskId = this.#taskId(update.asyncTaskId);
    if (taskId === null) return;
    const task = this.#tasks.get(taskId);
    if (kind === "async_task_spawned") {
      const shell = update.taskType === "shell";
      if (task) task.shell = task.shell && shell;
      else this.#track(taskId, { shell, live: true });
      return;
    }
    if (kind === "async_task_state_update") {
      const state = update.state;
      if (typeof state === "string" && TERMINAL_STATES.has(state)) {
        if (task) task.live = false;
        else this.#track(taskId, { shell: false, live: false });
      } else if (!(typeof state === "string" && LIVE_STATES.has(state) && task)) {
        this.#unknown = true;
      }
      return;
    }
    if (kind !== "async_task_progress" || !task) this.#unknown = true;
  }

  #taskId(value: unknown): string | null {
    if (typeof value === "string" && value.length > 0 && value.length <= MAX_TASK_ID_CHARS) return value;
    this.#unknown = true;
    return null;
  }

  #track(taskId: string, task: Task): void {
    if (this.#tasks.size >= MAX_TRACKED_TASKS) {
      this.#unknown = true;
      return;
    }
    this.#tasks.set(taskId, task);
  }
}
