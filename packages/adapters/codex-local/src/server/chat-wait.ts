import type { RuntimeStatusSink } from "@paperclipai/adapter-utils";

const slowTurnMs = 30_000;
// The server expires live run status after 90s. Keep a known wait visible,
// preserving the time of the last real provider event.
const refreshMs = 60_000;
const maxLineChars = 16_384;

function retryStatus(event: Record<string, unknown>) {
  const message = typeof event.message === "string" ? event.message : "";
  const attempt = /^Reconnecting\b[.\s]*(\d{1,3})\s*\/\s*(\d{1,3})\b/i.exec(message);
  if (!attempt) return null;
  const reason = /\b429\b/.test(message) ? "model rate limit (HTTP 429)"
    : /timed?\s*out|timeout/i.test(message) ? "model request timed out" : "connection interrupted";
  const seconds = event.retry_after_seconds;
  const delay = typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0
    ? seconds : Number(/\b(?:retry-after:\s*|retry in\s+)(\d{1,8})(?:\s*(?:seconds?|s)\b|(?=\s*$))/i.exec(message)?.[1]);
  const date = typeof event.retry_at === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(event.retry_at)
    ? Date.parse(event.retry_at) : NaN;
  const deadline = Number.isFinite(date) ? date : Date.now() + delay * 1000;
  const when = Number.isFinite(new Date(deadline).getTime()) ? `; retry at ${new Date(deadline).toISOString()}` : "";
  return `Codex: ${reason}. Reconnecting ${attempt[1]}/${attempt[2]}${when}`;
}

/** Observe one CLI attempt. Codex retains the input and owns the actual retries. */
export function observeChatWait(sink: RuntimeStatusSink) {
  let fragment = "";
  let oversized = false;
  let waiting: string | null = null;
  let eventAt = new Date();
  let pending = Promise.resolve();
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function emit(message: string) {
    const version = revision;
    const lastEventAt = eventAt;
    pending = pending.then(async () => {
      if (version === revision) await sink({ phase: "run_activity", message, lastEventAt });
    }).catch(() => { /* Status transport cannot fail a provider turn. */ });
  }

  function showWait(message: string) {
    clearTimeout(timer);
    waiting = message;
    emit(message);
    timer = setTimeout(() => showWait(message), refreshMs);
    timer.unref();
  }

  function handle(line: string) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== "object") return;
    if (event.type === "error") {
      const notice = retryStatus(event);
      if (notice) {
        revision++;
        eventAt = new Date();
        showWait(notice);
      }
    } else if (event.type === "turn.started") {
      clearTimeout(timer);
      eventAt = new Date();
      timer = setTimeout(() => showWait("Waiting for the model to respond"), slowTurnMs);
      timer.unref();
    } else if (["item.started", "item.updated", "item.completed", "turn.completed", "turn.failed"].includes(event.type)) {
      clearTimeout(timer);
      if (waiting) {
        revision++;
        eventAt = new Date();
        emit(event.type === "turn.failed" ? "Model request failed" : "Receiving agent output");
        waiting = null;
      }
    }
  }

  return {
    stdout(chunk: string) {
      for (let start = 0; start < chunk.length;) {
        const end = chunk.indexOf("\n", start);
        const stop = end < 0 ? chunk.length : end;
        if (fragment.length + stop - start > maxLineChars) oversized = true;
        if (!oversized) fragment += chunk.slice(start, stop);
        if (end < 0) break;
        if (!oversized) handle(fragment);
        fragment = "";
        oversized = false;
        start = end + 1;
      }
    },
    stop() {
      clearTimeout(timer);
      revision++;
      fragment = "";
    },
  };
}
