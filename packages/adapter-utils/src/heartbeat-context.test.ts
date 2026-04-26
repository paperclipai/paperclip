import { describe, it, expect } from "vitest";
import { assembleHeartbeatInvocation } from "./heartbeat-context.js";

// ============================================================================
// assembleHeartbeatInvocation
// ============================================================================

describe("assembleHeartbeatInvocation", () => {
  it("returns empty prompt and no layers for empty input", () => {
    const result = assembleHeartbeatInvocation({});
    expect(result.prompt).toBe("");
    expect(result.heartbeatLayers).toEqual([]);
    expect(result.promptMetrics.promptChars).toBe(0);
  });

  it("assembles a single text fragment into the prompt", () => {
    const result = assembleHeartbeatInvocation({
      promptFragments: [
        { key: "ctx", title: "Context", text: "You are a helpful agent." },
      ],
    });
    expect(result.prompt).toBe("You are a helpful agent.");
  });

  it("joins multiple fragments with double newlines", () => {
    const result = assembleHeartbeatInvocation({
      promptFragments: [
        { key: "a", title: "A", text: "First." },
        { key: "b", title: "B", text: "Second." },
      ],
    });
    expect(result.prompt).toBe("First.\n\nSecond.");
  });

  it("trims whitespace from fragment text", () => {
    const result = assembleHeartbeatInvocation({
      promptFragments: [
        { key: "x", title: "X", text: "  trimmed  " },
      ],
    });
    expect(result.prompt).toBe("trimmed");
  });

  it("excludes fragments with null or undefined text from the prompt", () => {
    const result = assembleHeartbeatInvocation({
      promptFragments: [
        { key: "a", title: "A", text: "included" },
        { key: "b", title: "B", text: null },
      ],
    });
    expect(result.prompt).toBe("included");
  });

  it("marks included fragments in heartbeatLayers", () => {
    const result = assembleHeartbeatInvocation({
      promptFragments: [
        { key: "a", title: "A", text: "content" },
        { key: "b", title: "B", text: "" },
      ],
    });
    const layerA = result.heartbeatLayers.find((l) => l.key === "a");
    const layerB = result.heartbeatLayers.find((l) => l.key === "b");
    expect(layerA?.includedInPrompt).toBe(true);
    expect(layerB?.includedInPrompt).toBe(false);
  });

  it("records promptMetrics with promptChars", () => {
    const result = assembleHeartbeatInvocation({
      promptFragments: [{ key: "x", title: "X", text: "hello" }],
    });
    expect(result.promptMetrics.promptChars).toBe(5);
  });

  it("records a custom metricKey in promptMetrics", () => {
    const result = assembleHeartbeatInvocation({
      promptFragments: [
        { key: "x", title: "X", text: "12345", metricKey: "myMetric" },
      ],
    });
    expect(result.promptMetrics.myMetric).toBe(5);
  });

  it("ignores fragments with empty/blank metricKey", () => {
    const result = assembleHeartbeatInvocation({
      promptFragments: [
        { key: "x", title: "X", text: "abc", metricKey: "  " },
      ],
    });
    expect(result.promptMetrics["  "]).toBeUndefined();
  });

  it("adds adapter layers to heartbeatLayers with kind=adapter", () => {
    const result = assembleHeartbeatInvocation({
      adapterLayers: [
        { key: "adapter-ctx", title: "Adapter Context", chars: 100, includedInPrompt: true },
      ],
    });
    const layer = result.heartbeatLayers[0];
    expect(layer?.kind).toBe("adapter");
    expect(layer?.key).toBe("adapter-ctx");
    expect(layer?.chars).toBe(100);
  });

  it("uses the fragment summary if provided", () => {
    const result = assembleHeartbeatInvocation({
      promptFragments: [
        { key: "a", title: "A", text: "content", summary: "custom summary" },
      ],
    });
    const layer = result.heartbeatLayers.find((l) => l.key === "a");
    expect(layer?.summary).toBe("custom summary");
  });

  it("generates a default summary based on title and chars when no summary provided", () => {
    const result = assembleHeartbeatInvocation({
      promptFragments: [{ key: "a", title: "Instructions", text: "hello" }],
    });
    const layer = result.heartbeatLayers.find((l) => l.key === "a");
    expect(layer?.summary).toContain("Instructions");
    expect(layer?.summary).toContain("5 chars");
  });

  it("generates 'skipped' default summary for empty text", () => {
    const result = assembleHeartbeatInvocation({
      promptFragments: [{ key: "a", title: "Instructions", text: "" }],
    });
    const layer = result.heartbeatLayers.find((l) => l.key === "a");
    expect(layer?.summary).toContain("skipped");
  });

  it("propagates memoryClass from fragment to layer", () => {
    const result = assembleHeartbeatInvocation({
      promptFragments: [
        { key: "ep", title: "Episodic", text: "memory", memoryClass: "episodic" },
      ],
    });
    const layer = result.heartbeatLayers.find((l) => l.key === "ep");
    expect(layer?.memoryClass).toBe("episodic");
  });

  it("reads context layers from paperclipHeartbeatContext", () => {
    const result = assembleHeartbeatInvocation({
      context: {
        paperclipHeartbeatContext: {
          layers: [
            {
              key: "ctx-layer",
              title: "Ctx Layer",
              kind: "context",
              summary: "from context",
              chars: 0,
              includedInPrompt: false,
            },
          ],
        },
      },
    });
    const layer = result.heartbeatLayers.find((l) => l.key === "ctx-layer");
    expect(layer).toBeDefined();
    expect(layer?.title).toBe("Ctx Layer");
  });
});
