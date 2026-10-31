import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

import { runAdmissionCommand } from "./environment-overflow.js";

function fakeProcess(pid: number) {
  return Object.assign(new EventEmitter(), { pid, kill: vi.fn() });
}

describe("admission probe cleanup on Windows", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "win32" });
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", platform);
    spawn.mockReset();
  });

  it("refuses at the timeout without waiting for a hung taskkill, and bounds that cleanup", async () => {
    const probe = fakeProcess(100);
    const taskkill = fakeProcess(200);
    spawn.mockReturnValueOnce(probe).mockReturnValueOnce(taskkill);
    let result: boolean | undefined;
    void runAdmissionCommand(["probe"], 1_000).then((r) => { result = r; });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(result).toBe(false);
    expect(spawn).toHaveBeenLastCalledWith("taskkill", ["/pid", "100", "/T", "/F"], expect.objectContaining({ windowsHide: true }));
    expect(taskkill.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(taskkill.kill).toHaveBeenCalledOnce();
  });
});
