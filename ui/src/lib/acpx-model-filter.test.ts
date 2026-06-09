import { describe, expect, it } from "vitest";
import { filterAcpxModelsByAgent } from "./acpx-model-filter";

const mixedModels = [
  { id: "claude-sonnet-4-6", label: "Claude: Claude Sonnet 4.6" },
  { id: "gpt-5.3-codex", label: "Codex: gpt-5.3-codex" },
  { id: "provider/custom-model", label: "Custom model" },
];

describe("filterAcpxModelsByAgent", () => {
  it("keeps only Claude models when ACPX Claude is selected", () => {
    expect(filterAcpxModelsByAgent(mixedModels, "claude").map((model) => model.id)).toEqual([
      "claude-sonnet-4-6",
    ]);
  });

  it("keeps only Codex models when ACPX Codex is selected", () => {
    expect(filterAcpxModelsByAgent(mixedModels, "codex").map((model) => model.id)).toEqual([
      "gpt-5.3-codex",
    ]);
  });

  it("does not show built-in provider models for custom ACP commands", () => {
    expect(filterAcpxModelsByAgent(mixedModels, "custom")).toEqual([]);
  });
});
