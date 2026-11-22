export type WorkSignalDebugOptions = {
  spec?: string;
  defaultSampleEvery?: number;
  maxLinesPerSecond?: number;
  flushIntervalMs?: number;
  sink?: (text: string) => void;
  now?: () => number;
  captureStack?: (entry: Function) => string | undefined;
};

export type WorkSignalDebugFields = Record<string, string | number | boolean | null | undefined>;
export type WorkSignalDebugStack = "none" | "sampled" | "always";

const DROPPED_FILES = /node_modules|node:internal|work-signals\.(ts|js)|work-signal-debug\.(ts|js)|delivery-work-notifications\.(ts|js)/;
const DROPPED_FUNCTIONS = new Set(["signalDatabaseWork", "publishDatabaseWorkSettled", "notifyDeliveryWork",
  "captureWorkSignalStack", "processTicksAndRejections"]);
const STACK_LIMIT = 40;

export function parseWorkSignalDebugSpec(spec: string | undefined, defaultSampleEvery = 20): Map<string, number> {
  const topics = new Map<string, number>();
  for (const part of (spec ?? "").split(",")) {
    const match = /^(.+?)(?::(\d+))?$/.exec(part.trim());
    const topic = match?.[1]?.trim();
    if (!topic || !/^[a-z0-9:_-]{1,200}$/i.test(topic) || topic.startsWith(":") || topic.endsWith(":")) continue;
    const every = Number(match?.[2]);
    topics.set(topic, Number.isInteger(every) && every >= 1 ? every : defaultSampleEvery);
  }
  return topics;
}

function frameFunction(line: string) {
  const match = /^at (?:async )?(?:new )?([^\s(]+)(?: \[as [^\]]+\])? \(/.exec(line);
  if (!match) return null;
  const name = match[1]!;
  return name.slice(name.lastIndexOf(".") + 1);
}

export function trimWorkSignalStack(stack: string | undefined, frames = 10): string[] {
  if (!stack) return [];
  return stack.split("\n").slice(1).map(line => line.trim())
    .filter(line => line.startsWith("at ") && !DROPPED_FILES.test(line) && !DROPPED_FUNCTIONS.has(frameFunction(line) ?? ""))
    .slice(0, frames);
}

export function captureWorkSignalStack(entry: Function): string | undefined {
  const holder: { stack?: string } = {};
  const limit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = STACK_LIMIT;
    Error.captureStackTrace(holder, entry);
  } finally {
    Error.stackTraceLimit = limit;
  }
  return holder.stack;
}

export function createWorkSignalDebug(options: WorkSignalDebugOptions = {}) {
  const topics = parseWorkSignalDebugSpec(options.spec, options.defaultSampleEvery);
  const enabled = topics.size > 0;
  const now = options.now ?? Date.now;
  const maxLines = options.maxLinesPerSecond ?? 10;
  const sink = options.sink ?? ((text: string) => { process.stderr.write(text); });
  const captureStack = options.captureStack ?? captureWorkSignalStack;
  const counts = new Map<string, number>();
  const budgets = new Map<string, { windowStart: number; lines: number; suppressed: number; topic: string; event: string }>();
  const pending: string[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  function admit(topic: string, event: string) {
    const at = now();
    const key = `${topic}\u0000${event}`;
    let budget = budgets.get(key);
    if (!budget) budgets.set(key, budget = { windowStart: at, lines: 0, suppressed: 0, topic, event });
    if (at - budget.windowStart >= 1000) { budget.windowStart = at; budget.lines = 0; }
    schedule();
    if (budget.lines >= maxLines) { budget.suppressed += 1; return false; }
    budget.lines += 1;
    return true;
  }

  function emit(topic: string, event: string, entry: Record<string, unknown>) {
    pending.push(JSON.stringify({ msg: "paperclip work signal debug", at: now(), event, topic, ...entry }));
  }

  function schedule() {
    if (timer || options.flushIntervalMs === 0) return;
    timer = setInterval(flush, options.flushIntervalMs ?? 1000);
    timer.unref?.();
  }

  function sampled(topic: string, event: string) {
    const key = `${topic}\u0000${event}`;
    const count = counts.get(key) ?? 0;
    counts.set(key, count + 1);
    return count % (topics.get(topic) ?? 1) === 0;
  }

  function stackFor(topic: string, event: string, mode: WorkSignalDebugStack, entry: Function) {
    if (mode === "none" || (mode === "sampled" && !sampled(topic, event))) return undefined;
    return trimWorkSignalStack(captureStack(entry));
  }

  function flush() {
    for (const budget of budgets.values()) {
      if (budget.suppressed === 0) continue;
      pending.push(JSON.stringify({ msg: "paperclip work signal debug", at: now(), event: "suppressed",
        topic: budget.topic, suppressedEvent: budget.event, count: budget.suppressed }));
      budget.suppressed = 0;
    }
    if (pending.length === 0) {
      if (timer) { clearInterval(timer); timer = null; }
      return;
    }
    sink(pending.splice(0).join("\n") + "\n");
  }

  function signal(topic: string, hint: string | undefined, entry: Function = signal) {
    if (!enabled || !topics.has(topic) || !admit(topic, "signal")) return;
    const stack = stackFor(topic, "signal", "sampled", entry);
    emit(topic, "signal", { ...(hint === undefined ? {} : { hint }), ...(stack ? { stack } : {}) });
  }

  function event(topic: string, name: string, fields: WorkSignalDebugFields = {},
    stack: WorkSignalDebugStack = "none", entry: Function = event) {
    if (!enabled || !topics.has(topic) || !admit(topic, name)) return;
    const frames = stackFor(topic, name, stack, entry);
    emit(topic, name, { ...fields, ...(frames ? { stack: frames } : {}) });
  }

  return {
    get enabled() { return enabled; },
    allows(topic: string) { return enabled && topics.has(topic); },
    signal,
    event,
    flush,
  };
}

export const workSignalDebug = createWorkSignalDebug({ spec: process.env.PAPERCLIP_DEBUG_WORK_SIGNALS });
