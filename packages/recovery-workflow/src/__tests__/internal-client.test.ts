/**
 * Unit tests for makeInternalClient.
 * Uses vi.stubGlobal to mock fetch — plain vitest/node, no workerd required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeInternalClient } from "../internal-client.ts";

const BASE = "https://api.example.com";
const SECRET = "super-secret";

function makeEnv() {
  return {
    INTERNAL_API_BASE_URL: BASE,
    INTERNAL_API_SECRET: SECRET,
    RECOVERY_WORKFLOW: {} as Workflow,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchOk(body: unknown) {
  const mockedFetch = vi.mocked(fetch);
  mockedFetch.mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200 })
  );
}

describe("makeInternalClient", () => {
  describe("attempt()", () => {
    it("POSTs to the correct URL with x-internal-secret header", async () => {
      mockFetchOk({ active: true, status: "pending", attemptCount: 1, nextIntervalMs: 5000 });

      const client = makeInternalClient(makeEnv());
      await client.attempt({
        companyId: "co_1",
        actionId: "act_1",
        sourceIssueId: "iss_1",
        attemptNumber: 1,
        mode: "dry",
      });

      const mockedFetch = vi.mocked(fetch);
      expect(mockedFetch).toHaveBeenCalledOnce();
      const [url, init] = mockedFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE}/internal/recovery/act_1/attempt`);
      expect((init.headers as Record<string, string>)["x-internal-secret"]).toBe(SECRET);
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        companyId: "co_1",
        sourceIssueId: "iss_1",
        attemptNumber: 1,
        mode: "dry",
      });
    });

    it("returns parsed response body", async () => {
      const responseBody = { active: false, status: "resolved", attemptCount: 3, nextIntervalMs: 0 };
      mockFetchOk(responseBody);

      const client = makeInternalClient(makeEnv());
      const result = await client.attempt({
        companyId: "co_1",
        actionId: "act_1",
        sourceIssueId: "iss_1",
        attemptNumber: 3,
        mode: "active",
      });

      expect(result).toEqual(responseBody);
    });

    it("throws on non-2xx response", async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response("Server Error", { status: 500 })
      );

      const client = makeInternalClient(makeEnv());
      await expect(
        client.attempt({
          companyId: "co_1",
          actionId: "act_1",
          sourceIssueId: "iss_1",
          attemptNumber: 1,
          mode: "dry",
        })
      ).rejects.toThrow(/500/);
    });
  });

  describe("getState()", () => {
    it("GETs the correct URL with query params and x-internal-secret header", async () => {
      mockFetchOk({ active: true, status: "pending", attemptCount: 2 });

      const client = makeInternalClient(makeEnv());
      await client.getState({
        companyId: "co_1",
        actionId: "act_1",
        sourceIssueId: "iss_1",
      });

      const mockedFetch = vi.mocked(fetch);
      expect(mockedFetch).toHaveBeenCalledOnce();
      const [url, init] = mockedFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        `${BASE}/internal/recovery/act_1?companyId=co_1&sourceIssueId=iss_1`
      );
      expect((init.headers as Record<string, string>)["x-internal-secret"]).toBe(SECRET);
      expect(init.method).toBe("GET");
    });

    it("returns parsed state body", async () => {
      const stateBody = { active: true, status: "in_progress", attemptCount: 4 };
      mockFetchOk(stateBody);

      const client = makeInternalClient(makeEnv());
      const result = await client.getState({
        companyId: "co_1",
        actionId: "act_1",
        sourceIssueId: "iss_1",
      });

      expect(result).toEqual(stateBody);
    });

    it("throws on non-2xx response", async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response("Not Found", { status: 404 })
      );

      const client = makeInternalClient(makeEnv());
      await expect(
        client.getState({
          companyId: "co_1",
          actionId: "act_1",
          sourceIssueId: "iss_1",
        })
      ).rejects.toThrow(/404/);
    });
  });
});
