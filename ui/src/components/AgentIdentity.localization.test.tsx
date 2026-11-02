// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { AgentIdentity } from "./AgentIdentity";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentIdentity locale boundaries", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
  });

  it("translates missing-name and image-failure fallbacks while preserving an agent named Agent", async () => {
    await act(async () => root.render(<><AgentIdentity agent={{ id: "named", name: "Agent" }} /><AgentIdentity agent={{ id: "unnamed" }} /></>));
    expect(container.textContent).toBe("AgentAgent");
    await act(async () => {
      for (const img of container.querySelectorAll("img")) img.dispatchEvent(new Event("error"));
    });
    expect(container.textContent).toBe("AGAgentAGAgent");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toBe("AGAgentАГАгент");
    expect(container.querySelector('[title="Agent"]')).not.toBeNull();
  });
});
