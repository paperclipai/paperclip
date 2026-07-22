const ESPO_RECORD_ID = /^[0-9a-f]{17}$/i;
const RFC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isEspoRecordId(value: unknown): boolean {
  const normalized = String(value ?? "").trim();
  return ESPO_RECORD_ID.test(normalized) || RFC_UUID.test(normalized);
}
