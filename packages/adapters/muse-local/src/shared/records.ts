// Decodes one line of `muse exec --json` output. Every line is an MSP record
// envelope: { schema_version, id, stream: { kind, id }, sequence, record_type,
// payload_type, payload }. Anything else (stderr chatter that leaked onto
// stdout, blank lines, foreign JSON) decodes to null so callers can skip it.

export interface MuseRecord {
  recordType: string;
  payloadType: string;
  streamId: string | null;
  sequence: number;
  payload: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function decodeMuseRecord(line: string): MuseRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const envelope = asRecord(parsed);
  if (!envelope) return null;
  const recordType = typeof envelope.record_type === "string" ? envelope.record_type : "";
  const payloadType = typeof envelope.payload_type === "string" ? envelope.payload_type : "";
  const payload = asRecord(envelope.payload);
  if (!recordType || !payloadType || !payload) return null;
  const stream = asRecord(envelope.stream);
  const streamId = stream && typeof stream.id === "string" && stream.id.trim() ? stream.id.trim() : null;
  const sequence = typeof envelope.sequence === "number" ? envelope.sequence : 0;
  return { recordType, payloadType, streamId, sequence, payload };
}
