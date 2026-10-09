// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { appearanceForPalette } from "@paperclipai/shared";
import { AgentAvatar } from "./AgentAvatar";
import { AgentCharacter } from "./AgentCharacter";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("shows the uploaded image in small and animated-character surfaces, then returns to the palette on reset", async () => {
  const base = appearanceForPalette("deep-tide");
  const appearance = { ...base, customAvatarAssetId: "22222222-2222-4222-8222-222222222222" };
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<><AgentAvatar appearance={appearance} /><AgentCharacter appearance={appearance} /></>));
    for (const image of container.querySelectorAll("img")) {
      expect(image.getAttribute("src")).toBe("/api/assets/22222222-2222-4222-8222-222222222222/content");
      expect(image.hasAttribute("srcset")).toBe(false);
      expect(image.parentElement?.classList.contains("invisible")).toBe(false);
    }
    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect(container.querySelector("canvas")).toBeNull();
    await act(async () => root.render(<AgentAvatar appearance={base} />));
    expect(container.querySelector("img")?.getAttribute("src")).toContain("/api/agent-avatars/cap-v1/deep-tide/");
  } finally { await act(async () => root.unmount()); }
});
