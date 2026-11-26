import { createHash } from "node:crypto";

export interface RunSpan {
  name: string;
  startOffsetMs: number;
  durationMs: number;
}

export interface RunEvent {
  eventType: string;
  createdAt: string;
  payload?: Record<string, unknown> | null;
}

export function taskNonce(label: string, index: number): string {
  return createHash("sha256").update(`${label}:${index}`).digest("hex").slice(0, 10);
}

export function taskTitle(tag: string, nonce: string): string {
  return `${tag} Scale ramp task ${nonce}`;
}

export function taskBrief(nonce: string): string {
  return [
    `Scale ramp task ${nonce}. Do these steps in order and nothing else:`,
    `1. Write one short sentence saying you are starting task ${nonce}.`,
    "2. Run the shell command `pwd`, then run `ls`.",
    `3. Write a file named \`scale-${nonce}.txt\` in the workspace root containing the single line \`${nonce}\`.`,
    `4. Run the shell command \`cat scale-${nonce}.txt\`.`,
    `5. Post a comment on this task that says \`CHECKPOINT ${nonce}\`.`,
    `6. Post a final comment that says \`DONE ${nonce}\`, then mark this task done.`,
    "Do not create other tasks, documents or files.",
  ].join("\n");
}

function spans(events: readonly RunEvent[]): RunSpan[] {
  const out: RunSpan[] = [];
  for (const event of events) {
    if (event.eventType !== "run.performance.span" || !event.payload) continue;
    const { span, startOffsetMs, durationMs } = event.payload as { span?: unknown; startOffsetMs?: unknown; durationMs?: unknown };
    if (typeof span === "string" && typeof startOffsetMs === "number" && typeof durationMs === "number") out.push({ name: span, startOffsetMs, durationMs });
  }
  return out;
}

export interface RunTiming {
  ttftMs: number | null;
  firstActivityMs: number | null;
}

const ACTIVITY_EVENTS = new Set(["item.delta", "tool.execution.started", "item.started"]);

export function runTiming(events: readonly RunEvent[], runCreatedAt: number | null): RunTiming {
  const all = spans(events);
  const first = (name: string) => all.find(span => span.name === name) ?? null;
  const queue = first("heartbeat.queue");
  const fromRunCreated = (span: RunSpan) => queue ? Math.max(0, span.startOffsetMs + span.durationMs - queue.startOffsetMs) : span.durationMs;
  const fallback = (types: ReadonlySet<string>) => {
    if (runCreatedAt === null) return null;
    const at = events.filter(event => types.has(event.eventType)).map(event => Date.parse(event.createdAt)).filter(Number.isFinite);
    return at.length ? Math.max(0, Math.min(...at) - runCreatedAt) : null;
  };
  const ttft = first("task.time_to_first_token");
  const activity = first("task.time_to_first_agent_activity");
  return {
    ttftMs: ttft ? fromRunCreated(ttft) : fallback(new Set(["item.delta"])),
    firstActivityMs: activity ? fromRunCreated(activity) : fallback(ACTIVITY_EVENTS),
  };
}
