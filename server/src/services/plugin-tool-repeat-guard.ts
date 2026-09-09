import { canonicalToolArguments } from "./tool-content-guards.js";

// Advisory repeat-call guard for plugin tool dispatch, borrowed from the
// DeepSeek Harness `repeat-tool-reminder` guard: notice identical consecutive
// tool calls and nudge the agent to change approach. The notice advises; it
// never blocks. Wording stays declarative so the content-guard
// prompt-injection scanner never flags our own reminder.

export const REPEAT_TOOL_REMINDER_THRESHOLDS = [3, 5, 8] as const;

/** Cap on tracked (agent, run) chains; resets the map instead of growing it. */
const MAX_TRACKED_CHAINS = 10_000;

interface RepeatChain {
  key: string;
  count: number;
}

function chainScope(agentId: string, runId: string): string {
  return `${agentId}\n${runId}`;
}

function callKey(toolName: string, parameters: unknown): string {
  return JSON.stringify([toolName, canonicalToolArguments(parameters)]);
}

const REPEAT_TOOL_GENTLE_NOTICE =
  "Loop guard: this is the same tool call with identical arguments as the " +
  "previous calls. Review the last result before calling again: when the " +
  "task is incomplete, a different approach or different arguments usually " +
  "help more than repeating the call.";

function detailedRepeatToolNotice(toolName: string, count: number, preview: string): string {
  return (
    "Loop guard: repeated tool calls are not making progress.\n" +
    `- tool: ${toolName}\n` +
    `- consecutive_calls: ${count}\n` +
    `- arguments: ${preview}\n` +
    "The repeated calls returned the same outcome. Inspect the latest " +
    "result and choose a different action, different arguments, or finish " +
    "the task when enough evidence is gathered."
  );
}

function previewArguments(canonical: string, cap = 500): string {
  if (canonical.length <= cap) return canonical;
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`;
}

export function buildRepeatToolNotice(
  toolName: string,
  count: number,
  canonicalArguments: string,
  thresholds: ReadonlyArray<number> = REPEAT_TOOL_REMINDER_THRESHOLDS,
): string | null {
  if (!thresholds.includes(count)) return null;
  if (count === thresholds[0]) return REPEAT_TOOL_GENTLE_NOTICE;
  return detailedRepeatToolNotice(toolName, count, previewArguments(canonicalArguments));
}

/**
 * Per-process tracker of consecutive identical tool calls, scoped by
 * (agent, run). A new run starts a fresh chain automatically, like a user
 * message resets the reference implementation.
 */
export function createRepeatToolTracker(
  thresholds: ReadonlyArray<number> = REPEAT_TOOL_REMINDER_THRESHOLDS,
) {
  const chains = new Map<string, RepeatChain>();

  return {
    observe(input: {
      agentId: string;
      runId: string;
      toolName: string;
      parameters: unknown;
    }): { repeatCount: number; notice: string | null } {
      const scope = chainScope(input.agentId, input.runId);
      const key = callKey(input.toolName, input.parameters);
      const previous = chains.get(scope);
      const count = previous !== undefined && previous.key === key ? previous.count + 1 : 1;
      if (chains.size >= MAX_TRACKED_CHAINS && !chains.has(scope)) {
        chains.clear();
      }
      chains.set(scope, { key, count });
      const canonical = canonicalToolArguments(input.parameters);
      return {
        repeatCount: count,
        notice: buildRepeatToolNotice(input.toolName, count, canonical, thresholds),
      };
    },

    chainCountForTests(): number {
      return chains.size;
    },
  };
}

export type RepeatToolTracker = ReturnType<typeof createRepeatToolTracker>;

let sharedTracker: RepeatToolTracker | null = null;

/** Process-wide tracker used by the tool registry dispatch path. */
export function getSharedRepeatToolTracker(): RepeatToolTracker {
  if (!sharedTracker) sharedTracker = createRepeatToolTracker();
  return sharedTracker;
}
