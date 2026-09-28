import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { captureRunnerApiResponse } from "./runner-api-response.js";

const controller = () => new AbortController();
describe("streamed API response capture", () => {
  it("spills a chunked response and reads only requested bytes, preserving its digest", async () => {
    const chunk = Buffer.alloc(64 * 1024, 65);
    const digest = createHash("sha256");
    let emitted = 0;
    const response = new Response(new ReadableStream({
      pull(target) {
        if (emitted++ === 200) return target.close();
        digest.update(chunk);
        target.enqueue(chunk);
      },
    }));
    const captured = await captureRunnerApiResponse(response, 24 * 1024, controller(), 1000);
    expect(Buffer.isBuffer(captured.body)).toBe(false);
    if (Buffer.isBuffer(captured.body)) throw new Error("Expected a file");
    const path = captured.body.path;
    try {
      expect(captured.body).toMatchObject({ byteSize: 200 * chunk.length, sha256: digest.digest("hex") });
      expect(await captured.read(11 * 1024 * 1024, 4)).toEqual(Buffer.from("AAAA"));
      expect(await captured.read(captured.byteSize, 4)).toHaveLength(0);
    } finally { await captured.dispose(); }
    await expect(access(path)).rejects.toThrow();
  });
  it("keeps small bodies inline", async () => {
    const captured = await captureRunnerApiResponse(new Response("small"), 24 * 1024, controller(), 1000);
    try { expect(captured.body).toEqual(Buffer.from("small")); }
    finally { await captured.dispose(); }
  });
  it("stops a long capture when its run loses authority", async () => {
    let checks = 0;
    let cancelled = false;
    const response = new Response(new ReadableStream({
      pull(target) { target.enqueue(Buffer.alloc(64 * 1024)); },
      cancel() { cancelled = true; },
    }));
    await expect(captureRunnerApiResponse(response, 24 * 1024, controller(), 1000, async () => {
      if (++checks === 2) throw new Error("run stopped");
    })).rejects.toThrow("run stopped");
    expect(cancelled).toBe(true);
    expect(checks).toBe(2);
  });
  it("allows active downloads longer than the idle timeout", async () => {
    let chunks = 0;
    const response = new Response(new ReadableStream({
      async pull(target) {
        await new Promise(resolve => setTimeout(resolve, 20));
        if (chunks++ === 5) target.close();
        else target.enqueue(Buffer.from("a"));
      },
    }));
    const captured = await captureRunnerApiResponse(response, 24 * 1024, controller(), 100);
    try { expect(captured.body).toEqual(Buffer.from("aaaaa")); }
    finally { await captured.dispose(); }
  });
  it("cancels stalled bodies and aborts the HTTP request", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const abort = controller();
    await expect(captureRunnerApiResponse(response, 24 * 1024, abort, 10)).rejects.toThrow("timed out");
    expect(cancelled).toBe(true);
    expect(abort.signal.aborted).toBe(true);
  });
});
