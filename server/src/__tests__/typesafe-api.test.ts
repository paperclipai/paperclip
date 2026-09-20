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
    [401, "typesafe_api_key_rejected", 502, false],
    [403, "typesafe_api_key_rejected", 502, false],
    [422, "typesafe_invalid_request", 422, false],
    [429, "typesafe_rate_limited", 429, true],
    [529, "typesafe_overloaded", 503, true],
    [500, "typesafe_request_failed", 502, false],
  ])("maps %i to %s without leaking the key or body", async (status, code, httpStatus, retryable) => {
    const { fetch } = fetcherFor(() => json({ detail: `bad ${KEY} private-state` }, status));
    const error = await typesafeApi(KEY, fetch).listModels().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypesafeApiError);
    expect(error).toMatchObject({ status, code, httpStatus, retryable });
    const rendered = `${(error as Error).message} ${JSON.stringify(error)}`;
    expect(rendered).not.toContain(KEY);
    expect(rendered).not.toContain("private-state");
  });

  it("does not retry a rate-limited request", async () => {
    const { mock, fetch } = fetcherFor(() => json({}, 429));
    await typesafeApi(KEY, fetch).listModels().catch(() => null);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unknown answer shape", () => json({ model: "jev-1.13.0", answers: { q: { type: "essay", text: "private-state" } }, usage: {} })],
    ["a body that is not JSON", () => new Response("<html>private-state</html>", { status: 200 })],
  ])("reports %s as an invalid provider response", async (_name, respond) => {
    const { fetch } = fetcherFor(respond);
    const error = await typesafeApi(KEY, fetch)
      .evaluate({ state: "s", model: "jev-latest", questions: {} })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypesafeApiError);
    expect(error).toMatchObject({ code: "typesafe_invalid_response", httpStatus: 502, retryable: false });
    expect(`${(error as Error).message} ${JSON.stringify(error)}`).not.toContain("private-state");
  });
});
