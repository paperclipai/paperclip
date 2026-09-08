import { describe, expect, it } from "vitest";
import { buildLocationsUrl, buildLocationUrl, buildLocationReadingsUrl } from "./useLocations";

describe("buildLocationsUrl", () => {
  it("encodes companyId into query string", () => {
    const url = buildLocationsUrl("abc-123");
    expect(url).toBe("/api/health/locations?companyId=abc-123");
  });

  it("percent-encodes special characters in companyId", () => {
    const url = buildLocationsUrl("id with spaces");
    expect(url).toContain("id%20with%20spaces");
  });
});

describe("buildLocationUrl", () => {
  it("interpolates the location id into the path", () => {
    const url = buildLocationUrl("loc-456");
    expect(url).toBe("/api/health/locations/loc-456");
  });

  it("percent-encodes special characters in id", () => {
    const url = buildLocationUrl("id/with/slashes");
    expect(url).toBe("/api/health/locations/id%2Fwith%2Fslashes");
  });
});

describe("buildLocationReadingsUrl", () => {
  it("builds the base readings URL with companyId", () => {
    const url = buildLocationReadingsUrl("loc-1", "company-1");
    expect(url).toBe("/api/health/locations/loc-1/readings?companyId=company-1");
  });

  it("appends from and to query params when provided", () => {
    const url = buildLocationReadingsUrl("loc-1", "company-1", {
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-08T00:00:00.000Z",
    });
    expect(url).toContain("from=2026-09-01");
    expect(url).toContain("to=2026-09-08");
  });

  it("appends limit when provided", () => {
    const url = buildLocationReadingsUrl("loc-1", "company-1", { limit: 50 });
    expect(url).toContain("limit=50");
  });

  it("percent-encodes location id in the path", () => {
    const url = buildLocationReadingsUrl("id/with/slashes", "company-1");
    expect(url).toContain("id%2Fwith%2Fslashes");
  });

  it("omits optional params when not provided", () => {
    const url = buildLocationReadingsUrl("loc-1", "company-1");
    expect(url).not.toContain("from=");
    expect(url).not.toContain("to=");
    expect(url).not.toContain("limit=");
  });
});
