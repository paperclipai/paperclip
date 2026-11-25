import type { AcpRuntimeEvent } from "acpx/runtime";

/**
 * The Antigravity CLI coordinator reports its swarm through its own tools
 * (`swarm`, `read_board`, `post_message`, `swarm_wait`). Helper conversations
 * never reach the client. Turn those calls into short readable steps, and keep
 * provider ids, tool names and terminal hints out of what users see.
 */
type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

const SWARM_TOOLS = new Set(["swarm", "read_board", "post_message", "swarm_wait"]);
const TERMINAL_HINT = /\n?Run \/swarm board \(default shortcut [^)]*\) to open the live board\.?/g;

export function stripAntigravityTerminalHints(text: string): string {
  return text.replace(TERMINAL_HINT, "");
}

const HINT_PREFIX = "Run /swarm board (default shortcut ";
const HINT_SUFFIX = ") to open the live board.";
const HINT_SHORTCUT_MAX = 40;
const HINT_MAX = 1 + HINT_PREFIX.length + HINT_SHORTCUT_MAX + HINT_SUFFIX.length;

/** Whether `tail` (after one optional line break) is the start of a terminal hint that more text could complete. */
function unfinishedHint(tail: string): boolean {
  const body = tail.startsWith("\n") ? tail.slice(1) : tail;
  if (body.length <= HINT_PREFIX.length) return HINT_PREFIX.startsWith(body);
  if (!body.startsWith(HINT_PREFIX)) return false;
  const rest = body.slice(HINT_PREFIX.length);
  const close = rest.indexOf(")");
  if (close < 0) return rest.length <= HINT_SHORTCUT_MAX && !rest.includes("\n");
  // A complete hint is held too, until the next text shows whether its closing period follows.
  return close <= HINT_SHORTCUT_MAX && HINT_SUFFIX.startsWith(rest.slice(close));
}

/**
 * The CLI streams its terminal hint in pieces (live: `Run /swarm board (`, then
 * `default shortcut alt+s) to open the live board`, then `.`), so stripping each
 * chunk alone misses it and leaves a stray period. Text that could still become
 * a hint is held back until the hint completes or is ruled out.
 */
export function createAntigravityTerminalHintFilter(): { push(text: string): string; flush(): string } {
  let held = "";
  return {
    push(text) {
      const value = held + text;
      let start = -1;
      for (let index = Math.max(0, value.length - HINT_MAX); index < value.length; index++) {
        if ((value[index] === "\n" || value[index] === "R") && unfinishedHint(value.slice(index))) { start = index; break; }
      }
      held = start < 0 ? "" : value.slice(start);
      return stripAntigravityTerminalHints(start < 0 ? value : value.slice(0, start));
    },
    flush() {
      const value = stripAntigravityTerminalHints(held);
      held = "";
      return value;
    },
  };
}

function plain(text: string, workspace: string, limit = 120): string {
  let value = text.split(workspace).join("the task folder")
    .replace(/@[a-z0-9_-]+\s*/gi, "").replace(/\[(?:done|blocked|update)\]\s*/gi, "").replace(/\s+/g, " ").trim();
  // First sentence only: briefs carry board protocol after it.
  const sentence = /^(.+?[.!?])(\s|$)/.exec(value)?.[1];
  if (sentence) value = sentence.replace(/[.!?]$/, "");
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function swarmTitle(name: string, args: Json, workspace: string): string | null {
  if (name === "read_board") return "Checked on the helpers";
  if (name === "swarm_wait") return "Waiting for the helpers";
  if (name === "post_message") return typeof args.text === "string" && args.text.trim() ? `Coordinator: ${plain(args.text, workspace)}` : "Coordinator posted an update";
  if (name !== "swarm") return null;
  const helper = typeof args.name === "string" ? args.name.replace(/[^a-zA-Z0-9 _.-]/g, "").slice(0, 40) : "";
  switch (args.action) {
    case "add":
      if (/^monitor$/i.test(helper)) return "Started a helper that watches for stalls";
      return typeof args.brief === "string" && args.brief.trim()
        ? `Started helper ${helper || "(unnamed)"}: ${plain(args.brief, workspace)}`
        : `Started helper ${helper || "(unnamed)"}`;
    case "title": return typeof args.title === "string" ? `Swarm: ${plain(args.title, workspace)}` : "Named the swarm";
    case "remove": case "kill": case "stop": return helper ? `Stopped helper ${helper}` : "Stopped a helper";
    case "status": return "Checked on the helpers";
    default: return "Coordinated the helpers";
  }
}

/** One ACP `session/update` as a runtime event, or null when it carries nothing to show. */
export function antigravitySwarmEvent(update: unknown, workspace: string): AcpRuntimeEvent | null {
  const value = record(update);
  const kind = value.sessionUpdate;
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const content = record(value.content);
    if (content.type !== "text" || typeof content.text !== "string") return null;
    // Raw: the hint can span chunks, so the runtime's streaming filter strips it (createAntigravityTerminalHintFilter).
    const text = content.text;
    if (!text) return null;
    return { type: "text_delta", text, stream: kind === "agent_thought_chunk" ? "thought" : "output", tag: kind };
  }
  if (kind !== "tool_call" && kind !== "tool_call_update") return null;
  if (typeof value.toolCallId !== "string" || !value.toolCallId) return null;
  const name = typeof value.name === "string" ? value.name : "";
  const args = { ...record(value.rawInput), ...record(value.args) };
  const status = typeof value.status === "string" ? value.status : undefined;
  if (SWARM_TOOLS.has(name)) {
    const title = swarmTitle(name, args, workspace) ?? "Coordinated the helpers";
    return { type: "tool_call", tag: kind, toolCallId: value.toolCallId, text: title, title, kind: "other", ...(status ? { status } : {}) };
  }
  const title = typeof value.title === "string" ? value.title.split(workspace).join(".") : name || "Tool call";
  return {
    type: "tool_call", tag: kind, toolCallId: value.toolCallId, text: title, title,
    ...(typeof value.kind === "string" ? { kind: value.kind as never } : {}),
    ...(status ? { status } : {}),
    ...(value.rawInput !== undefined ? { rawInput: value.rawInput } : {}),
    ...(value.rawOutput !== undefined ? { rawOutput: value.rawOutput } : {}),
    ...(Array.isArray(value.content) ? { content: value.content as never } : {}),
    ...(Array.isArray(value.locations) ? { locations: value.locations as never } : {}),
  };
}
