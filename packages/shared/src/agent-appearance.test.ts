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
  it("renders without a browser and preserves logical-size detail at high density", () => {
    const appearance = appearanceForPalette("bubblegum-sky");
    const small = renderAgentSvg(appearance, 16, 2);
    expect(small).toContain('width="32"');
    expect(small).not.toContain('id="agent-face-visible"');
    const eyes = renderAgentSvg(appearance, 24, 2);
    expect(eyes).toContain('width="48"');
    expect(eyes).toContain('id="agent-face-visible"');
    expect(eyes).not.toContain('id="agent-candle-light"');
    expect(renderAgentSvg(appearance, 48, 1)).toContain('id="agent-candle-light"');
    expect(renderAgentSvg(appearance, 24, 2)).toBe(eyes);
  });
});
