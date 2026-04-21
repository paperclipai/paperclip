import { describe, it, expect } from "vitest";
import { detectUrls } from "../../src/detectors/url.js";

describe("detectUrls", () => {
  it("findet https-URL", () => {
    expect(detectUrls("Siehe https://whitestag.de/about")).toHaveLength(1);
  });

  it("findet http-URL", () => {
    expect(detectUrls("Server: http://localhost:1234/v1")).toHaveLength(1);
  });

  it("ignoriert reinen Text ohne Protokoll", () => {
    expect(detectUrls("whitestag.de ohne protokoll")).toEqual([]);
  });
});
