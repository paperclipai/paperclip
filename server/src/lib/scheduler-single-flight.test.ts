import { describe, expect, it, vi } from "vitest";
import { createSchedulerSingleFlight } from "./scheduler-single-flight.js";

describe("createSchedulerSingleFlight", () => {
  it("keeps a slow paginated backstop pass single-flight across interval callbacks", async () => {
    let releasePage!: () => void;
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    let pageCursor: string | null = null;
    const visitedCursorIns: Array<string | null> = [];

    const visitPage = vi.fn(async () => {
      const cursorIn = pageCursor;
      visitedCursorIns.push(cursorIn);
      await pageGate;
      pageCursor = "page-1-last-candidate";
    });
    const singleFlight = createSchedulerSingleFlight(visitPage);

    const firstInterval = singleFlight.start();
    expect(firstInterval.started).toBe(true);
    await vi.waitFor(() => expect(visitPage).toHaveBeenCalledTimes(1));

    const overlappingInterval = singleFlight.start();
    expect(overlappingInterval).toMatchObject({
      started: false,
      activeInvocationId: firstInterval.started ? firstInterval.invocationId : undefined,
    });
    expect(visitedCursorIns).toEqual([null]);
    expect(pageCursor).toBeNull();

    releasePage();
    if (firstInterval.started) await firstInterval.promise;

    expect(visitPage).toHaveBeenCalledTimes(1);
    expect(pageCursor).toBe("page-1-last-candidate");

    const nextInterval = singleFlight.start();
    expect(nextInterval.started).toBe(true);
    if (nextInterval.started) await nextInterval.promise;

    expect(visitPage).toHaveBeenCalledTimes(2);
    expect(visitedCursorIns).toEqual([null, "page-1-last-candidate"]);
  });
});
