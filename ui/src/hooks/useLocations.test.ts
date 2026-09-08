import { describe, expect, it } from "vitest";
import { buildLocationsUrl, buildLocationUrl } from "./useLocations";

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
