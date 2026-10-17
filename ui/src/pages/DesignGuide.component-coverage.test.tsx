// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Router links on the page (CompanyLink) read company context through the "@/"
// alias, so the mock has to use the same specifier or it never applies. The real
// provider stays in the tree; only the read is stubbed, because this test is
// about what the page draws rather than how company switching works.
vi.mock("@/context/CompanyContext", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useCompany: () => ({
      companies: [],
      selectedCompanyId: null,
      selectedCompany: null,
      setSelectedCompanyId: () => {},
      selectionSource: "bootstrap",
      isLoading: false,
      error: null,
    }),
  };
});
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "../context/ThemeContext";
import { SidebarProvider } from "../context/SidebarContext";
import { PanelProvider } from "../context/PanelContext";
import { DialogProvider } from "../context/DialogContext";
import { CompanyProvider } from "@/context/CompanyContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DesignGuide } from "./DesignGuide";

// Same provider stack the app mounts around <App/> in main.tsx, minus the ones
// that need live company data or network. Without these the page throws on the
// first context read and renders nothing, which would make every assertion here
// pass vacuously.
// jsdom implements neither matchMedia nor the observers ThemeProvider subscribes
// with, and ThemeProvider is the outermost thing that touches them. Without the
// stub the provider stack throws during mount and the page renders nothing, which
// would make every assertion below pass vacuously.
function installBrowserStubs() {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
}

function wrap(node: React.ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ThemeProvider>
        <TooltipProvider>
          <SidebarProvider>
            <PanelProvider>
              <DialogProvider>
                <MemoryRouter>{node}</MemoryRouter>
              </DialogProvider>
            </PanelProvider>
          </SidebarProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

// A Section renders <section><h3>{title}</h3>...<Separator/>{children}</section>,
// so a heading can be matched to the element that holds that section's content.
function sectionFor(container: HTMLElement, heading: string): HTMLElement | null {
  for (const section of Array.from(container.querySelectorAll("section"))) {
    if (section.querySelector("h3")?.textContent === heading) return section;
  }
  return null;
}

function screen(text: string, needle: string): boolean {
  return text.includes(needle);
}

describe("DesignGuide component coverage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    installBrowserStubs();
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  // The Component Coverage roster names alert-dialog, attachment, radio-card and
  // toggle-switch. Listing a component there is a claim the page demonstrates it,
  // so a heading is not coverage -- the component has to actually instantiate.
  it("demonstrates every primitive the coverage roster newly names", () => {
    flushSync(() => root.render(wrap(<DesignGuide />)));

    const text = container.textContent ?? "";
    expect(text).not.toBe("");

    // The Alert Dialog trigger renders inline; its content only mounts on open.
    expect(screen(text, "Delete run")).toBe(true);

    for (const heading of ["Alert Dialog", "Toggle Switch", "Radio Card", "Attachment"]) {
      expect(text).toContain(heading);
      expect(sectionFor(container, heading)).not.toBeNull();
    }

    const toggleSection = sectionFor(container, "Toggle Switch")!;
    expect(toggleSection.querySelectorAll('[data-slot="toggle"]')).toHaveLength(3);
    // size="lg" and disabled are the two states worth demonstrating; both are
    // only visible as attributes, so assert on them rather than on pixels.
    expect(toggleSection.querySelectorAll('[data-slot="toggle"][disabled]')).toHaveLength(1);
    // Each row's <Label> describes the state that row is actually in. The first
    // draft read "Off by default" above a switch initialised to true, so the page
    // taught the wrong thing about the component it exists to document. Assert the
    // rendered state and its label together instead of trusting the label.
    // Both interactive rows mount checked so the "on" fill is visible without a
    // click; the disabled row mounts unchecked. One of each state, plus a label
    // that matches, is what a reader needs from this section.
    expect(toggleSection.querySelectorAll('[data-slot="toggle"][aria-checked="true"]'))
      .toHaveLength(2);
    expect(toggleSection.querySelectorAll('[data-slot="toggle"][aria-checked="false"]'))
      .toHaveLength(1);
    // Each row's <Label> has to describe the state that row is actually in. The
    // first draft read "Off by default" above a switch initialised to true, so the
    // page taught the wrong thing about the component it exists to document. Read
    // the rendered aria-checked back rather than trusting the label text.
    for (const toggle of Array.from(toggleSection.querySelectorAll('[data-slot="toggle"]'))) {
      const id = toggle.getAttribute("id")!;
      const label = toggleSection.querySelector(`label[for="${id}"]`)!.textContent!;
      const on = toggle.getAttribute("aria-checked") === "true";
      if (on) {
        expect(label, `label "${label}" is off but aria-checked is true`)
          .toMatch(/^on\b/i);
      } else {
        expect(label, `label "${label}" is on but aria-checked is false`)
          .toMatch(/^off\b/i);
      }
    }

    const radioSection = sectionFor(container, "Radio Card")!;
    expect(radioSection.querySelectorAll('[role="radio"]')).toHaveLength(3);
    // one disabled option, to show the "stays legible with a reason" treatment
    expect(radioSection.querySelectorAll('[role="radio"][disabled]')).toHaveLength(1);
    expect(radioSection.querySelectorAll('[aria-checked="true"]')).toHaveLength(1);

    const attachmentSection = sectionFor(container, "Attachment")!;
    expect(attachmentSection.querySelectorAll('[data-slot="attachment"]')).toHaveLength(4);
    for (const state of ["idle", "uploading", "error", "done"]) {
      expect(
        attachmentSection.querySelector(`[data-slot="attachment"][data-state="${state}"]`),
      ).not.toBeNull();
    }
  });
});
