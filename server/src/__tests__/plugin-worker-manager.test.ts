import { describe, expect, it } from "vitest";
import {
  appendStderrExcerpt,
  formatWorkerFailureMessage,
  normalizeForkEntrypoint,
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

describe("normalizeForkEntrypoint", () => {
  it("converts absolute Windows paths to file URLs", () => {
    expect(normalizeForkEntrypoint("C:\\plugins\\decision-surface\\dist\\worker.js", "win32"))
      .toBe("file:///C:/plugins/decision-surface/dist/worker.js");
  });

  it("keeps non-Windows paths unchanged", () => {
    expect(normalizeForkEntrypoint("/tmp/plugin/dist/worker.js"))
      .toBe("/tmp/plugin/dist/worker.js");
  });
});
