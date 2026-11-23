// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSetupPrompt } from "./AgentSetupPrompt";
import { isBlockedFromReplay } from "@/lib/analytics/replay-recording.test-utils";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
});

it("blocks the setup prompt preview, which carries pairing tokens, from session replay", async () => {
  const prompt = "Run: paperclipai pair --token pcp_pair_8f3kQz2LmWv";
  await act(async () => root.render(<AgentSetupPrompt prompt={prompt} />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(document.querySelector("pre[aria-label='Setup prompt']")).not.toBeNull();
  expect(isBlockedFromReplay("pcp_pair_8f3kQz2LmWv", document.body)).toBe(true);
});
