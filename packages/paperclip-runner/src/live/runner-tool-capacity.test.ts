import { expect, it } from "vitest";
import { runnerCodexDynamicToolsFit } from "./runnerd-codex-transport.js";

function tools(count: number, description = "Read a fixture") {
  return Array.from({ length: count }, (_, i) => ({
    name: `fixture_${i}`, description, inputSchema: { type: "object" },
  }));
}

it("reserves completion tools at the runner's operation boundary", () => {
  expect(runnerCodexDynamicToolsFit(tools(254))).toBe(true);
  expect(runnerCodexDynamicToolsFit(tools(255))).toBe(false);
});

it("accounts for UTF-8 catalog bytes even below the operation limit", () => {
  expect(runnerCodexDynamicToolsFit(tools(200, "x".repeat(1000)))).toBe(true);
  expect(runnerCodexDynamicToolsFit(tools(200, "🙂".repeat(1000)))).toBe(false);
});

it("rejects a catalog that exceeds the canonical JSON node limit", () => {
  const properties = Object.fromEntries(Array.from({ length: 5_200 }, (_, i) => [`field_${i}`, { type: "string" }]));
  const catalog = [{ name: "fixture", description: "Read a fixture", inputSchema: { type: "object", properties } }];
  expect(Buffer.byteLength(JSON.stringify(catalog))).toBeLessThan(768 * 1024);
  expect(runnerCodexDynamicToolsFit(catalog)).toBe(false);
});

it("preserves invalid catalog errors", () => {
  const schema: Record<string, unknown> = {};
  schema.self = schema;
  expect(() => runnerCodexDynamicToolsFit([{ name: "fixture", inputSchema: schema }]))
    .toThrow("durable_prp_canonical_json_invalid");
});
