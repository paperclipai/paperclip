import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { companyPortabilityService } from "./company-portability.js";

// The master fallback in resolveSource must fire when the ref is genuinely
// absent (raw.githubusercontent answers 404) and must NOT fire when the request
// failed for a transport reason — a timeout, an oversized body, an unreachable
// host. Retrying a different ref cannot fix those, and doing so both hides the
// original cause and doubles the work a wedged host can extract.

const SOURCE = {
  type: "github" as const,
  url: "https://github.com/acme/company-package/tree/main/pkg",
};

const TARGET = { mode: "new_company" as const, newCompanyName: "Acme" };

const COMPANY_MD = "---\nname: Acme\n---\n\n# Acme\n";

const originalFetch = globalThis.fetch;

function textResponse(body: string) {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}

function notFound() {
  return new Response("404: Not Found", { status: 404 });
}

let requested: string[];

beforeEach(() => {
  requested = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("resolveSource GitHub ref fallback", () => {
  it("falls back to master when the main ref is absent", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/main/")) return notFound();
      if (url.includes("/master/") && url.endsWith("COMPANY.md")) return textResponse(COMPANY_MD);
      // Everything else the manifest build asks for is optional.
      return notFound();
    }) as typeof fetch;

    const portability = companyPortabilityService({} as never);
    const preview = await portability.previewImport({ source: SOURCE, target: TARGET } as never);

    expect(preview.warnings).toContain("GitHub ref main not found; falling back to master.");
    expect(requested.some((url) => url.includes("/main/"))).toBe(true);
    expect(requested.some((url) => url.includes("/master/"))).toBe(true);
  });

  it("does not retry master when the main request fails for a transport reason", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      // Stands in for a timeout / unreachable host: ghFetch maps this to its 422.
      throw new Error("socket hang up");
    }) as typeof fetch;

    const portability = companyPortabilityService({} as never);

    await expect(
      portability.previewImport({ source: SOURCE, target: TARGET } as never),
    ).rejects.toThrow(/Could not connect to/);

    // The transport failure must surface as itself, not be relabelled a missing
    // ref and retried against master.
    expect(requested.every((url) => !url.includes("/master/"))).toBe(true);
  });
});
