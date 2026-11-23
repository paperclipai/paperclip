import type { DemoTask, DemoTaskStore } from "./store.js";

/**
 * The demo tools. Each one shows one MCP Tasks behaviour. None of them touch
 * anything outside this process: the "work" is the clock running.
 */
export const DEMO_TOOLS = [
  {
    name: "slow_report",
    description: "Writes a short report after a delay (default 20 seconds). Returns a task right away, then the report when the delay has passed. Shows polling.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What the report is about." },
        seconds: { type: "integer", minimum: 1, maximum: 3600, description: "How long the report takes. Default 20." },
      },
    },
    annotations: { readOnlyHint: true, title: "Slow report" },
  },
  {
    name: "needs_approval",
    description: "Pretends to perform an action that a person must approve first. The task asks a question (approve or reject) and finishes after the person answers. Shows input_required and tasks/update.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", description: "The action that needs approval." } },
    },
    annotations: { readOnlyHint: true, title: "Needs approval" },
  },
  {
    name: "will_fail",
    description: "Starts work that fails after a few seconds (default 5). Shows a failed task.",
    inputSchema: {
      type: "object",
      properties: { seconds: { type: "integer", minimum: 1, maximum: 3600, description: "Seconds before it fails. Default 5." } },
    },
    annotations: { readOnlyHint: true, title: "Will fail" },
  },
  {
    name: "cancellable",
    description: "Starts long work (default 10 minutes) that stops cleanly when cancelled. Shows tasks/cancel.",
    inputSchema: {
      type: "object",
      properties: { seconds: { type: "integer", minimum: 1, maximum: 86400, description: "How long the work runs. Default 600." } },
    },
    annotations: { readOnlyHint: true, title: "Cancellable" },
  },
  {
    name: "expires",
    description: "Starts work that outlives its own short TTL (default 15 seconds), so the server forgets the task before it finishes. Shows an expired task.",
    inputSchema: {
      type: "object",
      properties: { ttlSeconds: { type: "integer", minimum: 1, maximum: 3600, description: "The task's TTL. Default 15." } },
    },
    annotations: { readOnlyHint: true, title: "Expires" },
  },
  {
    name: "quick_echo",
    description: "Answers immediately, without a task. Shows that ordinary calls are unchanged.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
    },
    annotations: { readOnlyHint: true, title: "Quick echo" },
  },
] as const;

export type DemoToolName = (typeof DEMO_TOOLS)[number]["name"];

const HOUR_MS = 60 * 60_000;
const POLL_INTERVAL_MS = 2_000;
/** How long `needs_approval` keeps working after the person answers. */
export const APPROVAL_FOLLOW_UP_MS = 3_000;

export const APPROVAL_FORM = {
  method: "elicitation/create",
  params: {
    mode: "form",
    message: "Approve this demo action?",
    requestedSchema: {
      type: "object",
      properties: {
        decision: { type: "string", title: "Decision", enum: ["approve", "reject"] },
        note: { type: "string", title: "Note for the agent (optional)" },
      },
      required: ["decision"],
    },
  },
} as const;

function intArg(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? Math.min(value, max) : fallback;
}

function text(value: string, structured?: Record<string, unknown>, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text: value }], ...(structured ? { structuredContent: structured } : {}), isError };
}

export type ToolCallOutcome =
  | { kind: "result"; result: Record<string, unknown> }
  | { kind: "task"; task: DemoTask };

/**
 * Run a tool. `tasks` says whether this request declared the Tasks extension;
 * a server must never return a task to a request that did not.
 */
export function callDemoTool(store: DemoTaskStore, name: string, args: Record<string, unknown>, tasks: boolean): ToolCallOutcome | null {
  const now = store.now();
  const base = { tool: name, arguments: args, ttlMs: HOUR_MS, pollIntervalMs: POLL_INTERVAL_MS, outcome: "complete" as const };
  switch (name) {
    case "quick_echo":
      return { kind: "result", result: text(`echo: ${typeof args.text === "string" ? args.text : ""}`) };
    case "slow_report": {
      const seconds = intArg(args, "seconds", 20, 3600);
      if (!tasks) return { kind: "result", result: text(`This client does not support MCP Tasks, so the ${seconds}-second report was skipped.`, undefined, true) };
      return { kind: "task", task: store.create({ ...base, status: "working", settlesAt: now + seconds * 1000, ttlMs: seconds * 1000 + HOUR_MS }) };
    }
    case "needs_approval":
      if (!tasks) return { kind: "result", result: text("This action needs a person's approval, which requires a client that supports MCP Tasks.", undefined, true) };
      return { kind: "task", task: store.create({ ...base, status: "input_required", settlesAt: null, inputRequests: { approval: structuredClone(APPROVAL_FORM) as never } }) };
    case "will_fail": {
      const seconds = intArg(args, "seconds", 5, 3600);
      if (!tasks) return { kind: "result", result: text("The demo failure needs a client that supports MCP Tasks.", undefined, true) };
      return { kind: "task", task: store.create({ ...base, status: "working", settlesAt: now + seconds * 1000, outcome: "fail", ttlMs: seconds * 1000 + HOUR_MS }) };
    }
    case "cancellable": {
      const seconds = intArg(args, "seconds", 600, 86400);
      if (!tasks) return { kind: "result", result: text("The cancellable demo needs a client that supports MCP Tasks.", undefined, true) };
      return { kind: "task", task: store.create({ ...base, status: "working", settlesAt: now + seconds * 1000, ttlMs: Math.max(HOUR_MS, seconds * 2000) }) };
    }
    case "expires": {
      const ttlSeconds = intArg(args, "ttlSeconds", 15, 3600);
      if (!tasks) return { kind: "result", result: text("The expiry demo needs a client that supports MCP Tasks.", undefined, true) };
      // Works ten times longer than it is kept, so it is always forgotten first.
      return { kind: "task", task: store.create({ ...base, status: "working", ttlMs: ttlSeconds * 1000, settlesAt: now + ttlSeconds * 10_000 }) };
    }
    default:
      return null;
  }
}

