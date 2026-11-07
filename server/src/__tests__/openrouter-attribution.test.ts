import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AiProviderRouting } from "@paperclipai/shared";
import { OPENROUTER_ATTRIBUTION_HEADERS } from "@paperclipai/shared/openrouter-attribution";
import { managedProviderRouting } from "../services/ai-provider-routing.js";

describe("Paperclip OpenRouter connection attribution", () => {
  it("keeps the standalone Runner policy identical to the control-plane policy", async () => {
    const shared = await readFile(new URL("../../../packages/shared/src/openrouter-attribution.ts", import.meta.url), "utf8");
    const runner = await readFile(new URL("../../../packages/paperclip-runner/src/drivers/openrouter-attribution.ts", import.meta.url), "utf8");
    expect(runner.slice(runner.indexOf("/**"))).toBe(shared);
  });
  it.each(["codex_local", "claude_local", "opencode_local", "hermes_local"])("attributes managed and custom OpenRouter connections for %s", harness => {
    for (const route of [
      { kind: "openrouter", protocol: "chat", auth: "bearer", models: [] },
      { kind: "gateway", protocol: "chat", auth: "bearer", models: [], baseUrl: "https://openrouter.ai/api/v1" },
      { kind: "gateway", protocol: "chat", auth: "bearer", models: [], baseUrl: "https://eu.openrouter.ai/api/v1" },
      { kind: "gateway", protocol: "chat", auth: "bearer", models: [], baseUrl: "https://us.openrouter.ai/api/v1" },
    ] satisfies AiProviderRouting[]) {
      const result = managedProviderRouting(route, harness, "fixture-key", "vendor/model");
      const output = JSON.stringify(result);
      for (const value of Object.values(OPENROUTER_ATTRIBUTION_HEADERS)) expect(output).toContain(value);
    }
  });
  it.each(["codex_local", "claude_local", "opencode_local", "hermes_local"])("does not add attribution to unrelated %s endpoints", harness => {
    const result = managedProviderRouting({ kind: "gateway", protocol: "chat", auth: "bearer", models: [], baseUrl: "https://gateway.example/v1" }, harness, "fixture-key", "model");
    expect(JSON.stringify(result)).not.toMatch(/HTTP-Referer|X-Title|X-OpenRouter/);
  });
});
