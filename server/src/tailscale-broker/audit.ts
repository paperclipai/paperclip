/**
 * Append-only security audit for the broker.
 *
 * Requirement #6 (auditability and redaction). Every allow/deny and mutation
 * outcome emits a bounded, reconstructable event. Lease handles, reservation
 * tokens, raw CLI output, and environment are never logged; every string field
 * is control-char-sanitized and length-bounded so log-forging payloads cannot
 * inject newlines or fabricate records.
 */

export interface AuditEvent {
  ts: number;
  correlationId: string;
  op: string;
  decision: "allow" | "deny";
  reason: string;
  peerUid: number | null;
  peerGid: number | null;
  peerPid: number | null;
  runtimeId: string | null;
  port: number | null;
  beforeDigest: string | null;
  afterDigest: string | null;
  cliOutcome: string | null;
  recovery: string | null;
}

export interface AuditSink {
  write(event: AuditEvent): void;
}

const MAX_FIELD = 200;

/** Strip control characters (incl. newlines) and bound length. */
export function sanitizeField(value: string | null): string | null {
  if (value === null) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return cleaned.length > MAX_FIELD ? `${cleaned.slice(0, MAX_FIELD)}…` : cleaned;
}

export function sanitizeEvent(event: AuditEvent): AuditEvent {
  return {
    ...event,
    op: sanitizeField(event.op) ?? "",
    reason: sanitizeField(event.reason) ?? "",
    runtimeId: sanitizeField(event.runtimeId),
    beforeDigest: sanitizeField(event.beforeDigest),
    afterDigest: sanitizeField(event.afterDigest),
    cliOutcome: sanitizeField(event.cliOutcome),
    recovery: sanitizeField(event.recovery),
  };
}

/** A sink that appends one JSON line per event to a provided writer. */
export function createJsonlAuditSink(writeLine: (line: string) => void): AuditSink {
  return {
    write(event: AuditEvent): void {
      const safe = sanitizeEvent(event);
      writeLine(JSON.stringify(safe));
    },
  };
}
