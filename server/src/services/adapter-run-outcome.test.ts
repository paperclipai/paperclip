import { describe, expect, it } from "vitest";
import { adapterResultCompletedSuccessfully } from "./adapter-run-outcome.js";

describe("adapterResultCompletedSuccessfully", () => {
  it("treats explicit dirty successful exits as completed while keeping the exit code visible", () => {
    expect(
      adapterResultCompletedSuccessfully({
        exitCode: 1,
        errorMessage: null,
        timedOut: false,
        resultJson: { dirtyExit: true, dirtyExitCode: 1 },
      }),
    ).toBe(true);
  });

  it("does not accept a dirty-exit marker whose code does not match the raw exit code", () => {
    expect(
      adapterResultCompletedSuccessfully({
        exitCode: 2,
        errorMessage: null,
        timedOut: false,
        resultJson: { dirtyExit: true, dirtyExitCode: 1 },
      }),
    ).toBe(false);
  });

  it("keeps ordinary nonzero exits and timed-out results as incomplete", () => {
    expect(
      adapterResultCompletedSuccessfully({
        exitCode: 1,
        errorMessage: null,
        timedOut: false,
        resultJson: null,
      }),
    ).toBe(false);
    expect(
      adapterResultCompletedSuccessfully({
        exitCode: 0,
        errorMessage: null,
        timedOut: true,
        resultJson: { dirtyExit: true, dirtyExitCode: 0 },
      }),
    ).toBe(false);
  });
});
