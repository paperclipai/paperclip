import { Agent, createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { discoverModelImageInput } from "./model-input.js";

describe("standalone runner model catalog", () => {
  it.each([
    [200, { data: [{ id: "alias", input_modalities: ["text", "image"] }] }, true],
    [200, { data: [{ id: "alias", capabilities: { vision: false } }] }, false],
    [200, { data: [{ id: "other", capabilities: { vision: true } }] }, undefined],
    [200, { data: [{ id: "alias" }, { id: "alias" }] }, undefined],
    [200, "invalid", undefined],
    [200, "x".repeat(2 * 1024 * 1024 + 1), undefined],
    [302, { data: [{ id: "alias", capabilities: { vision: true } }] }, undefined],
  ] as const)("treats catalog case %# as explicit support or unknown", async (status, body, expected) => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url!);
      res.writeHead(status, { location: "/credential-trap" }).end(typeof body === "string" ? body : JSON.stringify(body));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    const agent = new Agent();
    try {
      expect(await discoverModelImageInput(new URL(`http://127.0.0.1:${address.port}/v1/models`), "key", "alias", agent)).toBe(expected);
      expect(paths).toEqual(["/v1/models"]);
    } finally {
      agent.destroy();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  });
});
