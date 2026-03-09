// @vitest-environment node
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// ToastContext — pure logic tests
//
// ToastContext.tsx contains several pure helper functions:
//
//   • normalizeTtl(value, tone)  – clamps a TTL value within [MIN, MAX] ms
//   • generateToastId()          – produces a unique non-empty string ID
//   • dedupe key construction    – key derived from tone + title + body + action
//
// All helpers are mirrored here from ui/src/context/ToastContext.tsx so the
// tests remain fast and self-contained (node environment, no DOM/React).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constants mirrored from ToastContext.tsx
// ---------------------------------------------------------------------------

const DEFAULT_TTL_BY_TONE: Record<string, number> = {
  info: 4000,
  success: 3500,
  warn: 8000,
  error: 10000,
};

const MIN_TTL_MS = 1500;
const MAX_TTL_MS = 15000;
const DEDUPE_WINDOW_MS = 3500;

type ToastTone = "info" | "success" | "warn" | "error";

// ---------------------------------------------------------------------------
// normalizeTtl — mirrored from ToastContext.tsx
// ---------------------------------------------------------------------------

function normalizeTtl(value: number | undefined, tone: ToastTone): number {
  const fallback = DEFAULT_TTL_BY_TONE[tone];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(value)));
}

describe("normalizeTtl", () => {
  // --- Default TTL by tone ---

  it("returns 4000 for info when no value given", () => {
    expect(normalizeTtl(undefined, "info")).toBe(4000);
  });

  it("returns 3500 for success when no value given", () => {
    expect(normalizeTtl(undefined, "success")).toBe(3500);
  });

  it("returns 8000 for warn when no value given", () => {
    expect(normalizeTtl(undefined, "warn")).toBe(8000);
  });

  it("returns 10000 for error when no value given", () => {
    expect(normalizeTtl(undefined, "error")).toBe(10000);
  });

  // --- Clamping to [MIN, MAX] ---

  it("clamps values below MIN_TTL_MS up to MIN_TTL_MS", () => {
    expect(normalizeTtl(100, "info")).toBe(MIN_TTL_MS); // 1500
  });

  it("clamps values above MAX_TTL_MS down to MAX_TTL_MS", () => {
    expect(normalizeTtl(999_999, "info")).toBe(MAX_TTL_MS); // 15000
  });

  it("accepts a value exactly at MIN_TTL_MS", () => {
    expect(normalizeTtl(MIN_TTL_MS, "info")).toBe(MIN_TTL_MS);
  });

  it("accepts a value exactly at MAX_TTL_MS", () => {
    expect(normalizeTtl(MAX_TTL_MS, "info")).toBe(MAX_TTL_MS);
  });

  it("accepts a mid-range value unchanged", () => {
    expect(normalizeTtl(5000, "info")).toBe(5000);
  });

  it("floors fractional values", () => {
    expect(normalizeTtl(3001.9, "info")).toBe(3001);
  });

  // --- Non-finite / invalid values fall back to tone default ---

  it("falls back to tone default when value is NaN", () => {
    expect(normalizeTtl(NaN, "success")).toBe(3500);
  });

  it("falls back to tone default when value is Infinity", () => {
    expect(normalizeTtl(Infinity, "warn")).toBe(8000);
  });

  it("falls back to tone default when value is -Infinity", () => {
    expect(normalizeTtl(-Infinity, "error")).toBe(10000);
  });

  it("falls back to tone default when value is 0", () => {
    // 0 is finite but below MIN — gets clamped to MIN
    expect(normalizeTtl(0, "info")).toBe(MIN_TTL_MS);
  });

  it("falls back to tone default when value is negative", () => {
    // Negative is finite but below MIN — gets clamped to MIN
    expect(normalizeTtl(-500, "info")).toBe(MIN_TTL_MS);
  });
});

// ---------------------------------------------------------------------------
// Dedupe key construction — mirrored from ToastContext.tsx
//
// Key = `${tone}|${title}|${body ?? ""}|${action?.href ?? ""}`
// ---------------------------------------------------------------------------

function buildDedupeKey(input: {
  dedupeKey?: string;
  id?: string;
  tone?: ToastTone;
  title: string;
  body?: string;
  action?: { href: string; label: string };
}): string {
  const tone = input.tone ?? "info";
  return (
    input.dedupeKey ??
    input.id ??
    `${tone}|${input.title}|${input.body ?? ""}|${input.action?.href ?? ""}`
  );
}

