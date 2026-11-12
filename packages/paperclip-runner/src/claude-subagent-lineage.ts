/**
 * Claude subagent lineage over ACPX tool events.
 *
 * Claude runs a subagent through its `Agent` (formerly `Task`) tool. With
 * native subagent sessions off, claude-agent-acp reports everything in the
 * parent ACP session:
 *
 * - the spawning call is an ordinary tool call whose `_meta.claudeCode.toolName`
 *   is `Agent`/`Task` and whose `rawInput` carries `subagent_type`,
 *   `description`, `prompt` and optionally `model`;
 * - each tool call the subagent makes carries
 *   `_meta.claudeCode.parentToolUseId`, the spawning call's id;
 * - Paperclip's claude-agent-acp patch forwards the SDK's
 *   `agentProgressSummaries` text as a `tool_call_update` on the spawning call
 *   with `_meta.claudeCode.subagentProgress`, and an async subagent's terminal
 *   state and summary with `_meta.claudeCode.subagentState`. An async
 *   subagent's tool call itself completes as soon as it launches ("Async agent
 *   launched"), so that completion does not settle the subagent.
 *
 * ACP updates are deltas, so identity, prompt and the latest progress summary
 * arrive on different frames. This tracker remembers them per tool call and
 * annotates each event with a complete `paperclipSubagent` (spawning call) or
 * `paperclipParentToolCallId` (child call). The canonical mapper reads only
 * those annotations. All values are producer hints and grant no authority.
 */
import { createHash } from "node:crypto";
import type { AcpRuntimeEventShape } from "./provider-events.js";

export type AcpxSubagentState = "running" | "completed" | "failed" | "interrupted";

export interface AcpxSubagentIdentity {
  role: string | null;
  description: string | null;
  prompt: string | null;
  model: string | null;
  progress: string | null;
  /** Lifecycle owned by the subagent, when it differs from its tool call. */
  state: AcpxSubagentState | null;
  /** Subagent result text, when the provider reported one. */
  result: string | null;
  /** The tool call returned at launch; the subagent runs in the background. */
  async: boolean;
}

export interface AcpxSubagentAnnotations {
  paperclipSubagent?: AcpxSubagentIdentity;
  paperclipParentToolCallId?: string;
}

const SUBAGENT_TOOL_NAMES = new Set(["agent", "task"]);
const MAX_TRACKED = 256;
// Matches the sidecar tool identity bound (MAX_RUNTIME_ITEM_ID_CHARS in Rust).
const MAX_ID_BYTES = 240;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

const MAX_RESULT_CHARS = 4_000;
const TRUNCATED_RESULT_MARKER = "\n\n[Result truncated]";

/** Bound a result to the schema limit, marking a cut so it never reads as complete. */
function boundedResult(value: string | null): string | null {
  if (!value) return null;
  return value.length > MAX_RESULT_CHARS
    ? `${value.slice(0, MAX_RESULT_CHARS - TRUNCATED_RESULT_MARKER.length).trimEnd()}${TRUNCATED_RESULT_MARKER}`
    : value;
}

/** Text of an ACP tool result: a string or text content blocks, untruncated. */
export function acpToolResultText(rawOutput: unknown, max = 256_000): string | null {
  if (typeof rawOutput === "string") return rawOutput.trim().slice(0, max) || null;
  const blocks = Array.isArray(rawOutput) ? rawOutput : [];
  const joined = blocks
    .flatMap((block) => {
      const value = record(block);
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n\n")
    .trim();
  return joined.slice(0, max) || null;
}

const ASYNC_LAUNCH = /^Async agent launched/i;

function subagentState(value: unknown): AcpxSubagentState | null {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (status === "completed") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (["killed", "stopped", "cancelled", "canceled"].includes(status)) return "interrupted";
  return null;
}

/**
 * runner-core's `acpx_opaque_item_id(value, _, "tool")`: the PRP item id Rust
 * gives an ACPX tool call (and a child's `parentItemId`). The sidecar uses it
 * for delegation ids so a parent and its children always agree.
 */
export function acpxOpaqueToolItemId(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && Buffer.byteLength(value) <= 160) return value;
  const digest = createHash("sha256")
    .update("paperclip.acpx.opaque-item.v1\0tool\0")
    .update(value)
    .digest("hex");
  return `acpx-tool-${digest}`;
}

function boundedId(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return Buffer.byteLength(value) <= MAX_ID_BYTES ? value : null;
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key) && map.size >= MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export function createClaudeSubagentLineageTracker<
  T extends AcpRuntimeEventShape,
>(projectToolCallId: (toolCallId: string) => string = (id) => id): (event: T) => T & AcpxSubagentAnnotations {
  const subagents = new Map<string, AcpxSubagentIdentity>();
  const parents = new Map<string, string>();
  return (event) => {
    if (event.type !== "tool_call" || typeof event.toolCallId !== "string") return event;
    const toolCallId = event.toolCallId;
    const claudeCode = record(record(event._meta).claudeCode);
    const toolName = shortText(claudeCode.toolName, 160)?.toLowerCase() ?? null;
    const input = record(event.rawInput);
    const progress = record(claudeCode.subagentProgress);
    const known = subagents.get(toolCallId);
    const isSubagent =
      known !== undefined ||
      (toolName !== null && SUBAGENT_TOOL_NAMES.has(toolName)) ||
      typeof input.subagent_type === "string";
    if (isSubagent) {
      const terminal = record(claudeCode.subagentState);
      const output = acpToolResultText(event.rawOutput);
      const launchedAsync = output !== null && ASYNC_LAUNCH.test(output);
      const reported = subagentState(terminal.status);
      const next: AcpxSubagentIdentity = {
        role: shortText(input.subagent_type, 160) ?? known?.role ?? null,
        description: shortText(input.description, 4_000) ?? known?.description ?? null,
        prompt: shortText(input.prompt, 4_000) ?? known?.prompt ?? null,
        model: shortText(input.model, 240) ?? known?.model ?? null,
        progress:
          shortText(progress.summary, 4_000) ??
          shortText(progress.description, 4_000) ??
          known?.progress ??
          null,
        async: known?.async === true || launchedAsync,
        state:
          reported ??
          known?.state ??
          (known?.async === true || launchedAsync ? "running" : null),
        result:
          boundedResult(shortText(terminal.summary, MAX_RESULT_CHARS + 1)) ??
          known?.result ??
          (launchedAsync ? null : boundedResult(output)),
      };
      remember(subagents, toolCallId, next);
      return { ...event, paperclipSubagent: next };
    }
    const rawParent = boundedId(claudeCode.parentToolUseId);
    const parent = rawParent ? projectToolCallId(rawParent) : parents.get(toolCallId);
    if (!parent || parent === toolCallId) return event;
    remember(parents, toolCallId, parent);
    return { ...event, paperclipParentToolCallId: parent };
  };
}
