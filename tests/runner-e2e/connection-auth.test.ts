import { describe, expect, it } from "vitest";
import { startReviewProvider } from "../fixtures/connection-review-provider.js";

describe("protected workflow service fixture", () => {
  it("does not return data to a direct caller without the service credential", async () => {
    const provider = await startReviewProvider(
      "private fixture pages",
      "test-only-service-key",
    );
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "notion:list_pages" },
    });
    try {
      const denied = await fetch(provider.url, { method: "POST", body });
      expect(denied.status).toBe(401);
      expect(await denied.text()).not.toContain("private fixture pages");
      const accepted = await fetch(provider.url, {
        method: "POST",
        body,
        headers: { authorization: "Bearer test-only-service-key" },
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toContain("private fixture pages");
      expect(provider.captures.map((call) => call.authorized)).toEqual([
        false,
        true,
      ]);
    } finally {
      await provider.close();
    }
  });
});
