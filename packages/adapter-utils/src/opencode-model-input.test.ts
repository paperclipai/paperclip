import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { advertisedModelImageInput, discoverModelImageInput, modelImageModalities } from "./opencode-model-input.js";

describe("model catalog image input", () => {
  it.each([true, false])("retains explicit advertised vision=%s", vision => {
    expect(advertisedModelImageInput({ data: [{ id: "model", capabilities: { vision } }] }, "model")).toBe(vision);
    expect(modelImageModalities(vision).modalities?.input.includes("image")).toBe(vision);
  });
  it("accepts input modalities and rejects missing, malformed, or ambiguous evidence", () => {
    expect(advertisedModelImageInput({ data: [{ id: "model", input_modalities: ["text", "image"] }] }, "model")).toBe(true);
    for (const catalog of [null, {}, { data: [] }, { data: [{ id: "other", capabilities: { vision: true } }] },
      { data: [{ id: "model", input_modalities: [] }] },
      { data: [{ id: "model", capabilities: { vision: "true" } }] },
      { data: [{ id: "model" }, { id: "model", capabilities: { vision: true } }] }]) {
      expect(advertisedModelImageInput(catalog, "model")).toBeUndefined();
    }
    expect(modelImageModalities(undefined)).toEqual({});
  });
  it.each(["redirect", "oversize", "invalid"])("bounds %s catalog discovery without failing the task", async failure => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url!);
      if (failure === "redirect") res.writeHead(302, { location: "/credential-trap" }).end();
      else res.writeHead(200).end(failure === "oversize" ? "x".repeat(2 * 1024 * 1024 + 1) : "invalid");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    try {
      expect(await discoverModelImageInput({ baseUrl: `http://127.0.0.1:${address.port}/v1`,
        credential: "test-key", model: "model", environment: {} })).toBeUndefined();
      expect(paths).toEqual(["/v1/models"]);
    } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  });
});
