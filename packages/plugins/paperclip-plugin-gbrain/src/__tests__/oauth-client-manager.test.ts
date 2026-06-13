import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OAuthClientManager,
  loadClientsFromFile,
} from "../oauth-client-manager.js";

function mockTokenResponse(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  )) as unknown as typeof fetch;
}

describe("OAuthClientManager", () => {
  it("fetches a Bearer for an agent and caches until near-expiry", async () => {
    let now = 1000; // seconds-since-epoch
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: "at-1",
      token_type: "bearer",
      expires_in: 3600,
      scope: "read write",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const mgr = new OAuthClientManager({
      tokenUrl: "http://gbrain/token",
      clients: {
        "agent-a": { client_id: "cid-a", client_secret: "csec-a" },
      },
      fetch: fetchMock as unknown as typeof fetch,
      nowSec: () => now,
    });

    expect(await mgr.getToken("agent-a")).toBe("at-1");
    // Cache hit: no second fetch within the window.
    now = 1500;
    expect(await mgr.getToken("agent-a")).toBe("at-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Body shape: form-encoded client_credentials grant.
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = init.body as string;
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain("client_id=cid-a");
    expect(body).toContain("client_secret=csec-a");
    expect(body).toContain("scope=read+write");
  });

  it("refreshes after expiry leeway elapses", async () => {
    let now = 1000;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: `at-${now}`,
      token_type: "bearer",
      expires_in: 100, // tiny so we cross the leeway boundary
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const mgr = new OAuthClientManager({
      tokenUrl: "http://gbrain/token",
      clients: { a: { client_id: "c", client_secret: "s" } },
      fetch: fetchMock as unknown as typeof fetch,
      nowSec: () => now,
    });

    const t1 = await mgr.getToken("a");
    expect(t1).toBe("at-1000");
    // Past leeway window (refreshAt = now + max(60, 100-60) = now+60).
    now = 1100;
    const t2 = await mgr.getToken("a");
    expect(t2).toBe("at-1100");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes into one /token exchange", async () => {
    let resolvers: Array<(value: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    })) as unknown as typeof fetch;

    const mgr = new OAuthClientManager({
      tokenUrl: "http://gbrain/token",
      clients: { a: { client_id: "c", client_secret: "s" } },
      fetch: fetchMock,
    });

    const p1 = mgr.getToken("a");
    const p2 = mgr.getToken("a");
    const p3 = mgr.getToken("a");
    // All three should be waiting on the same in-flight promise.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Resolve the in-flight fetch with a valid token response.
    resolvers[0](new Response(JSON.stringify({
      access_token: "shared-token",
      token_type: "bearer",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    expect(await p1).toBe("shared-token");
    expect(await p2).toBe("shared-token");
    expect(await p3).toBe("shared-token");
  });

  it("throws when /token returns an error response", async () => {
    const fetchMock = mockTokenResponse(
      { error: "invalid_client" },
      401,
    );
    const mgr = new OAuthClientManager({
      tokenUrl: "http://gbrain/token",
      clients: { a: { client_id: "c", client_secret: "s" } },
      fetch: fetchMock,
    });
    await expect(mgr.getToken("a")).rejects.toThrow(/HTTP 401/);
  });

  it("does not cache a failed /token exchange", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "recovered-token",
        token_type: "bearer",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const mgr = new OAuthClientManager({
      tokenUrl: "http://gbrain/token",
      clients: { a: { client_id: "c", client_secret: "s" } },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(mgr.getToken("a")).rejects.toThrow(/HTTP 401/);
    await expect(mgr.getToken("a")).resolves.toBe("recovered-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the configured agent is unknown", async () => {
    const fetchMock = mockTokenResponse({ access_token: "x" });
    const mgr = new OAuthClientManager({
      tokenUrl: "http://gbrain/token",
      clients: { a: { client_id: "c", client_secret: "s" } },
      fetch: fetchMock,
    });
    await expect(mgr.getToken("not-configured")).rejects.toThrow(/no client configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invalidate() drops the cache so the next call re-fetches", async () => {
    let counter = 0;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: `at-${++counter}`,
      token_type: "bearer",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const mgr = new OAuthClientManager({
      tokenUrl: "http://gbrain/token",
      clients: { a: { client_id: "c", client_secret: "s" } },
      fetch: fetchMock,
    });
    expect(await mgr.getToken("a")).toBe("at-1");
    mgr.invalidate("a");
    expect(await mgr.getToken("a")).toBe("at-2");
  });
});

describe("loadClientsFromFile", () => {
  it("parses a valid JSON map", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gbrain-test-"));
    const path = join(dir, "clients.json");
    await writeFile(path, JSON.stringify({
      "agent-1": {
        client_id: "cid-1",
        client_secret: "csec-1",
        name: "paperclip:Blockcast:CTO",
      },
      "agent-2": { client_id: "cid-2", client_secret: "csec-2" },
    }));
    const out = await loadClientsFromFile(path);
    expect(out).not.toBeNull();
    expect(Object.keys(out!).sort()).toEqual(["agent-1", "agent-2"]);
    expect(out!["agent-1"].client_secret).toBe("csec-1");
    expect(out!["agent-1"].name).toBe("paperclip:Blockcast:CTO");
    await rm(dir, { recursive: true });
  });

  it("returns null when the file is missing", async () => {
    expect(await loadClientsFromFile("/nonexistent-path-zzz/clients.json")).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gbrain-test-"));
    const path = join(dir, "clients.json");
    await writeFile(path, "{not json");
    expect(await loadClientsFromFile(path)).toBeNull();
    await rm(dir, { recursive: true });
  });

  it("skips entries missing client_id or client_secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gbrain-test-"));
    const path = join(dir, "clients.json");
    await writeFile(path, JSON.stringify({
      "good": { client_id: "c", client_secret: "s" },
      "halfway": { client_id: "c-only" },
      "weird": "not-an-object",
    }));
    const out = await loadClientsFromFile(path);
    expect(Object.keys(out!)).toEqual(["good"]);
    await rm(dir, { recursive: true });
  });

  it("returns null when the JSON has no usable entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gbrain-test-"));
    const path = join(dir, "clients.json");
    await writeFile(path, JSON.stringify({ invalid: 123 }));
    expect(await loadClientsFromFile(path)).toBeNull();
    await rm(dir, { recursive: true });
  });
});
