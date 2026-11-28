// @vitest-environment jsdom
import { act, useContext } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { VoiceCallContext } from "./VoiceCallContext";
import { VoiceCallProvider } from "./VoiceCallProvider";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("./NativeVoiceConversation", () => ({
  NativeVoiceConversation: ({ onEndedChange }: { onEndedChange?: (ended: boolean) => void }) => (
    <div data-testid="mock-voice-conversation">
      <button type="button" onClick={() => onEndedChange?.(true)}>End call</button>
    </div>
  ),
}));

function TriggerCall() {
  const host = useContext(VoiceCallContext);
  return (
    <button
      type="button"
      onClick={() =>
        host?.open({
          companyId: "company-1",
          endpointId: "endpoint-1",
          agentName: "Chief",
          client: {} as never,
        })
      }
    >
      Open voice
    </button>
  );
}

describe("VoiceCallProvider", () => {
  it("lifts the active voice call panel above MobileBottomNav with mobile max-height and horizontal fit", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <VoiceCallProvider companyId="company-1" userId="user-1">
            <TriggerCall />
          </VoiceCallProvider>,
        ),
      );
      const openButton = container.querySelector("button")!;
      act(() => openButton.click());

      const panel = container.querySelector('aside[aria-label="Current voice call"]');
      expect(panel).not.toBeNull();
      const classes = panel!.className.split(/\s+/);
      expect(classes).toContain("inset-x-4");
      expect(classes).toContain("bottom-(--mobile-nav-overlay-bottom)");
      expect(classes).toContain("max-h-(--mobile-nav-overlay-max-h)");
      expect(classes).toContain("md:bottom-4");
      expect(classes).toContain("md:max-h-(--sz-calc-18)");
      expect(classes).toContain("sm:left-auto");
      expect(classes).toContain("sm:w-96");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
