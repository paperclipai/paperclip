import { describe, expect, it } from "vitest";
import { attemptLaunchesFreshBootstrap } from "./native-bootstrap-proof.js";

describe("attemptLaunchesFreshBootstrap", () => {
  it("accepts a first attempt", () => {
    expect(attemptLaunchesFreshBootstrap(undefined)).toBe(true);
    expect(attemptLaunchesFreshBootstrap(null)).toBe(true);
  });

  // The restart stops and quarantines the unfinished bootstrap, then launches a
  // new one on the same run. A transient endpoint failure of that new bootstrap
  // is as retryable as one on a first attempt.
  it("accepts a same-run restart of an incomplete bootstrap", () => {
    expect(attemptLaunchesFreshBootstrap({ kind: "bootstrap_incomplete" })).toBe(true);
  });

  it.each(["reattach_existing_runner", "reattach_remote_runner", "resume_dead_runner"])(
    "refuses a %s recovery, which continues an existing Runner or provider session",
    kind => { expect(attemptLaunchesFreshBootstrap({ kind })).toBe(false); },
  );
});