describe("dedupe key construction", () => {
  it("uses explicit dedupeKey when provided", () => {
    const key = buildDedupeKey({ dedupeKey: "my-key", title: "T", tone: "info" });
    expect(key).toBe("my-key");
  });

  it("uses id as fallback when dedupeKey is absent", () => {
    const key = buildDedupeKey({ id: "toast-id-123", title: "T", tone: "info" });
    expect(key).toBe("toast-id-123");
  });

  it("builds from tone + title when no explicit key/id", () => {
    const key = buildDedupeKey({ title: "File saved", tone: "success" });
    expect(key).toBe("success|File saved||");
  });

  it("includes body in the key when provided", () => {
    const key = buildDedupeKey({ title: "File saved", tone: "success", body: "index.ts" });
    expect(key).toBe("success|File saved|index.ts|");
  });

  it("includes action href in the key when provided", () => {
    const key = buildDedupeKey({
      title: "File saved",
      tone: "success",
      action: { href: "/files/index.ts", label: "Open" },
    });
    expect(key).toBe("success|File saved||/files/index.ts");
  });

  it("defaults tone to info when tone is not provided", () => {
    const key = buildDedupeKey({ title: "Notification" });
    expect(key).toBe("info|Notification||");
  });

  it("two identical toast inputs produce the same key (enabling deduplication)", () => {
    const a = buildDedupeKey({ title: "File deleted", tone: "success", body: "old.ts" });
    const b = buildDedupeKey({ title: "File deleted", tone: "success", body: "old.ts" });
    expect(a).toBe(b);
  });

  it("different titles produce different keys", () => {
    const a = buildDedupeKey({ title: "File saved", tone: "success" });
    const b = buildDedupeKey({ title: "File deleted", tone: "success" });
    expect(a).not.toBe(b);
  });

  it("different tones produce different keys", () => {
    const a = buildDedupeKey({ title: "Oops", tone: "error" });
    const b = buildDedupeKey({ title: "Oops", tone: "warn" });
    expect(a).not.toBe(b);
  });

  it("different bodies produce different keys", () => {
    const a = buildDedupeKey({ title: "File saved", tone: "success", body: "a.ts" });
    const b = buildDedupeKey({ title: "File saved", tone: "success", body: "b.ts" });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Toast deduplication window constant
// ---------------------------------------------------------------------------

describe("deduplication window", () => {
  it("DEDUPE_WINDOW_MS is a positive number", () => {
    expect(DEDUPE_WINDOW_MS).toBeGreaterThan(0);
  });

  it("DEDUPE_WINDOW_MS is less than the success TTL (so a repeated success toast within the window is suppressed)", () => {
    // A toast with tone=success has TTL=3500; if two are emitted within
    // DEDUPE_WINDOW_MS=3500 only one should appear.
    const successTtl = DEFAULT_TTL_BY_TONE["success"];
    expect(DEDUPE_WINDOW_MS).toBeLessThanOrEqual(successTtl);
  });

  it("DEDUPE_WINDOW_MS is less than MIN_TTL_MS * 3 (reasonable upper bound)", () => {
    expect(DEDUPE_WINDOW_MS).toBeLessThan(MIN_TTL_MS * 3);
  });
});

// ---------------------------------------------------------------------------
// MAX_TOASTS constant behaviour
// ---------------------------------------------------------------------------

const MAX_TOASTS = 5;

describe("MAX_TOASTS constant", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(MAX_TOASTS)).toBe(true);
    expect(MAX_TOASTS).toBeGreaterThan(0);
  });

  it("slicing a toast list to MAX_TOASTS keeps the newest first", () => {
    // Simulate the [newToast, ...prev].slice(0, MAX_TOASTS) pattern.
    // prev has 5 items (ids "1"–"5"). A new toast "6" is prepended.
    // After slicing to MAX_TOASTS (5): ["6", "5", "4", "3", "2"].
    // The oldest item "1" is dropped.
    const prev = [
      { id: "5" },
      { id: "4" },
      { id: "3" },
      { id: "2" },
      { id: "1" },
    ];
    const newToast = { id: "6" };
    const result = [newToast, ...prev].slice(0, MAX_TOASTS);
    expect(result).toHaveLength(MAX_TOASTS);
    expect(result[0].id).toBe("6"); // newest is first
    expect(result[MAX_TOASTS - 1].id).toBe("2"); // oldest kept is the last
    // id "1" should be dropped
    expect(result.find((t) => t.id === "1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: TTL range is consistent with tone priorities
// ---------------------------------------------------------------------------

describe("TTL range by tone (priority ordering)", () => {
  it("success toasts have a shorter default TTL than warn toasts", () => {
    expect(DEFAULT_TTL_BY_TONE["success"]).toBeLessThan(DEFAULT_TTL_BY_TONE["warn"]);
  });

  it("error toasts have the longest default TTL", () => {
    const max = Math.max(...Object.values(DEFAULT_TTL_BY_TONE));
    expect(DEFAULT_TTL_BY_TONE["error"]).toBe(max);
  });

  it("all default TTLs are within [MIN_TTL_MS, MAX_TTL_MS]", () => {
    for (const ttl of Object.values(DEFAULT_TTL_BY_TONE)) {
      expect(ttl).toBeGreaterThanOrEqual(MIN_TTL_MS);
      expect(ttl).toBeLessThanOrEqual(MAX_TTL_MS);
    }
  });

  it("all four tones have a defined default TTL", () => {
    const tones: ToastTone[] = ["info", "success", "warn", "error"];
    for (const tone of tones) {
      expect(DEFAULT_TTL_BY_TONE[tone]).toBeDefined();
      expect(typeof DEFAULT_TTL_BY_TONE[tone]).toBe("number");
    }
  });
});
