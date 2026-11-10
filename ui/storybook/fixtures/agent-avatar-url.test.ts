import { describe, expect, it } from "vitest";
import { AGENT_AVATAR_SIZES, AGENT_PALETTE_IDS, CHARACTER_STATES, appearanceForPalette } from "@paperclipai/shared";
import { agentAvatarUrl as productionUrl } from "../../src/lib/agent-avatar-url";
import { agentAvatarUrl } from "./agent-avatar-url";

describe("packaged Storybook avatar URLs", () => {
  it("keeps production on the public API and resolves preview assets under a branch prefix", () => {
    const appearance = appearanceForPalette("bubblegum-sky");
    expect(productionUrl(appearance, 24, 2)).toBe("/api/agent-avatars/cap-v1/bubblegum-sky/rest.png?size=24&scale=2");
    expect(new URL(agentAvatarUrl(appearance, 24, 2), "https://example.com/branches/personas/builds/123/iframe.html").href)
      .toBe("https://example.com/branches/personas/builds/123/agent-avatar-images/cap-v1/bubblegum-sky/rest-24-2.png");
    expect(agentAvatarUrl(appearance)).toBe("./agent-avatar-images/cap-v1/bubblegum-sky/rest-512-1.png");
  });

  it("gives every finite preset a distinct filename, retaining logical size separately from density", () => {
    const paths = new Set<string>();
    for (const palette of AGENT_PALETTE_IDS) for (const pose of CHARACTER_STATES)
      for (const size of AGENT_AVATAR_SIZES) for (const scale of [1, 2] as const) {
        paths.add(agentAvatarUrl(appearanceForPalette(palette), size, scale, pose));
        paths.add(agentAvatarUrl(appearanceForPalette(palette), size, scale, pose, true));
      }
    expect(paths.size).toBe((AGENT_PALETTE_IDS.length + 1) * CHARACTER_STATES.length * AGENT_AVATAR_SIZES.length * 2);
    expect(agentAvatarUrl(appearanceForPalette("arctic-blue"), 24, 2))
      .not.toBe(agentAvatarUrl(appearanceForPalette("arctic-blue"), 48, 1));
    expect([...paths].every(path => !path.includes("?") && path.startsWith("./agent-avatar-images/cap-v1/"))).toBe(true);
  });
});
