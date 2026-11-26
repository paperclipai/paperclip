import { createHash } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { captureRunnerApiResponse } from "./runner-api-response.js";
import { acquireRunnerApiResponseSlot, runnerApiCompanyCaptureMaxBytes, RUNNER_API_RESPONSE_MAX_BYTES } from "./runner-api-response-limits.js";

const controller = () => new AbortController();
describe("streamed API response capture", () => {
  it("rejects an oversized Content-Length before reading or reserving disk", async () => {
    let cancelled = false;
    let reserved = false;
    const abort = controller();
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": String(RUNNER_API_RESPONSE_MAX_BYTES + 1) } });
    await expect(captureRunnerApiResponse(response, 24 * 1024, abort, 1000, undefined, {
      beforeSpill: async () => { reserved = true; },
    })).rejects.toMatchObject({ code: "api_response_too_large" });
    expect(cancelled).toBe(true);
    expect(abort.signal.aborted).toBe(true);
    expect(reserved).toBe(false);
  });
  it.each([undefined, "1"])("counts streamed bytes with Content-Length %s and removes partial files", async contentLength => {
    const before = new Set(await readdir(tmpdir()));
    let cancelled = false;
    let reserved = 0;
    const response = new Response(new ReadableStream({
      pull(target) { target.enqueue(Buffer.alloc(4096)); },
      cancel() { cancelled = true; },
    }), { headers: contentLength ? { "content-length": contentLength } : {} });
    await expect(captureRunnerApiResponse(response, 4096, controller(), 1000, undefined, {
      maxBytes: 16 * 1024,
      beforeSpill: async () => { reserved++; },
    })).rejects.toMatchObject({ code: "api_response_too_large" });
    expect(cancelled).toBe(true);
    expect(reserved).toBe(1);
    expect((await readdir(tmpdir())).filter(name => name.startsWith("paperclip-api-response-") && !before.has(name))).toEqual([]);
  });
  it("accepts exactly the capture limit", async () => {
    const captured = await captureRunnerApiResponse(new Response(Buffer.alloc(8192)), 4096, controller(), 1000, undefined, { maxBytes: 8192 });
    try { expect(captured.byteSize).toBe(8192); }
    finally { await captured.dispose(); }
  });
  it("stops an active endless stream at the total deadline", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      async pull(target) {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (!cancelled) target.enqueue(Buffer.alloc(4096));
      },
      cancel() { cancelled = true; },
    }));
    await expect(captureRunnerApiResponse(response, 4096, controller(), 1000, undefined, { deadlineMs: 30 })).rejects.toMatchObject({ code: "api_response_timeout" });
    expect(cancelled).toBe(true);
  });
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

describe("large response concurrency", () => {
  it("only accepts finite positive operator quotas, never unlimited settings", () => {
    try {
      for (const value of ["0", "-1", "Infinity", "NaN", "1", "9007199254740992"]) {
        vi.stubEnv("PAPERCLIP_RUNNER_API_COMPANY_CAPTURE_MAX_BYTES", value);
        expect(runnerApiCompanyCaptureMaxBytes()).toBe(20 * RUNNER_API_RESPONSE_MAX_BYTES);
      }
      vi.stubEnv("PAPERCLIP_RUNNER_API_COMPANY_CAPTURE_MAX_BYTES", String(2 * RUNNER_API_RESPONSE_MAX_BYTES));
      expect(runnerApiCompanyCaptureMaxBytes()).toBe(2 * RUNNER_API_RESPONSE_MAX_BYTES);
    } finally { vi.unstubAllEnvs(); }
  });
  it("limits each company and the server and releases slots idempotently", () => {
    const releases: Array<() => void> = [];
    try {
      releases.push(acquireRunnerApiResponseSlot("a"), acquireRunnerApiResponseSlot("a"));
      expect(() => acquireRunnerApiResponseSlot("a")).toThrow("busy");
      releases.push(acquireRunnerApiResponseSlot("b"), acquireRunnerApiResponseSlot("b"));
      expect(() => acquireRunnerApiResponseSlot("c")).toThrow("busy");
      releases[0](); releases[0]();
      releases.push(acquireRunnerApiResponseSlot("c"));
      expect(() => acquireRunnerApiResponseSlot("d")).toThrow("busy");
    } finally { for (const release of releases) release(); }
    acquireRunnerApiResponseSlot("a")();
  });
});
