import { describe, expect, it } from "vitest";
import {
  extractStderrExcerptTail,
  resolveRunErrorMessage,
} from "./run-error-message.js";

describe("heartbeat stderr excerpt tails", () => {
  it("treats absent, empty, and whitespace-only excerpts as no tail", () => {
    expect(extractStderrExcerptTail(null)).toBeNull();
    expect(extractStderrExcerptTail(undefined)).toBeNull();
    expect(extractStderrExcerptTail("")).toBeNull();
    expect(extractStderrExcerptTail("   \n\t\n  ")).toBeNull();
  });

  it("returns a short excerpt unchanged, without its surrounding whitespace", () => {
    expect(extractStderrExcerptTail("connect ECONNREFUSED 10.0.0.1:443")).toBe(
      "connect ECONNREFUSED 10.0.0.1:443",
    );
    expect(extractStderrExcerptTail("\nfirst\nsecond\n")).toBe("first\nsecond");
  });

  it("keeps the last 16 lines and drops everything before them", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    expect(extractStderrExcerptTail(lines.join("\n"))).toBe(
      lines.slice(4).join("\n"),
    );
    const exact = lines.slice(0, 16);
    expect(extractStderrExcerptTail(exact.join("\n"))).toBe(exact.join("\n"));
  });

  it("keeps the most recent 1024 characters of a single long line", () => {
    const exact = "x".repeat(1024);
    expect(extractStderrExcerptTail(exact)).toBe(exact);
    expect(extractStderrExcerptTail(`dropped prefix${exact}`)).toBe(exact);
  });

  it("never starts the tail inside a surrogate pair", () => {
    // An emoji is two UTF-16 units: a 1024-unit tail of one emoji plus 1023
    // ASCII characters would otherwise begin on its lone low surrogate.
    const tail = extractStderrExcerptTail(`prefix\u{1f642}${"x".repeat(1023)}`);
    expect(tail).toBe("x".repeat(1023));
    expect(tail).not.toMatch(/[\uD800-\uDFFF]/);
    // An astral character that lands fully inside the window is preserved.
    expect(
      extractStderrExcerptTail(`prefix${"x".repeat(1022)}\u{1f642}`),
    ).toBe(`${"x".repeat(1022)}\u{1f642}`);
  });
});

function resolveMessage(
  input: Parameters<typeof resolveRunErrorMessage>[0],
) {
  return resolveRunErrorMessage(input).message;
}

describe("heartbeat run error messages", () => {
  const base = {
    adapterErrorMessage: null,
    recordedError: null,
    stderrExcerpt: null,
  };

  it("records no error for a run that succeeded", () => {
    expect(
      resolveMessage({
        ...base,
        outcome: "succeeded",
        adapterErrorMessage: "ignored",
        stderrExcerpt: "ignored",
      }),
    ).toBeNull();
  });

  it("falls back to the captured stderr tail when the adapter gave no message", () => {
    expect(
      resolveMessage({
        ...base,
        outcome: "failed",
        stderrExcerpt: "spawn acpx ENOENT\nconnect ECONNREFUSED 10.0.0.1:443\n",
      }),
    ).toBe("spawn acpx ENOENT\nconnect ECONNREFUSED 10.0.0.1:443");
    expect(
      resolveMessage({
        ...base,
        outcome: "timed_out",
        stderrExcerpt: "waiting for the model gateway",
      }),
    ).toBe("waiting for the model gateway");
    expect(
      resolveMessage({
        ...base,
        outcome: "interrupted",
        stderrExcerpt: "killed by the supervisor",
      }),
    ).toBe("killed by the supervisor");
  });

  it("prefers an explicit adapter message over the stderr tail", () => {
    expect(
      resolveMessage({
        ...base,
        outcome: "failed",
        adapterErrorMessage: "model provider returned 402",
        stderrExcerpt: "noisy warning\nanother noisy warning",
      }),
    ).toBe("model provider returned 402");
  });

  it("keeps the generic outcome label when no stderr was captured", () => {
    expect(resolveMessage({ ...base, outcome: "failed" })).toBe(
      "Adapter failed",
    );
    expect(
      resolveMessage({ ...base, outcome: "failed", stderrExcerpt: "" }),
    ).toBe("Adapter failed");
    expect(
      resolveMessage({
        ...base,
        outcome: "timed_out",
        stderrExcerpt: "   \n  ",
      }),
    ).toBe("Timed out");
    expect(resolveMessage({ ...base, outcome: "interrupted" })).toBe(
      "Adapter failed",
    );
  });

  it("prefers the already recorded error on the cancelled path", () => {
    expect(
      resolveMessage({
        outcome: "cancelled",
        recordedError: "Cancelled by the board",
        adapterErrorMessage: "adapter noticed the abort",
        stderrExcerpt: "signal SIGTERM",
      }),
    ).toBe("Cancelled by the board");
    expect(
      resolveMessage({
        ...base,
        outcome: "cancelled",
        stderrExcerpt: "signal SIGTERM",
      }),
    ).toBe("signal SIGTERM");
    expect(resolveMessage({ ...base, outcome: "cancelled" })).toBe(
      "Cancelled",
    );
  });

  it("reports where the resolved message came from", () => {
    expect(
      resolveRunErrorMessage({ ...base, outcome: "succeeded" }).source,
    ).toBeNull();
    expect(
      resolveRunErrorMessage({
        ...base,
        outcome: "failed",
        adapterErrorMessage: "model provider returned 402",
        stderrExcerpt: "spawn acpx ENOENT",
      }).source,
    ).toBe("adapter");
    expect(
      resolveRunErrorMessage({
        ...base,
        outcome: "failed",
        stderrExcerpt: "spawn acpx ENOENT",
      }).source,
    ).toBe("stderr_excerpt");
    expect(resolveRunErrorMessage({ ...base, outcome: "failed" }).source).toBe(
      "label",
    );
    expect(
      resolveRunErrorMessage({
        ...base,
        outcome: "cancelled",
        recordedError: "Cancelled by the board",
      }).source,
    ).toBe("recorded");
    // A non-cancelled run ignores the recorded error exactly as before, so the
    // stderr tail is still what a caller must distrust.
    expect(
      resolveRunErrorMessage({
        ...base,
        outcome: "timed_out",
        recordedError: "ignored outside the cancelled path",
        stderrExcerpt: "waiting for the model gateway",
      }),
    ).toEqual({
      message: "waiting for the model gateway",
      source: "stderr_excerpt",
    });
  });
});
