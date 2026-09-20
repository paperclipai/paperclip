import { describe, expect, it, vi } from "vitest";
import { TypesafeApiError, typesafeApi } from "../services/typesafe-api.js";

const KEY = "ts-secret-key";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const fetcherFor = (respond: () => Response) => {
  const mock = vi.fn(async (_url: unknown, _init?: RequestInit) => respond());
  return { mock, fetch: mock as unknown as typeof fetch };
};

describe("typesafeApi", () => {
  it("evaluates with bearer auth and returns the provider body", async () => {
    const body = {
      model: "jev-1.13.0",
      answers: {
        urgent: { type: "noul", noul: 0.9 },
        team: { type: "choice", choice: "billing", probabilities: { billing: 0.9, sales: 0.1 }, confidence: 0.8 },
        mood: { type: "score", score: 1.05, legend: { "0": "Calm", "1": "Angry" }, probabilities: { "0": 0.1, "1": 0.9 }, confidence: 0.9 },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    };
    const { mock, fetch } = fetcherFor(() => json(body));
    const request = {
      state: "s",
      model: "jev-latest",
      questions: { urgent: { type: "noul", instructions: "?" } },
    };
    await expect(typesafeApi(KEY, fetch).evaluate(request)).resolves.toEqual(body);
    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });

  it("lists model names", async () => {
    const { mock, fetch } = fetcherFor(() =>
      json({ models: [{ name: "jev-latest", description: "d", release_date: "2026-01-01" }, { name: "jev-preview" }] }),
    );
    await expect(typesafeApi(KEY, fetch).listModels()).resolves.toEqual(["jev-latest", "jev-preview"]);
    expect(String(mock.mock.calls[0]![0])).toBe("https://api.typesafe.ai/v1/models");
    expect(mock.mock.calls[0]![1]?.method).toBe("GET");
  });

  it.each([
    [401, "typesafe_unauthorized", false],
    [422, "typesafe_invalid_request", false],
    [429, "typesafe_rate_limited", true],
    [529, "typesafe_overloaded", true],
    [500, "typesafe_request_failed", false],
  ])("maps %i to %s without leaking the key or body", async (status, code, retryable) => {
    const { fetch } = fetcherFor(() => json({ detail: `bad ${KEY} private-state` }, status));
    const error = await typesafeApi(KEY, fetch).listModels().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypesafeApiError);
    expect(error).toMatchObject({ status, code, retryable });
    const rendered = `${(error as Error).message} ${JSON.stringify(error)}`;
    expect(rendered).not.toContain(KEY);
    expect(rendered).not.toContain("private-state");
  });

  it("does not retry a rate-limited request", async () => {
    const { mock, fetch } = fetcherFor(() => json({}, 429));
    await typesafeApi(KEY, fetch).listModels().catch(() => null);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed provider body", async () => {
    const { fetch } = fetcherFor(() => json({ model: "jev-1.13.0", answers: { q: { type: "essay" } }, usage: {} }));
    await expect(
      typesafeApi(KEY, fetch).evaluate({ state: "s", model: "jev-latest", questions: {} }),
    ).rejects.toThrow();
  });
});
