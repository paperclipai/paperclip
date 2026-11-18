import { expect, it } from "vitest";
import { runnerCodexDynamicToolsFit } from "../vendor/paperclip-runner/index.js";

function tools(count: number, description = "Read a fixture") {
  return Array.from({ length: count }, (_, i) => ({
    name: `fixture_${i}`, description, inputSchema: { type: "object" },
  }));
}

it("reserves run.prepare command space for provider instructions", () => {
  expect(runnerCodexDynamicToolsFit(tools(120, "x".repeat(2000)))).toBe(true);
  expect(runnerCodexDynamicToolsFit(tools(200, "x".repeat(2000)))).toBe(false);
});

it("preserves operation and UTF-8 catalog bounds", () => {
  expect(runnerCodexDynamicToolsFit(tools(254))).toBe(true);
  expect(runnerCodexDynamicToolsFit(tools(255))).toBe(false);
  expect(runnerCodexDynamicToolsFit(tools(200, "x".repeat(1000)))).toBe(true);
  expect(runnerCodexDynamicToolsFit(tools(200, "🙂".repeat(1000)))).toBe(false);
});
