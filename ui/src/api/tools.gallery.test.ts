import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDefinition } from "@paperclipai/shared";
import { getAvailableConnectionMethod } from "@paperclipai/shared";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { normalizeGalleryApps, toolsApi } from "./tools";

/** A minimal well-formed gallery entry. */
function sampleApp(overrides: Partial<AppDefinition> = {}): AppDefinition {
  return {
    schemaVersion: 1,
    slug: "acme",
    name: "Acme",
    description: "An app",
    categories: ["developer"],
    branding: { logoUrl: "https://example.com/acme.png" },
    urlPatterns: ["https://acme.example.com/*"],
    methods: [
      {
        key: "acme-oauth",
        transport: "http",
        auth: "oauth",
        ownershipModes: ["customer"],
        whenToUse: "Use this",
        guidanceMd: "Guidance",
        riskTier: "S2",
      },
    ],
    ...overrides,
  } as AppDefinition;
}

describe("normalizeGalleryApps", () => {
  it("passes a well-formed gallery through unchanged", () => {
    const app = sampleApp();
    const out = normalizeGalleryApps({ apps: [app] });
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe("acme");
    expect(out[0].categories).toEqual(["developer"]);
  });

  it("returns [] for a non-object / missing-apps response", () => {
    expect(normalizeGalleryApps(null)).toEqual([]);
    expect(normalizeGalleryApps(undefined)).toEqual([]);
    expect(normalizeGalleryApps({})).toEqual([]);
    expect(normalizeGalleryApps({ apps: "nope" })).toEqual([]);
  });

  it("coerces a missing `categories` field to [] instead of crashing", () => {
    const legacy = { ...sampleApp() } as Record<string, unknown>;
    delete legacy.categories;
    const out = normalizeGalleryApps({ apps: [legacy] });
    expect(out).toHaveLength(1);
    expect(out[0].categories).toEqual([]);
    // The Browse iterations that crashed (:85/:102/:108) are now safe.
    expect(() => {
      for (const _c of out[0].categories) void _c;
      out[0].categories.includes("developer");
      out[0].categories.some((c) => c.includes("dev"));
    }).not.toThrow();
  });

  it("coerces a missing `branding` object so `branding.logoUrl` is safe", () => {
    const legacy = { ...sampleApp() } as Record<string, unknown>;
    delete legacy.branding;
    const out = normalizeGalleryApps({ apps: [legacy] });
    expect(out).toHaveLength(1);
    expect(() => out[0].branding.logoUrl).not.toThrow();
  });

  it("drops an entry with no usable methods (not connectable)", () => {
    const noMethods = { ...sampleApp({ slug: "b" }) } as Record<string, unknown>;
    delete noMethods.methods;
    const emptyMethods = sampleApp({ slug: "c", methods: [] });
    const out = normalizeGalleryApps({ apps: [noMethods, emptyMethods, sampleApp()] });
    expect(out.map((a) => a.slug)).toEqual(["acme"]);
  });

  it("keeps the good entries when only some are malformed (degrade, don't blank)", () => {
    const bad = { slug: "bad" }; // no name, no methods
    const out = normalizeGalleryApps({ apps: [bad, sampleApp()] });
    expect(out.map((a) => a.slug)).toEqual(["acme"]);
  });

  it("de-dupes by slug (first wins)", () => {
    const out = normalizeGalleryApps({
      apps: [sampleApp({ name: "First" }), sampleApp({ name: "Second" })],
    });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("First");
  });

  it("coerces a method's missing `ownershipModes` so getAvailableConnectionMethod is safe", () => {
    const app = sampleApp();
    const brokenMethod = { ...app.methods[0] } as Record<string, unknown>;
    delete brokenMethod.ownershipModes;
    const out = normalizeGalleryApps({ apps: [{ ...app, methods: [brokenMethod] }] });
    expect(out).toHaveLength(1);
    expect(out[0].methods[0].ownershipModes).toEqual([]);
    // The shared helper iterates method.ownershipModes — must not throw.
    expect(() => getAvailableConnectionMethod(out[0])).not.toThrow();
  });
});

describe("toolsApi.listGallery", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
  });

  it("normalizes the raw response before handing it to callers", async () => {
    const legacy = { ...sampleApp() } as Record<string, unknown>;
    delete legacy.categories;
    mockApi.get.mockResolvedValue({ apps: [legacy] });
    const res = await toolsApi.listGallery("company-1");
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/tools/gallery");
    expect(res.apps).toHaveLength(1);
    expect(res.apps[0].categories).toEqual([]);
  });

  it("survives a completely malformed response", async () => {
    mockApi.get.mockResolvedValue({ apps: null });
    const res = await toolsApi.listGallery("company-1");
    expect(res.apps).toEqual([]);
  });
});
