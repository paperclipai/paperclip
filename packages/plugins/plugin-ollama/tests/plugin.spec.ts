import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { resolveLicense, listKnownFamilies } from "../src/licenses.js";

const originalFetch = globalThis.fetch;

function stubFetch(): void {
  const fake = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/tags")) {
      return new Response(
        JSON.stringify({
          models: [
            { name: "llama3.1:8b", size: 4_700_000_000, details: { family: "llama" } },
            { name: "qwen2.5:7b", size: 4_100_000_000, details: { family: "qwen2" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
  globalThis.fetch = fake as unknown as typeof fetch;
}

describe("plugin-ollama", () => {
  beforeEach(() => {
    stubFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers data + actions against a stubbed /api/tags response", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: { baseUrl: "http://127.0.0.1:11434" },
    });
    await plugin.definition.setup(harness.ctx);

    const health = await harness.getData<{ status: string; modelCount: number }>("health");
    expect(health.status).toBe("ok");
    expect(health.modelCount).toBe(2);

    const models = await harness.getData<Array<{ name: string; licenseKnown: boolean }>>("models");
    expect(models).toHaveLength(2);
    expect(models.every((m) => m.licenseKnown)).toBe(true);

    const testResult = await harness.performAction<{ ok: boolean; modelCount: number }>(
      "test-connection",
    );
    expect(testResult.ok).toBe(true);
    expect(testResult.modelCount).toBe(2);
  });

  it("persists license acknowledgements and gates check-model correctly", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: { baseUrl: "http://127.0.0.1:11434" },
    });
    await plugin.definition.setup(harness.ctx);

    let check = await harness.performAction<{ blocked: boolean; reason: string | null }>(
      "check-model",
      { model: "llama3.1:8b" },
    );
    expect(check.blocked).toBe(true);
    expect(check.reason).toBe("license-not-acknowledged");

    const ack = await harness.performAction<{ ok: boolean; acknowledged: string[] }>(
      "acknowledge-license",
      { family: "llama3.1" },
    );
    expect(ack.ok).toBe(true);
    expect(ack.acknowledged).toContain("llama3.1");

    check = await harness.performAction<{ blocked: boolean; reason: string | null }>(
      "check-model",
      { model: "llama3.1:8b" },
    );
    expect(check.blocked).toBe(false);

    const unknown = await harness.performAction<{ blocked: boolean; reason: string | null }>(
      "check-model",
      { model: "definitely-not-real:1b" },
    );
    expect(unknown.blocked).toBe(true);
    expect(unknown.reason).toBe("unknown-license");

    const models = await harness.getData<Array<{ name: string; blocked: boolean }>>("models");
    const llama = models.find((m) => m.name === "llama3.1:8b");
    const qwen = models.find((m) => m.name === "qwen2.5:7b");
    expect(llama?.blocked).toBe(false);
    expect(qwen?.blocked).toBe(true);

    await harness.performAction("revoke-license", { family: "llama3.1" });
    const reblocked = await harness.performAction<{ blocked: boolean }>(
      "check-model",
      { model: "llama3.1:8b" },
    );
    expect(reblocked.blocked).toBe(true);
  });

  it("accumulates ollama cost events and computes equivalent hosted cost", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
      config: {
        baseUrl: "http://127.0.0.1:11434",
        referenceHostedModel: "gpt-4o-mini",
        referenceInputCostPerMTok: 0.15,
        referenceOutputCostPerMTok: 0.6,
      },
    });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "cost_event.created",
      {
        provider: "ollama",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        occurredAt: "2026-04-19T12:00:00.000Z",
      },
      { entityType: "cost" },
    );
    await harness.emit(
      "cost_event.created",
      { provider: "anthropic", inputTokens: 10_000, outputTokens: 1_000 },
      { entityType: "cost" },
    );

    const usage = await harness.getData<{
      inputTokens: number;
      outputTokens: number;
      events: number;
      equivalentCostUsd: number;
      referenceModel: string;
    }>("usage-summary");
    expect(usage.inputTokens).toBe(1_000_000);
    expect(usage.outputTokens).toBe(500_000);
    expect(usage.events).toBe(1);
    expect(usage.equivalentCostUsd).toBeCloseTo(0.15 + 0.3, 6);
    expect(usage.referenceModel).toBe("gpt-4o-mini");

    await harness.performAction("reset-usage");
    const cleared = await harness.getData<{ events: number; equivalentCostUsd: number }>(
      "usage-summary",
    );
    expect(cleared.events).toBe(0);
    expect(cleared.equivalentCostUsd).toBe(0);
  });

  it("rejects acknowledging a license outside the static matrix", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: { baseUrl: "http://127.0.0.1:11434" },
    });
    await plugin.definition.setup(harness.ctx);

    await expect(
      harness.performAction("acknowledge-license", { family: "something-obscure" }),
    ).rejects.toThrow(/not in the known license matrix/);
  });

  it("resolves known model licenses", () => {
    expect(resolveLicense("llama3.1:8b")?.license).toContain("Llama 3.1");
    expect(resolveLicense("qwen2.5:7b")?.license).toContain("Apache");
    expect(resolveLicense("unknown-model")).toBeNull();
    expect(listKnownFamilies()).toContain("llama3.1");
  });
});
