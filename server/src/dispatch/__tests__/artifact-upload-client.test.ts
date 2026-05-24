/**
 * Phase 3.5 Step 2 -- `httpArtifactUploadClient` unit tests.
 *
 * Verifies:
 *   - JSON files (.json) go via the JSON PUT route with
 *     Content-Type: application/json and parsed body.
 *   - Non-JSON files go via the binary PUT route with
 *     Content-Type: application/octet-stream and raw bytes.
 *   - Non-2xx responses throw with HTTP status + URL in the message.
 *   - Every request includes the correct Authorization: Bearer header.
 *   - Base URL trailing slash is stripped so URLs are well-formed.
 *
 * All HTTP interaction is intercepted via `vi.stubGlobal("fetch", ...)` --
 * no real network calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { httpArtifactUploadClient } from "../artifacts-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockFetch(status = 200, body = "{}") {
  return vi.fn(async () =>
    new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// Captures the last request passed to fetch so tests can inspect headers
// and body.
type CapturedRequest = {
  url: string;
  init: RequestInit | undefined;
  bodyText: string | null;
  bodyBytes: Uint8Array | null;
};

function makeCapturingFetch(status = 200): {
  fetch: ReturnType<typeof vi.fn>;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      url = (input as Request).url;
    }

    let bodyText: string | null = null;
    let bodyBytes: Uint8Array | null = null;
    if (init?.body) {
      if (typeof init.body === "string") {
        bodyText = init.body;
      } else if (init.body instanceof Uint8Array) {
        // Capture raw bytes (lossless) -- do NOT decode to UTF-8 as that
        // corrupts arbitrary binary content (e.g. 0xff).
        bodyBytes = init.body;
        bodyText = null;
      } else {
        bodyText = String(init.body);
      }
    }
    captured.push({ url, init, bodyText, bodyBytes });
    return new Response("{}", { status });
  });
  return { fetch: mockFetch, captured };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("httpArtifactUploadClient", () => {
  const env = { url: "http://agent-fs:8080", token: "test-token-abc" };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PUTs JSON for .json filenames via JSON route with Content-Type application/json", async () => {
    const { fetch: mockFetch, captured } = makeCapturingFetch(200);
    vi.stubGlobal("fetch", mockFetch);

    const client = httpArtifactUploadClient(env);
    const payload = { result: "ok", score: 42 };
    await client.uploadArtifact(
      "req-1",
      "research",
      "research-bundle.json",
      Buffer.from(JSON.stringify(payload)),
    );

    expect(captured).toHaveLength(1);
    const req = captured[0];
    // Should use the plain JSON route (no /binary suffix).
    expect(req.url).toBe("http://agent-fs:8080/artifacts/req-1/research/research-bundle.json");
    expect((req.init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    // Body should be valid JSON matching original payload.
    expect(JSON.parse(req.bodyText!)).toEqual(payload);
  });

  it("PUTs binary for non-.json filenames via binary route with Content-Type application/octet-stream", async () => {
    const { fetch: mockFetch, captured } = makeCapturingFetch(200);
    vi.stubGlobal("fetch", mockFetch);

    const client = httpArtifactUploadClient(env);
    const rawBytes = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await client.uploadArtifact("req-2", "edit", "output.mp4", rawBytes);

    expect(captured).toHaveLength(1);
    const req = captured[0];
    // Should use the binary route.
    expect(req.url).toBe("http://agent-fs:8080/artifacts/req-2/edit/output.mp4/binary");
    expect((req.init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/octet-stream",
    );
    // Body bytes should be preserved exactly (no UTF-8 corruption of 0xff).
    expect(req.bodyBytes).not.toBeNull();
    expect(Buffer.from(req.bodyBytes!)).toEqual(rawBytes);
  });

  it("throws with HTTP status and URL when server returns non-2xx", async () => {
    vi.stubGlobal("fetch", makeMockFetch(403));

    const client = httpArtifactUploadClient(env);
    await expect(
      client.uploadArtifact("req-3", "copy", "script.json", Buffer.from("{}")),
    ).rejects.toThrow(/403/);
  });

  it("includes Bearer authorization header on every request", async () => {
    const { fetch: mockFetch, captured } = makeCapturingFetch(200);
    vi.stubGlobal("fetch", mockFetch);

    const client = httpArtifactUploadClient(env);
    await client.uploadArtifact("req-4", "strategy", "brief.json", Buffer.from("{}"));

    expect(captured).toHaveLength(1);
    expect((captured[0].init?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-token-abc",
    );
  });

  it("strips trailing slash from base URL so the path is well-formed", async () => {
    const { fetch: mockFetch, captured } = makeCapturingFetch(200);
    vi.stubGlobal("fetch", mockFetch);

    const clientWithSlash = httpArtifactUploadClient({
      url: "http://agent-fs:8080/",
      token: "tok",
    });
    await clientWithSlash.uploadArtifact("r", "s", "f.json", Buffer.from("{}"));

    expect(captured[0].url).toBe("http://agent-fs:8080/artifacts/r/s/f.json");
    // Ensure no double slash.
    expect(captured[0].url).not.toContain("//artifacts");
  });

  it("throws the error with the URL in the message for non-2xx", async () => {
    vi.stubGlobal("fetch", makeMockFetch(500));

    const client = httpArtifactUploadClient(env);
    await expect(
      client.uploadArtifact("req-5", "edit", "final.mp4", Buffer.from([0x01])),
    ).rejects.toThrow(/PUT http:\/\/agent-fs:8080\/artifacts\/req-5\/edit\/final\.mp4\/binary/);
  });

  // ---------------------------------------------------------------------------
  // Fix 1: fetch timeout -- AbortSignal.timeout(30_000) is forwarded
  // ---------------------------------------------------------------------------

  it("[Fix 1] passes an AbortSignal to every fetch call (30s timeout)", async () => {
    // Capture the init object passed to fetch and verify that signal is present.
    const captured: { signal: unknown }[] = [];
    const mockFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      captured.push({ signal: init?.signal });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = httpArtifactUploadClient(env);

    // JSON route.
    await client.uploadArtifact("req-sig-json", "research", "data.json", Buffer.from("{}"));
    // Binary route.
    await client.uploadArtifact("req-sig-bin", "edit", "clip.mp4", Buffer.from([0x00]));

    expect(captured).toHaveLength(2);
    for (const { signal } of captured) {
      // AbortSignal.timeout() returns an AbortSignal instance.
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });
});
