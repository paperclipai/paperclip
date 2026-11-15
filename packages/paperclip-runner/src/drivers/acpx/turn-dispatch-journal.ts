import { closeSync, constants, fsyncSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  GENERATED_ACPX_TURN_DISPATCH_JOURNAL_FILE,
  GENERATED_ACPX_TURN_DISPATCH_SCHEMA,
} from "./generated-sidecar-contract.js";

/**
 * Durable proof of whether a turn's prompt reached the provider.
 *
 * A turn start can be cut off (a timeout, a frozen or killed sidecar) after
 * the Runner asked for it and before it heard back. The Runner then cannot
 * tell whether the provider received the prompt: resending could duplicate it
 * and a continuation could lose it. The runtime port records two facts in the
 * session's private runtime directory:
 *
 * - `received`: the port started the turn. Written first, before any provider
 *   work, truncating the previous turn's record. Not synced: losing it only
 *   loses the proof.
 * - `dispatched`: appended and fsynced synchronously immediately before the
 *   turn's first `session/prompt` request is written to the provider. A failed
 *   write aborts the prompt write.
 *
 * The Runner reads the file only after it proves that the sidecar and the
 * provider are gone, so neither can still write. A lone `received` line then
 * proves that the prompt was never sent.
 */
export interface AcpxTurnDispatchJournal {
  /**
   * Returns false when the record could not be written. The turn then runs
   * unjournaled: without a `received` record no reader can form a proof.
   */
  markReceived(): boolean;
  markDispatched(): void;
}

function record(turnId: string, phase: "received" | "dispatched"): string {
  return `${JSON.stringify({ schema: GENERATED_ACPX_TURN_DISPATCH_SCHEMA, turnId, phase })}\n`;
}

function writeAll(fd: number, line: string): void {
  const bytes = Buffer.from(line, "utf8");
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

export function createAcpxTurnDispatchJournal(
  runtimeDirectory: string,
  turnId: string,
): AcpxTurnDispatchJournal {
  const path = join(runtimeDirectory, GENERATED_ACPX_TURN_DISPATCH_JOURNAL_FILE);
  return {
    markReceived() {
      try {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try {
          writeAll(fd, record(turnId, "received"));
        } finally {
          closeSync(fd);
        }
        return true;
      } catch (error) {
        // A journal problem must never block the turn, but a `received`
        // record left behind without its dispatch would prove a falsehood.
        // Remove whatever was written; if even that fails, fail the start.
        try {
          unlinkSync(path);
        } catch (cleanup) {
          if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return false;
      }
    },
    markDispatched() {
      // O_APPEND without O_CREAT: a missing `received` line must not be
      // replaced by a lone `dispatched` record that a reader cannot bind.
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      try {
        writeAll(fd, record(turnId, "dispatched"));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** True for the JSON-RPC request that hands a turn's prompt to the provider. */
export function isAcpPromptRequest(message: unknown): boolean {
  return typeof message === "object" && message !== null && "id" in message
    && (message as { method?: unknown }).method === "session/prompt";
}
