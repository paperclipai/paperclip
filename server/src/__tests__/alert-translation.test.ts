import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after stubbing globals
const { translateAlertBody, translateAlertForAllLocales, SUPPORTED_LOCALES } =
  await import("../services/alert-translation.js");

function mockAnthropicSuccess(translatedText: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      content: [{ type: "text", text: translatedText }],
    }),
  });
}

function mockAnthropicError(status = 500, body = "Internal Server Error") {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => body,
  });
}

describe("SUPPORTED_LOCALES", () => {
  it("exports es, zh-Hans, tl", () => {
    expect(SUPPORTED_LOCALES).toEqual(["es", "zh-Hans", "tl"]);
  });
});

describe("translateAlertBody", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null for unsupported locale", async () => {
    const result = await translateAlertBody("alert-1", "Fire alert", "fr");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null for English locale (not in supported list)", async () => {
    const result = await translateAlertBody("alert-2", "Fire alert", "en");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls Anthropic API and returns translated text for Spanish", async () => {
    mockAnthropicSuccess("Alerta de incendio");
    const result = await translateAlertBody("alert-3", "Fire alert", "es");
    expect(result).toBe("Alerta de incendio");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.messages[0].content).toContain("Fire alert");
    expect(body.messages[0].content).toContain("Spanish");
  });

  it("calls Anthropic API for Mandarin", async () => {
    mockAnthropicSuccess("火灾警报");
    const result = await translateAlertBody("alert-4", "Fire alert", "zh-Hans");
    expect(result).toBe("火灾警报");
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toContain("Simplified Mandarin");
  });

  it("calls Anthropic API for Tagalog", async () => {
    mockAnthropicSuccess("Babala sa sunog");
    const result = await translateAlertBody("alert-5", "Fire alert", "tl");
    expect(result).toBe("Babala sa sunog");
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toContain("Tagalog");
  });

  it("returns cached result on second call without hitting API", async () => {
    mockAnthropicSuccess("Alerta de incendio");
    const first = await translateAlertBody("alert-cache-1", "Fire alert", "es");
    const second = await translateAlertBody("alert-cache-1", "Fire alert", "es");
    expect(first).toBe("Alerta de incendio");
    expect(second).toBe("Alerta de incendio");
    // API should only be called once
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("calls API again for different alert IDs (no cross-alert cache pollution)", async () => {
    mockAnthropicSuccess("Alerta uno");
    mockAnthropicSuccess("Alerta dos");
    const first = await translateAlertBody("alert-x1", "Alert one", "es");
    const second = await translateAlertBody("alert-x2", "Alert two", "es");
    expect(first).toBe("Alerta uno");
    expect(second).toBe("Alerta dos");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("calls API again for different locales on the same alert", async () => {
    mockAnthropicSuccess("Alerta de incendio");
    mockAnthropicSuccess("火灾警报");
    const es = await translateAlertBody("alert-multi-1", "Fire alert", "es");
    const zh = await translateAlertBody("alert-multi-1", "Fire alert", "zh-Hans");
    expect(es).toBe("Alerta de incendio");
    expect(zh).toBe("火灾警报");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws when API key is not configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(
      translateAlertBody("alert-no-key", "Fire alert", "es"),
    ).rejects.toThrow("ANTHROPIC_API_KEY not configured");
  });

  it("throws on non-ok Anthropic response", async () => {
    mockAnthropicError(429, "Rate limited");
    await expect(
      translateAlertBody("alert-err-1", "Fire alert", "es"),
    ).rejects.toThrow("Anthropic API error 429");
  });

  it("throws when response has no text content block", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: "image" }] }),
    });
    await expect(
      translateAlertBody("alert-no-text", "Fire alert", "es"),
    ).rejects.toThrow("No text content in Anthropic response");
  });

  it("passes Authorization header with API key", async () => {
    mockAnthropicSuccess("Translated");
    await translateAlertBody("alert-auth-1", "Fire alert", "es");
    const opts = (mockFetch.mock.calls[0] as [string, RequestInit])[1];
    const headers = opts.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
  });
});

describe("translateAlertForAllLocales", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("translates to all three locales", async () => {
    mockAnthropicSuccess("Alerta de incendio");
    mockAnthropicSuccess("火灾警报");
    mockAnthropicSuccess("Babala sa sunog");
    const result = await translateAlertForAllLocales(
      "alert-all-1",
      "Fire alert",
      ["es", "zh-Hans", "tl"],
    );
    expect(result).toEqual({
      es: "Alerta de incendio",
      "zh-Hans": "火灾警报",
      tl: "Babala sa sunog",
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("returns partial results when one locale fails", async () => {
    mockAnthropicSuccess("Alerta de incendio");
    mockAnthropicError(500);
    mockAnthropicSuccess("Babala sa sunog");
    const result = await translateAlertForAllLocales(
      "alert-partial-1",
      "Fire alert",
      ["es", "zh-Hans", "tl"],
    );
    // zh-Hans failed — should be absent, not null/undefined
    expect(result).toHaveProperty("es", "Alerta de incendio");
    expect(result).toHaveProperty("tl", "Babala sa sunog");
    expect(result).not.toHaveProperty("zh-Hans");
  });

  it("returns empty object when all locales fail", async () => {
    mockAnthropicError(500);
    mockAnthropicError(500);
    mockAnthropicError(500);
    const result = await translateAlertForAllLocales(
      "alert-fail-all",
      "Fire alert",
      ["es", "zh-Hans", "tl"],
    );
    expect(result).toEqual({});
  });

  it("returns empty object for empty locales array", async () => {
    const result = await translateAlertForAllLocales("alert-empty", "Fire alert", []);
    expect(result).toEqual({});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("translates to a single requested locale", async () => {
    mockAnthropicSuccess("Alerta de incendio");
    const result = await translateAlertForAllLocales("alert-single", "Fire alert", ["es"]);
    expect(result).toEqual({ es: "Alerta de incendio" });
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
