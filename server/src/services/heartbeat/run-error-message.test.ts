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
});

describe("heartbeat run error messages", () => {
  const base = {
    adapterErrorMessage: null,
    recordedError: null,
    stderrExcerpt: null,
  };

  it("records no error for a run that succeeded", () => {
    expect(
      resolveRunErrorMessage({
        ...base,
        outcome: "succeeded",
        adapterErrorMessage: "ignored",
        stderrExcerpt: "ignored",
      }),
    ).toBeNull();
  });

  it("falls back to the captured stderr tail when the adapter gave no message", () => {
    expect(
      resolveRunErrorMessage({
        ...base,
        outcome: "failed",
        stderrExcerpt: "spawn acpx ENOENT\nconnect ECONNREFUSED 10.0.0.1:443\n",
      }),
    ).toBe("spawn acpx ENOENT\nconnect ECONNREFUSED 10.0.0.1:443");
    expect(
      resolveRunErrorMessage({
        ...base,
        outcome: "timed_out",
        stderrExcerpt: "waiting for the model gateway",
      }),
    ).toBe("waiting for the model gateway");
    expect(
      resolveRunErrorMessage({
        ...base,
        outcome: "interrupted",
        stderrExcerpt: "killed by the supervisor",
      }),
    ).toBe("killed by the supervisor");
  });

  it("prefers an explicit adapter message over the stderr tail", () => {
    expect(
      resolveRunErrorMessage({
        ...base,
        outcome: "failed",
        adapterErrorMessage: "model provider returned 402",
        stderrExcerpt: "noisy warning\nanother noisy warning",
      }),
    ).toBe("model provider returned 402");
  });

  it("keeps the generic outcome label when no stderr was captured", () => {
    expect(resolveRunErrorMessage({ ...base, outcome: "failed" })).toBe(
      "Adapter failed",
    );
    expect(
      resolveRunErrorMessage({ ...base, outcome: "failed", stderrExcerpt: "" }),
    ).toBe("Adapter failed");
    expect(
      resolveRunErrorMessage({
        ...base,
        outcome: "timed_out",
        stderrExcerpt: "   \n  ",
      }),
    ).toBe("Timed out");
    expect(resolveRunErrorMessage({ ...base, outcome: "interrupted" })).toBe(
      "Adapter failed",
    );
  });

  it("prefers the already recorded error on the cancelled path", () => {
    expect(
      resolveRunErrorMessage({
        outcome: "cancelled",
        recordedError: "Cancelled by the board",
        adapterErrorMessage: "adapter noticed the abort",
        stderrExcerpt: "signal SIGTERM",
      }),
    ).toBe("Cancelled by the board");
    expect(
      resolveRunErrorMessage({
        ...base,
        outcome: "cancelled",
        stderrExcerpt: "signal SIGTERM",
      }),
    ).toBe("signal SIGTERM");
    expect(resolveRunErrorMessage({ ...base, outcome: "cancelled" })).toBe(
      "Cancelled",
    );
  });
});
