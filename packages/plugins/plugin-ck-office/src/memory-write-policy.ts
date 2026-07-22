export type MemoryWriteMode = "fact" | "checkpoint";

export interface NormalizedMemoryWrite {
  key: string;
  value: string;
  mode: MemoryWriteMode;
}

export type MemoryWritePolicyResult =
  | { ok: true; input: NormalizedMemoryWrite }
  | { ok: false; reason: string };

const STABLE_KEY_RE = /^[a-z0-9][a-z0-9:_-]{2,119}$/i;
const DATE_STAMP_RE = /20\d{2}[-_:](?:0[1-9]|1[0-2])(?:[-_:](?:0?[1-9]|[12]\d|3[01]))?/;
const EPHEMERAL_KEY_RE =
  /(?:^|[-_:])(task|issue|draft|queue|approval|run|attempt|pending|work|heartbeat|board[-_]?clean|aor)(?:[-_:]|$)/i;
const EPHEMERAL_FACT_RE =
  /\b(?:need(?:s)? to|trying to|attempting to|working on|deliverable posted|gate[- ]?passed)\b|(?:current )?(?:task|issue|paperclip)[ _-]?id\b|queue_email_for_approval|localhost|127[.]0[.]0[.]1|ck_paperclip_key|\b(?:draft|queued|pending) (?:for|to|awaiting)\b/i;

export function normalizeMemoryWrite(
  params: Record<string, unknown> | null | undefined,
): MemoryWritePolicyResult {
  const input = params ?? {};
  const value = String(input.value ?? "").trim();
  if (value.length < 8 || value.length > 600) {
    return { ok: false, reason: "value must be 8..600 chars" };
  }

  const key = String(input.key ?? "").trim();
  if (!key) {
    return {
      ok: false,
      reason:
        "key is required and must be a stable reusable identifier; do not derive a new key from task output",
    };
  }
  if (!STABLE_KEY_RE.test(key)) {
    return {
      ok: false,
      reason: "key must be 3..120 characters using only letters, numbers, colon, underscore, or hyphen",
    };
  }
  if (DATE_STAMP_RE.test(key)) {
    return {
      ok: false,
      reason:
        "key must be stable across runs and must not contain a date stamp; use mode:'checkpoint' with one reusable key for changing state",
    };
  }

  const mode: MemoryWriteMode =
    input.mode === "checkpoint" || /(?:^|[-_:])(watermark|checkpoint)$/i.test(key)
      ? "checkpoint"
      : "fact";

  if (EPHEMERAL_KEY_RE.test(key)) {
    return {
      ok: false,
      reason:
        "transient task progress and workflow identifiers (task, issue, run, queue, approval, draft) cannot be memory keys",
    };
  }

  if (mode === "fact" && EPHEMERAL_FACT_RE.test(value)) {
    return {
      ok: false,
      reason:
        "transient task progress is not a durable fact; put it in the task work product/comment, or use mode:'checkpoint' with one stable key if later runs must resume it",
    };
  }

  return { ok: true, input: { key, value, mode } };
}

export function initialMemoryStatus(mode: MemoryWriteMode): "verified" | "unverified" {
  return mode === "checkpoint" ? "verified" : "unverified";
}