/** Settle a `working` task whose time has come. Called on every read. */
export function advanceDemoTask(store: DemoTaskStore, task: DemoTask): DemoTask {
  if (task.status !== "working" || task.settlesAt === null || store.now() < task.settlesAt) return task;
  if (task.outcome === "fail") {
    store.update(task, { status: "failed", error: { code: -32603, message: "The demo job crashed on purpose (will_fail)." } });
    store.log({ method: "settled", tool: task.tool, taskId: task.taskId, detail: "failed" });
    return task;
  }
  store.update(task, { status: "completed", result: resultFor(task) });
  store.log({ method: "settled", tool: task.tool, taskId: task.taskId, detail: "completed" });
  return task;
}

function resultFor(task: DemoTask): Record<string, unknown> {
  const seconds = Math.round(((task.settlesAt ?? task.createdAt) - task.createdAt) / 1000);
  if (task.tool === "needs_approval") {
    const note = typeof task.answer?.note === "string" && task.answer.note ? ` Note: ${task.answer.note}` : "";
    const action = typeof task.arguments.action === "string" ? task.arguments.action : "the demo action";
    return text(`Approved: ${action} was carried out.${note}`, { approved: true, action, note: task.answer?.note ?? null });
  }
  if (task.tool === "slow_report") {
    const topic = typeof task.arguments.topic === "string" && task.arguments.topic ? task.arguments.topic : "nothing in particular";
    return text(`Report on ${topic}: finished after ${seconds} seconds and ${task.polls} status checks.`, { topic, seconds });
  }
  return text(`${task.tool} finished after ${seconds} seconds.`, { seconds });
}

/** A human-readable progress line for `statusMessage`. */
export function statusMessageFor(store: DemoTaskStore, task: DemoTask): string | undefined {
  if (task.status === "input_required") return "Waiting for a person to approve or reject.";
  if (task.status !== "working" || task.settlesAt === null) return undefined;
  const total = Math.max(1, task.settlesAt - task.createdAt);
  const done = Math.min(total, Math.max(0, store.now() - task.createdAt));
  return `${Math.floor((done / total) * 100)}% done (${Math.round(done / 1000)} of ${Math.round(total / 1000)} s)`;
}

/**
 * Apply a person's answer from `tasks/update`. Answers the task is not
 * waiting for are ignored, as the specification requires.
 */
export function answerDemoTask(store: DemoTaskStore, task: DemoTask, inputResponses: Record<string, unknown>): void {
  if (task.status !== "input_required" || !task.inputRequests) return;
  const key = Object.keys(task.inputRequests)[0];
  const response = key ? inputResponses[key] as { action?: unknown; content?: Record<string, unknown> } | undefined : undefined;
  if (!response || typeof response !== "object") return;
  const content = response.content && typeof response.content === "object" ? response.content : {};
  if (response.action !== "accept" || content.decision === "reject") {
    store.update(task, {
      status: "completed",
      inputRequests: undefined,
      answer: content,
      result: text("Rejected: nothing was done.", { approved: false }),
    });
    store.log({ method: "answered", tool: task.tool, taskId: task.taskId, detail: `rejected (${String(response.action)})` });
    return;
  }
  if (content.decision !== "approve") {
    // Ask again under a new key: a client treats an answered key as done.
    const attempt = Number(/^approval-(\d+)$/.exec(key!)?.[1] ?? 1) + 1;
    store.update(task, { inputRequests: { [`approval-${attempt}`]: { ...structuredClone(APPROVAL_FORM), params: { ...structuredClone(APPROVAL_FORM.params), message: "Please choose approve or reject." } } as never } });
    store.log({ method: "answered", tool: task.tool, taskId: task.taskId, detail: "invalid answer; asked again" });
    return;
  }
  store.update(task, { status: "working", inputRequests: undefined, answer: content, settlesAt: store.now() + APPROVAL_FOLLOW_UP_MS });
  store.log({ method: "answered", tool: task.tool, taskId: task.taskId, detail: "approved" });
}
