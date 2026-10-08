import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm/pg-core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const proxy: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "__esModule" ? true : proxy),
    apply: () => proxy,
  });
  return new Proxy(actual, {
    get: (target, prop) => (prop in target ? target[prop] : proxy),
  });
});

const { extractStderrExcerptTail } = await import("../services/heartbeat.ts");

describe("extractStderrExcerptTail", () => {
  it("returns null for missing, empty, and whitespace-only excerpts", () => {
    expect(extractStderrExcerptTail(null)).toBeNull();
    expect(extractStderrExcerptTail(undefined)).toBeNull();
    expect(extractStderrExcerptTail("")).toBeNull();
    expect(extractStderrExcerptTail("   \n\n ")).toBeNull();
  });

  it("keeps a short excerpt intact", () => {
    expect(extractStderrExcerptTail("Cannot connect to API: Unable to connect.")).toBe(
      "Cannot connect to API: Unable to connect.",
    );
    expect(extractStderrExcerptTail("  line one\nline two  \n")).toBe("line one\nline two");
  });

  it("keeps only the trailing lines of a long excerpt", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const tail = extractStderrExcerptTail(lines.join("\n"));
    expect(tail).toBe(lines.slice(-16).join("\n"));
    expect(tail?.startsWith("line 184")).toBe(true);
    expect(tail?.endsWith("line 199")).toBe(true);
  });

  it("stays within the persisted error length bound", () => {
    const tail = extractStderrExcerptTail("x".repeat(32 * 1024));
    expect(tail).not.toBeNull();
    expect(tail!.length).toBeLessThanOrEqual(1024);
    expect(tail).toBe("x".repeat(1024));
  });

  it("bounds a long multi-line tail to its final characters", () => {
    const excerpt = Array.from({ length: 16 }, (_, i) => `${i} ${"y".repeat(200)}`).join("\n");
    const tail = extractStderrExcerptTail(excerpt);
    expect(tail!.length).toBeLessThanOrEqual(1024);
    expect(tail!.endsWith(`${"y".repeat(200)}`)).toBe(true);
  });
});
