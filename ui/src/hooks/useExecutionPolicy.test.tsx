// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useExecutionPolicy } from "./useExecutionPolicy";

const capture = vi.hoisted(() => vi.fn());
vi.mock("../lib/sentry", () => ({ captureBrowserException: capture }));

function Policy({ value }: { value: unknown }) {
  const result = useExecutionPolicy(value);
  return <span>{result.success ? "available" : "unavailable"}</span>;
}

afterEach(() => capture.mockClear());

describe("execution policy diagnostics", () => {
  it("normalizes valid omissions quietly", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<StrictMode><Policy value={{ monitor: { nextCheckAt: "2099-01-01T00:00:00Z" } }} /></StrictMode>));
    expect(container.textContent).toBe("available");
    expect(capture).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("reports only a closed category once despite repeated rendering and refreshed objects", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const invalid = { stages: "synthetic-private-value", taskId: "synthetic-task-id", monitor: { notes: "synthetic-notes" } };
    act(() => root.render(<StrictMode><Policy value={invalid} /></StrictMode>));
    act(() => root.render(<StrictMode><Policy value={structuredClone(invalid)} /></StrictMode>));
    expect(container.textContent).toBe("unavailable");
    expect(capture).toHaveBeenCalledTimes(1);
    const [error, details] = capture.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Invalid task execution policy (stages)");
    expect(error.cause).toBeUndefined();
    expect(details).toBeUndefined();
    expect(Object.keys(error)).toEqual([]);
    expect(error.stack).not.toContain("synthetic-");

    act(() => root.render(<StrictMode><Policy value={{ stages: [] }} /></StrictMode>));
    expect(container.textContent).toBe("available");
    act(() => root.render(<StrictMode><Policy value={invalid} /></StrictMode>));
    expect(capture).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
