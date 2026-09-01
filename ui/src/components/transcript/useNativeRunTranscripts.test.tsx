// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeRunTranscripts } from "./useNativeRunTranscripts";

const eventsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: { events: eventsMock },
}));

function Probe() {
  const { errorsByRun } = useNativeRunTranscripts([
    { id: "native-run", status: "succeeded", runtimeMode: "native" },
  ]);
  return (
    <div data-testid="errors">
      {[...errorsByRun.keys()].join(",")}
    </div>
  );
}

function MultiRunProbe() {
  useNativeRunTranscripts([
    { id: "failed-run", status: "succeeded", runtimeMode: "native" },
    { id: "healthy-run", status: "succeeded", runtimeMode: "native" },
  ]);
  return null;
}

describe("useNativeRunTranscripts", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    eventsMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("exposes event transport failures and retries terminal runs until recovery", async () => {
    eventsMock
      .mockRejectedValueOnce(new Error("event endpoint unavailable"))
      .mockResolvedValue([]);

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    expect(container.textContent).toBe("native-run");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(eventsMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("");
  });

  it("retries only terminal runs whose event request failed", async () => {
    eventsMock.mockImplementation((runId: string) => (
      runId === "failed-run"
        ? Promise.reject(new Error("event endpoint unavailable"))
        : Promise.resolve([])
    ));

    await act(async () => {
      root.render(<MultiRunProbe />);
      await Promise.resolve();
    });
    expect(eventsMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(eventsMock).toHaveBeenCalledTimes(3);
    expect(eventsMock.mock.calls.at(-1)?.[0]).toBe("failed-run");
  });
});
