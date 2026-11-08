// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RemoteSupportUxLab } from "./RemoteSupportUxLab";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("RemoteSupportUxLab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function renderPage() {
    await act(async () => {
      root.render(<RemoteSupportUxLab />);
    });
  }

  function button(label: string) {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
  }

  it("discloses that the session and phone preview are simulated", async () => {
    await renderPage();

    expect(container.textContent).toContain("UI prototype");
    expect(container.textContent).toContain("Demo only — no phone is connected");
    expect(container.textContent).toContain("Example screen · no live video");
    expect(container.textContent).toContain("Screen sharing approved");
  });

  it("requires a separate owner decision before showing control approval", async () => {
    await renderPage();

    await act(async () => {
      button("Request control access")?.click();
    });
    expect(container.textContent).toContain("Waiting for Maya Chen to approve on their phone.");

    await act(async () => {
      button("View owner approval")?.click();
    });
    expect(container.textContent).toContain("Allow the support helper to control your phone?");

    await act(async () => {
      button("Approve for this session")?.click();
    });
    expect(container.textContent).toContain("Control access approved");

    await act(async () => {
      button("Back to support view")?.click();
    });
    expect(container.textContent).toContain("The owner approved this demo request. No phone input is enabled.");
  });

  it("keeps iPhone control unavailable and ends the session on request", async () => {
    await renderPage();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Jordan Lee, iPhone 15, iPhone"]')
        ?.click();
    });
    expect(container.textContent).toContain("Control is not included for iPhone in this prototype.");
    expect(button("Request control access")).toBeUndefined();

    await act(async () => {
      button("End session")?.click();
    });
    expect(container.textContent).toContain("Support session ended");
    expect(container.textContent).toContain("A new session requires the phone owner to approve screen sharing again.");

    await act(async () => {
      button("Start new demo")?.click();
    });
    expect(container.textContent).toContain("Allow screen sharing for this session?");
    expect(container.textContent).toContain("The helper can only see your screen after you approve.");
  });
});
