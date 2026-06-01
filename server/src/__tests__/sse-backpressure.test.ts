import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import {
  MAX_SSE_BACKLOG_BYTES,
  sseBacklogExceeded,
  writeSseFrame,
} from "../services/sse-registry.js";

describe("sse backpressure", () => {
  it("does not flag a backlog under the cap", () => {
    expect(sseBacklogExceeded(0)).toBe(false);
    expect(sseBacklogExceeded(1_024)).toBe(false);
    expect(sseBacklogExceeded(MAX_SSE_BACKLOG_BYTES)).toBe(false);
  });

  it("flags a backlog over the cap", () => {
    expect(sseBacklogExceeded(MAX_SSE_BACKLOG_BYTES + 1)).toBe(true);
    expect(sseBacklogExceeded(MAX_SSE_BACKLOG_BYTES * 8)).toBe(true);
  });

  it("respects a caller-provided cap", () => {
    expect(sseBacklogExceeded(2_048, 1_024)).toBe(true);
    expect(sseBacklogExceeded(512, 1_024)).toBe(false);
  });

  it("exposes a positive default cap", () => {
    expect(MAX_SSE_BACKLOG_BYTES).toBeGreaterThan(0);
  });

  function fakeRes(opts: { writable: boolean; writableLength: number }) {
    return {
      writable: opts.writable,
      writableLength: opts.writableLength,
      write: vi.fn(),
      end: vi.fn(),
    } as unknown as Response & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  }

  it("writes the frame when the connection is writable and under the cap", () => {
    const res = fakeRes({ writable: true, writableLength: 1_000 });
    const ok = writeSseFrame(res, "data: x\n\n");
    expect(ok).toBe(true);
    expect(res.write).toHaveBeenCalledWith("data: x\n\n");
    expect(res.end).not.toHaveBeenCalled();
  });

  it("does not write and reports false when not writable", () => {
    const res = fakeRes({ writable: false, writableLength: 0 });
    const ok = writeSseFrame(res, "data: x\n\n");
    expect(ok).toBe(false);
    expect(res.write).not.toHaveBeenCalled();
  });

  it("force-closes (ends) and reports false when the backlog is over the cap", () => {
    const res = fakeRes({ writable: true, writableLength: MAX_SSE_BACKLOG_BYTES + 1 });
    const ok = writeSseFrame(res, "data: x\n\n");
    expect(ok).toBe(false);
    expect(res.write).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledTimes(1);
  });
});
