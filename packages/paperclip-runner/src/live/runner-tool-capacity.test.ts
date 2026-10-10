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
