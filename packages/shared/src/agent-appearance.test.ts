import { describe, expect, it } from "vitest";
import { AGENT_PALETTE_IDS, agentAppearanceSchema, appearanceForPalette, legacyAgentAppearance, randomAgentAppearance, resolveAgentAppearance, agentAvatarUrl } from "./agent-appearance.js";
import { renderAgentSvg } from "./cliplab/static.js";

describe("agent appearance", () => {
  it("assigns only the 17 permanent cap palettes", () => {
    for (let i = 0; i < 100; i++) expect(AGENT_PALETTE_IDS).toContain(randomAgentAppearance().paletteId);
    expect(agentAppearanceSchema.safeParse({ schemaVersion: 1, characterVersion: "cap-v1", paletteId: "muted-dream" }).success).toBe(false);
  });
  it("preserves a saved appearance and resolves legacy IDs deterministically", () => {
    const appearance = appearanceForPalette("deep-tide");
    expect(resolveAgentAppearance(appearance, "different-id")).toEqual(appearance);
    expect(resolveAgentAppearance(null, "agent-1")).toEqual(legacyAgentAppearance("agent-1"));
    expect(legacyAgentAppearance("agent-1")).toEqual(legacyAgentAppearance("agent-1"));
    expect(agentAvatarUrl(appearance, 24, 2)).toBe("/api/agent-avatars/cap-v1/deep-tide/rest.png?size=24&scale=2");
  });
  it("accepts an uploaded asset image and rejects remote or off-route values", () => {
    const base = appearanceForPalette("deep-tide");
    const parse = (image: string) => agentAppearanceSchema.safeParse({ ...base, image }).success;
    expect(parse("/api/assets/0f9c2c1e-5c1d-4a43-9c5e-1b2a3c4d5e6f/content")).toBe(true);
    // An agent may set its own appearance, so a remote host here would make
    // every viewer of an agent surface beacon to a host the agent chose.
    expect(parse("https://example.com/agent.png")).toBe(false);
    expect(parse("http://example.com/agent.png")).toBe(false);
    expect(parse("//example.com/agent.png")).toBe(false);
    expect(parse("javascript:alert(1)")).toBe(false);
    expect(parse("/api/agents/1")).toBe(false);
    expect(resolveAgentAppearance(base, "agent-1")).not.toHaveProperty("image");
    // A persisted remote URL degrades to the palette instead of rendering.
    expect(resolveAgentAppearance({ ...base, image: "https://example.com/a.png" }, "agent-1"))
      .toEqual(legacyAgentAppearance("agent-1"));
  });
  it("renders without a browser and preserves logical-size detail at high density", () => {
    const appearance = appearanceForPalette("bubblegum-sky");
    // ClipLab v0.2.0 draws an enlarged compact face from 16px; only 12px and
    // below (not a logical size) is body-only.
    const small = renderAgentSvg(appearance, 16, 2);
    expect(small).toContain('width="32"');
    expect(small).toContain('id="agent-face-visible"');
    const eyes = renderAgentSvg(appearance, 24, 2);
    expect(eyes).toContain('width="48"');
    expect(eyes).toContain('id="agent-face-visible"');
    expect(eyes).not.toContain('id="agent-candle-light"');
    expect(renderAgentSvg(appearance, 48, 1)).toContain('id="agent-candle-light"');
    expect(renderAgentSvg(appearance, 24, 2)).toBe(eyes);
  });
});
