// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatConnectionPurpose } from "./ChatEndpointSetup";

vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("@/components/chat/ChatSetupNavigation", () => ({ ChatSetupNavigation: () => null }));
vi.mock("@/components/AgentAvatar", () => ({ AgentAvatar: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(onClose?: () => void) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ChatConnectionPurpose provider="slack" onChat={() => {}} onTools={() => {}} onClose={onClose} />));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("ChatConnectionPurpose", () => {
  it("offers a close button that leaves the choice", () => {
    const onClose = vi.fn();
    const close = render(onClose).querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(close).not.toBeNull();
    act(() => close!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has no close button when nothing handles it", () => {
    expect(render().querySelector('button[aria-label="Close"]')).toBeNull();
  });
});
