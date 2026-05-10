import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBbaBet, fetchBbaStats, fetchRecentBbaRuns } from "../../../api/bbaMemory";
import type { ExecuteBetRequest } from "../../../api/bbaMemory";

const json = vi.fn();

function mockFetch(response: { ok?: boolean; status?: number; statusText?: string; body?: unknown } = {}) {
  json.mockResolvedValue(response.body ?? {});
  vi.spyOn(global, "fetch").mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    statusText: response.statusText ?? "OK",
    json,
  } as any);
}

const payload: ExecuteBetRequest = {
  loginUsername: { secretName: "user" },
  loginPassword: { secretName: "pass" },
  bookmakerConfig: { bookmaker: "Betano" },
  bet: { matchLabel: "A vs B", market: "1X2", selection: "1", odds: 2, stake: 10 },
  riskControls: { maxStakePerBet: 10, maxTotalStakePerSession: 20 },
};

beforeEach(() => {
  json.mockReset();
  mockFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bbaMemory API client", () => {
  describe("fetchRecentBbaRuns", () => {
    it("calls /api/companies/:companyId/bba-memory/recent-runs with default limit", async () => {
      await fetchRecentBbaRuns("c1");
      expect(fetch).toHaveBeenCalledWith(
        "/api/companies/c1/bba-memory/recent-runs",
        expect.objectContaining({ credentials: "include" }),
      );
    });

    it("appends limit query param when provided", async () => {
      await fetchRecentBbaRuns("c1", { limit: 5 });
      expect(fetch).toHaveBeenCalledWith(
        "/api/companies/c1/bba-memory/recent-runs?limit=5",
        expect.any(Object),
      );
    });

    it("URL-encodes companyId", async () => {
      await fetchRecentBbaRuns("company / one", { limit: 2 });
      expect(fetch).toHaveBeenCalledWith(
        "/api/companies/company%20%2F%20one/bba-memory/recent-runs?limit=2",
        expect.any(Object),
      );
    });

    it("throws on non-ok response with status text", async () => {
      mockFetch({ ok: false, status: 503, statusText: "Service Unavailable" });
      await expect(fetchRecentBbaRuns("c1")).rejects.toThrow(
        "fetchRecentBbaRuns failed: 503 Service Unavailable",
      );
    });
  });

  describe("fetchBbaStats", () => {
    it("calls /api/companies/:companyId/bba-memory/stats-summary with default windowDays", async () => {
      await fetchBbaStats("c1");
      expect(fetch).toHaveBeenCalledWith(
        "/api/companies/c1/bba-memory/stats-summary",
        expect.objectContaining({ credentials: "include" }),
      );
    });

    it("appends windowDays query param when provided", async () => {
      await fetchBbaStats("c1", { windowDays: 14 });
      expect(fetch).toHaveBeenCalledWith(
        "/api/companies/c1/bba-memory/stats-summary?windowDays=14",
        expect.any(Object),
      );
    });

    it("throws on non-ok response", async () => {
      mockFetch({ ok: false, status: 500, statusText: "Internal Server Error" });
      await expect(fetchBbaStats("c1")).rejects.toThrow(
        "fetchBbaStats failed: 500 Internal Server Error",
      );
    });
  });

  describe("executeBbaBet", () => {
    it("POSTs to /api/companies/:companyId/betting-browser-automation/execute", async () => {
      await executeBbaBet("c1", payload);
      expect(fetch).toHaveBeenCalledWith(
        "/api/companies/c1/betting-browser-automation/execute",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("sends correct Content-Type header", async () => {
      await executeBbaBet("c1", payload);
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: { "Content-Type": "application/json" } }),
      );
    });

    it("includes credentials: 'include' for cookie auth", async () => {
      await executeBbaBet("c1", payload);
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ credentials: "include" }),
      );
    });

    it("JSON-stringifies the payload body", async () => {
      await executeBbaBet("c1", payload);
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: JSON.stringify(payload) }),
      );
    });

    it("throws on non-ok response", async () => {
      mockFetch({ ok: false, status: 422, statusText: "Unprocessable Entity" });
      await expect(executeBbaBet("c1", payload)).rejects.toThrow(
        "executeBbaBet failed: 422 Unprocessable Entity",
      );
    });
  });
});
