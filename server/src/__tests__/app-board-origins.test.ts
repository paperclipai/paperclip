import { describe, expect, it } from "vitest";
import { buildAllowedBoardOrigins } from "../middleware/board-mutation-guard.js";

describe("buildAllowedBoardOrigins", () => {
  it("includes configured hostnames with and without the active server port", () => {
    const origins = buildAllowedBoardOrigins({
      authPublicBaseUrl: "https://paperclip.example.com",
      allowedHostnames: ["dotta-macbook-pro", "tailscale.internal "],
      serverPort: 3100,
    });

    expect(origins).toContain("https://paperclip.example.com");
    expect(origins).toContain("http://dotta-macbook-pro");
    expect(origins).toContain("https://dotta-macbook-pro");
    expect(origins).toContain("http://dotta-macbook-pro:3100");
    expect(origins).toContain("https://dotta-macbook-pro:3100");
    expect(origins).toContain("http://tailscale.internal:3100");
    expect(origins).toContain("https://tailscale.internal:3100");
  });

  it("deduplicates repeated origins", () => {
    const origins = buildAllowedBoardOrigins({
      authPublicBaseUrl: "http://localhost:3100",
      allowedHostnames: ["localhost"],
      serverPort: 3100,
    });

    expect(new Set(origins).size).toBe(origins.length);
  });
});
