export type WorkSignalDebugOptions = {
  spec?: string;
  defaultSampleEvery?: number;
  maxLinesPerSecond?: number;
  flushIntervalMs?: number;
  sink?: (text: string) => void;
  now?: () => number;
  captureStack?: () => string | undefined;
};

export type WorkSignalDebugFields = Record<string, string | number | boolean | null | undefined>;

const DROPPED_FRAMES = /node_modules|node:internal|work-signals\.(ts|js)|work-signal-debug\.(ts|js)|delivery-work-notifications\.(ts|js)/;

export function parseWorkSignalDebugSpec(spec: string | undefined, defaultSampleEvery = 20): Map<string, number> {
  const topics = new Map<string, number>();
  for (const part of (spec ?? "").split(",")) {
    const [rawTopic, rawEvery] = part.trim().split(":");
    const topic = rawTopic?.trim();
    if (!topic || !/^[a-z0-9:_-]{1,200}$/i.test(topic)) continue;
    const every = Number(rawEvery);
    topics.set(topic, Number.isInteger(every) && every >= 1 ? every : defaultSampleEvery);
  }
  return topics;
}

export function trimWorkSignalStack(stack: string | undefined, frames = 10): string[] {
  if (!stack) return [];
  return stack.split("\n").slice(1).map(line => line.trim()).filter(line => line.startsWith("at ") && !DROPPED_FRAMES.test(line))
    .slice(0, frames)
    .map(line => line.replace(/(?:file:\/\/)?\/[^\s()]*?\/((?:server|packages|cli|ui|scripts)\/[^\s()]+)/g, "$1"));
}

export function createWorkSignalDebug(options: WorkSignalDebugOptions = {}) {
  const topics = parseWorkSignalDebugSpec(options.spec, options.defaultSampleEvery);
  const enabled = topics.size > 0;
  const now = options.now ?? Date.now;
  const maxLines = options.maxLinesPerSecond ?? 10;
  const sink = options.sink ?? ((text: string) => { process.stderr.write(text); });
  const captureStack = options.captureStack ?? (() => new Error().stack);
  const counts = new Map<string, number>();
  const pending: string[] = [];
  let windowStart = 0, windowLines = 0, suppressed = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  function emit(entry: Record<string, unknown>) {
    const at = now();
    if (at - windowStart >= 1000) { windowStart = at; windowLines = 0; }
    if (windowLines >= maxLines) { suppressed += 1; return; }
    windowLines += 1;
    pending.push(JSON.stringify({ msg: "paperclip work signal debug", at, ...entry }));
    if (!timer && options.flushIntervalMs !== 0) {
      timer = setInterval(flush, options.flushIntervalMs ?? 1000);
      timer.unref?.();
    }
  }

  function sampled(topic: string) {
    const count = counts.get(topic) ?? 0;
    counts.set(topic, count + 1);
    return count % (topics.get(topic) ?? 1) === 0;
  }

  function flush() {
    if (suppressed > 0) {
      pending.push(JSON.stringify({ msg: "paperclip work signal debug", at: now(), event: "suppressed", count: suppressed }));
      suppressed = 0;
    }
    if (pending.length === 0) {
      if (timer) { clearInterval(timer); timer = null; }
      return;
    }
    const lines = pending.splice(0);
    sink(lines.join("\n") + "\n");
  }

  return {
    get enabled() { return enabled; },
    signal(topic: string, hint: string | undefined) {
      if (!enabled || !topics.has(topic)) return;
      const stack = sampled(topic) ? trimWorkSignalStack(captureStack()) : undefined;
      emit({ event: "signal", topic, ...(hint === undefined ? {} : { hint }), ...(stack ? { stack } : {}) });
    },
    event(topic: string, event: string, fields: WorkSignalDebugFields = {}, withStack = false) {
      if (!enabled || !topics.has(topic)) return;
      const stack = withStack && sampled(topic) ? trimWorkSignalStack(captureStack()) : undefined;
      emit({ event, topic, ...fields, ...(stack ? { stack } : {}) });
    },
    flush,
  };
}

export const workSignalDebug = createWorkSignalDebug({ spec: process.env.PAPERCLIP_DEBUG_WORK_SIGNALS });
