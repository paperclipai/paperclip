import { describe, it, expect, afterEach, vi } from "vitest";
import { buildServer } from "../src/server.js";
import type { Dpo } from "paperclip-dpo";

const KEY = "test-key-32-bytes-xxxxxxxxxxxxxxx";

describe("buildServer", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  afterEach(async () => app && (await app.close()));

  it("wires all routes", async () => {
    const dpo: Dpo = {
      anonymize: vi.fn().mockResolvedValue({ mappingId: "m", anonymizedText: "x", findings: [], warnings: [] }),
      deanonymize: vi.fn().mockReturnValue({ text: "x" }),
      close: vi.fn(),
    };
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    app = await buildServer({
      sharedKey: KEY,
      classifierUrl: "http://localhost:1234",
      dpo,
      fetchFn,
    });
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const anon = await app.inject({
      method: "POST", url: "/anonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { text: "x", targetLlm: "y", agent: "z" },
    });
    expect(anon.statusCode).toBe(200);
  });
});
