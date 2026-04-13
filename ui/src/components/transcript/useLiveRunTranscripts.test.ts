import { describe, expect, it } from "vitest";
import { shouldPollRunLog } from "./useLiveRunTranscripts";

describe("shouldPollRunLog", () => {
  it("skips queued runs that have not been claimed", () => {
    expect(
      shouldPollRunLog({
        status: "queued",
        startedAt: null,
        finishedAt: null,
      }),
    ).toBe(false);
  });

  it("skips pre-start running placeholders until startedAt exists", () => {
    expect(
      shouldPollRunLog({
        status: "running",
        startedAt: null,
        finishedAt: null,
      }),
    ).toBe(false);
  });

  it("polls once the run has actually started", () => {
    expect(
      shouldPollRunLog({
        status: "running",
        startedAt: "2026-03-28T06:00:00.000Z",
        finishedAt: null,
      }),
    ).toBe(true);
  });

  it("continues polling terminal runs so persisted logs can load", () => {
    expect(
      shouldPollRunLog({
        status: "succeeded",
        startedAt: null,
        finishedAt: "2026-03-28T06:05:00.000Z",
      }),
    ).toBe(true);
  });
});
