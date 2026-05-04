import { describe, expect, it } from "vitest";
import {
  appendStderrExcerpt,
  classifyWorkerExit,
  formatWorkerFailureMessage,
} from "../services/plugin-worker-manager.js";

describe("plugin-worker-manager stderr failure context", () => {
  it("appends worker stderr context to failure messages", () => {
    expect(
      formatWorkerFailureMessage(
        "Worker process exited (code=1, signal=null)",
        "TypeError: Unknown file extension \".ts\"",
      ),
    ).toBe(
      "Worker process exited (code=1, signal=null)\n\nWorker stderr:\nTypeError: Unknown file extension \".ts\"",
    );
  });

  it("does not duplicate stderr that is already present", () => {
    const message = [
      "Worker process exited (code=1, signal=null)",
      "",
      "Worker stderr:",
      "TypeError: Unknown file extension \".ts\"",
    ].join("\n");

    expect(
      formatWorkerFailureMessage(message, "TypeError: Unknown file extension \".ts\""),
    ).toBe(message);
  });

  it("keeps only the latest stderr excerpt", () => {
    let excerpt = "";
    excerpt = appendStderrExcerpt(excerpt, "first line");
    excerpt = appendStderrExcerpt(excerpt, "second line");

    expect(excerpt).toContain("first line");
    expect(excerpt).toContain("second line");

    excerpt = appendStderrExcerpt(excerpt, "x".repeat(9_000));

    expect(excerpt).not.toContain("first line");
    expect(excerpt).not.toContain("second line");
    expect(excerpt.length).toBeLessThanOrEqual(8_000);
  });
});

describe("classifyWorkerExit", () => {
  it("treats an explicit per-worker stop() as graceful", () => {
    expect(
      classifyWorkerExit({ intentionalStop: true, isShuttingDown: false, code: null, signal: null }),
    ).toBe("graceful");
    expect(
      classifyWorkerExit({ intentionalStop: true, isShuttingDown: false, code: null, signal: "SIGTERM" }),
    ).toBe("graceful");
  });

  it("treats SIGTERM during host shutdown as graceful (issue #5131)", () => {
    expect(
      classifyWorkerExit({ intentionalStop: false, isShuttingDown: true, code: null, signal: "SIGTERM" }),
    ).toBe("graceful");
  });

  it("treats SIGINT during host shutdown as graceful", () => {
    expect(
      classifyWorkerExit({ intentionalStop: false, isShuttingDown: true, code: null, signal: "SIGINT" }),
    ).toBe("graceful");
  });

  it("treats a worker that catches SIGTERM and exits cleanly as graceful during host shutdown", () => {
    // A well-behaved plugin that traps SIGTERM and calls process.exit(0)
    // shows up as { code: 0, signal: null }. The host shouldn't penalize
    // good behavior — without this, every routine restart bumps the
    // crash counters for any plugin that does its own signal cleanup.
    expect(
      classifyWorkerExit({ intentionalStop: false, isShuttingDown: true, code: 0, signal: null }),
    ).toBe("graceful");
  });

  it("still treats unexpected SIGTERM as a crash when host is not shutting down", () => {
    // External `kill -TERM <pid>`, supervisor intervention, etc. should keep
    // counting as a crash so consecutiveCrashes/totalCrashes stay meaningful.
    expect(
      classifyWorkerExit({ intentionalStop: false, isShuttingDown: false, code: null, signal: "SIGTERM" }),
    ).toBe("crash");
  });

  it("treats SIGKILL as a crash even during host shutdown", () => {
    // SIGKILL during shutdown indicates an abrupt external kill or OOM-killer,
    // not the host's own graceful-shutdown signal forwarding.
    expect(
      classifyWorkerExit({ intentionalStop: false, isShuttingDown: true, code: null, signal: "SIGKILL" }),
    ).toBe("crash");
  });

  it("treats a non-zero exit code as a crash even during host shutdown", () => {
    // Worker errored on its own and happened to exit during shutdown —
    // not the host's fault, still a real crash worth counting.
    expect(
      classifyWorkerExit({ intentionalStop: false, isShuttingDown: true, code: 1, signal: null }),
    ).toBe("crash");
  });

  it("treats a clean exit when host is not shutting down as a crash", () => {
    // Worker exited cleanly without anyone asking it to. Outside a host
    // shutdown that's still unexpected behavior; the manager should
    // surface it and consider whether to restart.
    expect(
      classifyWorkerExit({ intentionalStop: false, isShuttingDown: false, code: 0, signal: null }),
    ).toBe("crash");
  });

  it("treats a normal unexpected exit as a crash", () => {
    expect(
      classifyWorkerExit({ intentionalStop: false, isShuttingDown: false, code: null, signal: null }),
    ).toBe("crash");
  });
});
