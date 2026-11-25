/**
 * Append-only, bounded, redacted security audit (PAP-17050 verdict req #6).
 *
 * Every allow/deny and mutation outcome emits one event. Lease handles,
 * bearer/session material, full environments, and raw unbounded CLI output are
 * NEVER logged. All string fields are control-character-sanitized and length
 * bounded to defeat log forging.
 */
import { appendFileSync } from "node:fs";
import type { BrokerErrorCode, PeerCredentials } from "./types.js";

const MAX_FIELD_LEN = 256;

export interface AuditEvent {
  timestampIso: string;
  peer: PeerCredentials | null;
  op: string;
  runtimeId: string | null;
  ports: number[];
  requestId: string | null;
  decision: "allow" | "deny";
  reasonCode: BrokerErrorCode | "ok";
  reason: string;
  beforeDigest?: string;
  afterDigest?: string;
  cliExitCategory?: "ok" | "error" | "timeout" | "none";
  recovery?: "none" | "quarantine" | "cleanup";
}

/** Strip control chars (defeats newline/log-forging) and bound length. */
export function sanitizeField(value: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\x00-\x1f\x7f]/g, " ");
  return stripped.length > MAX_FIELD_LEN ? `${stripped.slice(0, MAX_FIELD_LEN)}…` : stripped;
}

export function formatAuditLine(event: AuditEvent): string {
  const safe = {
    ts: event.timestampIso,
    uid: event.peer?.uid ?? null,
    gid: event.peer?.gid ?? null,
    pid: event.peer?.pid ?? null,
    op: sanitizeField(event.op),
    runtimeId: event.runtimeId ? sanitizeField(event.runtimeId) : null,
    ports: event.ports.filter((p) => Number.isInteger(p)).slice(0, 8),
    requestId: event.requestId ? sanitizeField(event.requestId) : null,
    decision: event.decision,
    reasonCode: event.reasonCode,
    reason: sanitizeField(event.reason),
    beforeDigest: event.beforeDigest ? sanitizeField(event.beforeDigest) : undefined,
    afterDigest: event.afterDigest ? sanitizeField(event.afterDigest) : undefined,
    cliExitCategory: event.cliExitCategory,
    recovery: event.recovery,
  };
  return JSON.stringify(safe);
}

export interface AuditSink {
  write(event: AuditEvent): void;
}

/**
 * Durable file audit sink. If the recommended `blockOnFailure` is set, a write
 * failure throws so the caller can fail the mutation closed rather than mutate
 * without a durable record.
 */
export class FileAuditSink implements AuditSink {
  constructor(
    private readonly path: string,
    private readonly blockOnFailure = true,
  ) {}

  write(event: AuditEvent): void {
    try {
      appendFileSync(this.path, `${formatAuditLine(event)}\n`, { mode: 0o600 });
    } catch (error) {
      if (this.blockOnFailure) {
        throw new Error(`audit sink write failed: ${(error as Error).message}`);
      }
    }
  }
}

/** In-memory sink for tests. */
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  write(event: AuditEvent): void {
    this.events.push(event);
  }
}
