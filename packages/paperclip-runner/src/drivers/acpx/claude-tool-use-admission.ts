/** `tools/call` `_meta` key on which the pinned Claude Code names the tool use behind each MCP call. */
export const CLAUDE_TOOL_USE_META_KEY = "claudecode/toolUseId";

/**
 * How long a call may wait for the ACP `tool_call` that announces its tool use.
 * Claude Code announces a tool use over ACP stdio before calling the tool over
 * MCP HTTP, but the two channels are independent and the announcement also
 * passes through the ACPX event queue. The measured lead was 1.1-14.7 ms; five
 * seconds absorbs scheduling and queue delay by orders of magnitude while an
 * unattributable call is refused promptly. The turn ending or the call being
 * cancelled ends the wait sooner.
 */
export const TOOL_USE_ANNOUNCEMENT_WAIT_MS = 5_000;

const MAX_TURN_ANNOUNCEMENTS = 4_096;
const MAX_ADMITTED_TOOL_USES = 8_192;
const TOOL_USE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Binds each Claude MCP tool call to the turn whose ACP stream announced its
 * tool use. A call is admitted only when its provider tool-use id was announced
 * in the active turn and no earlier call used that id. There is no fallback:
 * a call without an id, or with an id from another turn, is refused.
 */
export class ClaudeToolUseAdmission {
  #turnId: string | null = null;
  readonly #announced = new Set<string>();
  readonly #admitted = new Set<string>();
  readonly #waiters = new Set<() => void>();
  readonly #waitMs: number;

  constructor(waitMs = TOOL_USE_ANNOUNCEMENT_WAIT_MS) {
    this.#waitMs = waitMs;
  }

  beginTurn(turnId: string): void {
    this.#turnId = turnId;
    this.#announced.clear();
    this.#wake();
  }

  endTurn(turnId: string): void {
    if (this.#turnId !== turnId) return;
    this.#turnId = null;
    this.#announced.clear();
    this.#wake();
  }

  /** Record a raw ACP `tool_call` id observed in `turnId`'s event stream. */
  announce(turnId: string, toolCallId: unknown): void {
    if (this.#turnId !== turnId || typeof toolCallId !== "string" || !TOOL_USE_ID.test(toolCallId)) return;
    if (this.#announced.size >= MAX_TURN_ANNOUNCEMENTS) return;
    this.#announced.add(toolCallId);
    this.#wake();
  }

  /** Resolve to the call identity for an admitted tool use, or reject. */
  async admit(turnId: string, toolUseId: string | undefined, signal: AbortSignal): Promise<string> {
    if (toolUseId === undefined || !TOOL_USE_ID.test(toolUseId)) {
      throw new Error("Paperclip tool call has no provider tool-use identity");
    }
    if (this.#turnId !== turnId) throw new Error("Paperclip tool call is not bound to the active turn");
    this.#assertUnused(toolUseId);
    if (!this.#announced.has(toolUseId)) await this.#awaitAnnouncement(turnId, toolUseId, signal);
    if (this.#turnId !== turnId || signal.aborted || !this.#announced.has(toolUseId)) {
      throw new Error("Paperclip tool call was not announced in the active turn");
    }
    this.#assertUnused(toolUseId);
    if (this.#admitted.size >= MAX_ADMITTED_TOOL_USES) throw new Error("Provider tool-use ledger is at capacity");
    this.#admitted.add(toolUseId);
    return `tool-use:${toolUseId}`;
  }

  #assertUnused(toolUseId: string): void {
    if (this.#admitted.has(toolUseId)) throw new Error("Paperclip tool call reused a provider tool-use identity");
  }

  #awaitAnnouncement(turnId: string, toolUseId: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        this.#waiters.delete(check);
        resolve();
      };
      const check = () => {
        if (this.#turnId !== turnId || this.#announced.has(toolUseId)) done();
      };
      const timer = setTimeout(done, this.#waitMs);
      timer.unref?.();
      signal.addEventListener("abort", done, { once: true });
      this.#waiters.add(check);
      if (signal.aborted) done();
    });
  }

  #wake(): void {
    for (const check of [...this.#waiters]) check();
  }
}
