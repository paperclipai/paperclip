import { describe, expect, it, vi } from "vitest";
import {
  raceLoginRunnerExit,
  type LoginRunnerDisposable,
  type LoginRunnerOutcome,
  type LoginRunnerRaceResult,
  type LoginRunnerResult,
} from "./login-runner-lifecycle.js";

describe("LoginRunnerOutcome", () => {
  it("names the four terminal outcomes", () => {
    const outcomes: LoginRunnerOutcome[] = ["success", "failure", "timeout", "cancelled"];
    expect(new Set(outcomes).size).toBe(4);
  });
});

describe("LoginRunnerResult", () => {
  it("carries the fixed status fields", () => {
    const result: LoginRunnerResult = { outcome: "success", exitCode: 0, promptSurfaced: true };
    expect(result).toEqual({ outcome: "success", exitCode: 0, promptSurfaced: true });
  });
});

describe("raceLoginRunnerExit", () => {
  it("resolves with the exit kind when the work resolves first", async () => {
    const raced = await raceLoginRunnerExit(Promise.resolve({ exitCode: 0 }), 10_000, undefined);
    expect(raced).toEqual<LoginRunnerRaceResult>({ kind: "exit", exitCode: 0 });
  });

  it("passes a non-zero exit code through", async () => {
    const raced = await raceLoginRunnerExit(Promise.resolve({ exitCode: 7 }), 10_000, undefined);
    expect(raced).toEqual<LoginRunnerRaceResult>({ kind: "exit", exitCode: 7 });
  });

  it("passes a null exit code through", async () => {
    const raced = await raceLoginRunnerExit(Promise.resolve({ exitCode: null }), 10_000, undefined);
    expect(raced).toEqual<LoginRunnerRaceResult>({ kind: "exit", exitCode: null });
  });

  it("resolves with the timeout kind when the work hangs past the timeout", async () => {
    const hang = new Promise<{ exitCode: number | null }>(() => {});
    const raced = await raceLoginRunnerExit(hang, 5, undefined);
    expect(raced).toEqual<LoginRunnerRaceResult>({ kind: "timeout" });
  });

  it("resolves with the cancelled kind when the signal aborts", async () => {
    const hang = new Promise<{ exitCode: number | null }>(() => {});
    const controller = new AbortController();
    const racePromise = raceLoginRunnerExit(hang, 10_000, controller.signal);
    controller.abort();
    expect(await racePromise).toEqual<LoginRunnerRaceResult>({ kind: "cancelled" });
  });

  it("resolves with the cancelled kind when the signal is already aborted", async () => {
    const hang = new Promise<{ exitCode: number | null }>(() => {});
    const controller = new AbortController();
    controller.abort();
    const raced = await raceLoginRunnerExit(hang, 10_000, controller.signal);
    expect(raced).toEqual<LoginRunnerRaceResult>({ kind: "cancelled" });
  });

  it("returns cancelled for a pre-aborted signal even when the work can resolve", async () => {
    const controller = new AbortController();
    controller.abort();
    const raced = await raceLoginRunnerExit(
      Promise.resolve({ exitCode: 0 }),
      10_000,
      controller.signal,
    );
    expect(raced).toEqual<LoginRunnerRaceResult>({ kind: "cancelled" });
  });

  it("consumes a late work rejection after a pre-aborted signal cancels the race", async () => {
    let rejectWork: (error: Error) => void = () => {};
    const work = new Promise<{ exitCode: number | null }>((_resolve, reject) => {
      rejectWork = reject;
    });
    const controller = new AbortController();
    controller.abort();
    const raced = await raceLoginRunnerExit(work, 10_000, controller.signal);
    expect(raced).toEqual<LoginRunnerRaceResult>({ kind: "cancelled" });
    // The pre-aborted signal already cancelled the race. The work then rejects.
    // The helper consumes the late rejection, so it never becomes an unhandled
    // rejection.
    expect(() => rejectWork(new Error("late"))).not.toThrow();
    await Promise.resolve();
  });

  it("rejects when the work rejects", async () => {
    const error = new Error("the driver errored");
    await expect(raceLoginRunnerExit(Promise.reject(error), 10_000, undefined)).rejects.toBe(error);
  });

  it("does not double-settle when the signal aborts after the exit", async () => {
    const controller = new AbortController();
    const raced = await raceLoginRunnerExit(
      Promise.resolve({ exitCode: 0 }),
      10_000,
      controller.signal,
    );
    expect(raced).toEqual<LoginRunnerRaceResult>({ kind: "exit", exitCode: 0 });
    // The race already settled. A late abort must not throw or change the result.
    expect(() => controller.abort()).not.toThrow();
  });

  it("removes the abort listener after it settles on the exit", async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    await raceLoginRunnerExit(Promise.resolve({ exitCode: 0 }), 10_000, controller.signal);
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("consumes a late work rejection after the timeout settles the race", async () => {
    let rejectWork: (error: Error) => void = () => {};
    const work = new Promise<{ exitCode: number | null }>((_resolve, reject) => {
      rejectWork = reject;
    });
    const raced = await raceLoginRunnerExit(work, 5, undefined);
    expect(raced).toEqual<LoginRunnerRaceResult>({ kind: "timeout" });
    // The race already settled on the timeout. The work then rejects. The helper
    // consumes the late rejection, so it never becomes an unhandled rejection.
    expect(() => rejectWork(new Error("late"))).not.toThrow();
    await Promise.resolve();
  });
});

describe("login-runner lifecycle ordering", () => {
  it("disposes a driver one time", async () => {
    const dispose = vi.fn(async () => {});
    const driver: LoginRunnerDisposable = { dispose };
    await driver.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("races to a terminal state, then disposes the driver", async () => {
    const events: string[] = [];
    const driver: LoginRunnerDisposable = {
      dispose: vi.fn(async () => {
        events.push("dispose");
      }),
    };
    const work = Promise.resolve({ exitCode: 0 }).then((value) => {
      events.push("exit");
      return value;
    });
    const raced = await raceLoginRunnerExit(work, 10_000, undefined);
    await driver.dispose();
    expect(raced).toEqual<LoginRunnerRaceResult>({ kind: "exit", exitCode: 0 });
    expect(events).toEqual(["exit", "dispose"]);
  });
});
