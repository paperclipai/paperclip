import { describe, expect, it } from "vitest";
import type { AdapterRuntimeMcpServer } from "./types.js";
import {
  narrowRuntimeMcpServers,
  deriveRuntimeToolTelemetry,
  captureRuntimeFirstModelTokenTelemetry,
  selectRuntimePromptSections,
  evaluateRuntimeContextBudget,
} from "./context-economy-wiring.js";

function server(name: string): AdapterRuntimeMcpServer {
  return { name, url: `https://mcp/${name}`, token: "t", connectionId: `c-${name}` };
}

describe("context-economy-wiring", () => {
  it("regression: non-UI Engineer run keeps only Git, drops Cloudflare/Playwright/Storybook", () => {
    const candidates = [
      server("github"),
      server("cloudflare"),
      server("playwright"),
      server("storybook"),
    ];
    const result = narrowRuntimeMcpServers(candidates, {
      role: "engineer",
      taskCategory: "technical",
    });
    expect(result.servers.map((s) => s.name)).toEqual(["github"]);
    expect(result.droppedUnauthorized.sort()).toEqual([
      "cloudflare",
      "playwright",
      "storybook",
    ]);
  });

  it("legacy call site without role injects all servers unchanged", () => {
    const candidates = [server("github"), server("cloudflare"), server("playwright")];
    const result = narrowRuntimeMcpServers(candidates);
    expect(result.servers.map((s) => s.name)).toEqual([
      "github",
      "cloudflare",
      "playwright",
    ]);
    expect(result.droppedUnauthorized).toEqual([]);
  });

  it("UI category widens the Engineer set to include shadcn/storybook/playwright", () => {
    const candidates = [
      server("github"),
      server("cloudflare"),
      server("shadcn"),
      server("storybook"),
      server("playwright"),
    ];
    const result = narrowRuntimeMcpServers(candidates, {
      role: "engineer",
      taskCategory: "ui",
    });
    expect(result.servers.map((s) => s.name).sort()).toEqual([
      "github",
      "playwright",
      "shadcn",
      "storybook",
    ]);
    expect(result.droppedUnauthorized).toEqual(["cloudflare"]);
  });

  it("derives non-null tool-schema telemetry from managed servers", () => {
    const telemetry = deriveRuntimeToolTelemetry([server("github"), server("cloudflare")]);
    expect(telemetry.registeredToolCount).toBe(2);
    expect(telemetry.toolsBySource).toEqual({ managed: 2 });
    expect(telemetry.duplicateToolNames).toEqual([]);
    expect(telemetry.serializedToolSchemaChars).toBe(0);
    expect(telemetry.measurementKind).toBe("derived");
  });

  it("captures first-model tokens from usage and keeps null+reason when absent", () => {
    const measured = captureRuntimeFirstModelTokenTelemetry({
      usage: { inputTokens: 14823, outputTokens: 500, cachedInputTokens: 17580 },
    });
    expect(measured.firstModelInputTokens).toBe(14823);
    expect(measured.firstModelCachedInputTokens).toBe(17580);
    expect(measured.measured).toBe(true);

    const unmeasured = captureRuntimeFirstModelTokenTelemetry({ usage: null });
    expect(unmeasured.firstModelInputTokens).toBeNull();
    expect(unmeasured.firstModelCachedInputTokens).toBeNull();
    expect(unmeasured.measured).toBe(false);
    expect(unmeasured.reason).toMatch(/did not report/i);
  });

  it("gates Paperclip-controlled prompt sections by category", () => {
    const technical = selectRuntimePromptSections({ role: "engineer", taskCategory: "technical" });
    expect(technical.instructionSections).not.toContain("product-ui-api-branding");
    const ui = selectRuntimePromptSections({ role: "engineer", taskCategory: "ui" });
    expect(ui.instructionSections).toContain("product-ui-api-branding");
  });

  it("enforces hard context ceiling before unbounded replay", () => {
    const breach = evaluateRuntimeContextBudget({
      tier: "normal",
      turns: 1,
      firstModelInputTokens: 950_000,
    });
    expect(breach.compact).toBe(true);
    expect(breach.byHardCeiling).toBe(true);

    const within = evaluateRuntimeContextBudget({
      tier: "normal",
      turns: 1,
      firstModelInputTokens: 12000,
    });
    expect(within.compact).toBe(false);

    const turnBudget = evaluateRuntimeContextBudget({
      tier: "normal",
      turns: 4,
      promptChars: 50_000,
    });
    expect(turnBudget.compact).toBe(true);
    expect(turnBudget.byHardCeiling).toBe(false);
  });
});
