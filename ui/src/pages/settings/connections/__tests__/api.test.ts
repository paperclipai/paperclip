import { describe, it, expect, vi } from "vitest";
import {
  disconnectConnection,
  listConnections,
  listProviders,
  refreshConnection,
  startConnect,
} from "../api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("oauth API client", () => {
  it("listProviders calls the expected endpoint with credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ providers: [] }));
    await listProviders("c1", { fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/companies/c1/oauth/providers",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("listConnections calls the expected endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ connections: [] }));
    await listConnections("c1", { fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/companies/c1/oauth/connections",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("listProviders throws on non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(listProviders("c1", { fetch: fetchMock })).rejects.toThrow(/listProviders 500/);
  });

  it("startConnect posts returnUrl + scopes as JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ authorizeUrl: "https://example.test/auth", state: "s" }));
    await startConnect(
      "c1",
      "github",
      { returnUrl: "/company/settings/connections", scopes: ["repo"] },
      { fetch: fetchMock },
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(String(init.body))).toEqual({
      returnUrl: "/company/settings/connections",
      scopes: ["repo"],
    });
  });

  it("startConnect surfaces server errorCode", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ errorCode: "provider_not_configured" }, 400));
    await expect(
      startConnect("c1", "github", { returnUrl: "/x" }, { fetch: fetchMock }),
    ).rejects.toThrow(/provider_not_configured/);
  });

  it("refreshConnection POSTs the refresh URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await refreshConnection("c1", "conn-1", { fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/companies/c1/oauth/connections/conn-1/refresh",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("disconnectConnection DELETEs the connection URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await disconnectConnection("c1", "conn-1", { fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/companies/c1/oauth/connections/conn-1",
      expect.objectContaining({ method: "DELETE", credentials: "include" }),
    );
  });

  it("refreshConnection throws on non-OK response so the UI can surface the failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ errorCode: "in_backoff" }, 429));
    await expect(refreshConnection("c1", "conn-1", { fetch: fetchMock })).rejects.toThrow(
      /in_backoff/,
    );
  });

  it("disconnectConnection throws on non-OK response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ errorCode: "forbidden" }, 403));
    await expect(disconnectConnection("c1", "conn-1", { fetch: fetchMock })).rejects.toThrow(
      /forbidden/,
    );
  });
});
