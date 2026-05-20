// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

// React 19 production-bundle workaround — see EaosShell.test.tsx for full
// context. Must run before any React import is evaluated.
vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DialogProvider } from "@/context/DialogContext";
import { EaosProductLayout } from "./EaosProductLayout";
import { EaosShell } from "./EaosShell";
import { CommandCenterLanding } from "./CommandCenterLanding";
import { actSync, flushReactQuery } from "./test-helpers";

// LET-415 regression: /eaos must be full-screen with NO Paperclip board
// chrome. The acceptance criteria call out the exact sidebar labels that
// must be absent so this test reproduces the human eye-check the operator
// just did on the screenshot. If a future refactor re-embeds the EAOS shell
// inside the Paperclip Layout, this test should catch it.
const PAPERCLIP_BOARD_NAV_LABELS = [
  "Issues",
  "Routines",
  "Goals",
  "Inbox",
  "Projects",
  "Agents",
] as const;

// Stub CompanyContext so the @/lib/router Link / NavLink wrappers can resolve
// useCompany() without a full provider tree.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

// The product layout queries health + general-settings on mount. Stub both
// so the layout renders synchronously without network noise.
vi.mock("@/api/health", () => ({
  healthApi: {
    get: vi.fn().mockResolvedValue({ devServer: { enabled: false } }),
  },
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getGeneral: vi.fn().mockResolvedValue({ keyboardShortcuts: false }),
  },
}));

// CommandPalette dispatches Cmd+K listeners and does its own data fetching.
// Stub it to a marker so we can assert it is mounted without dragging in the
// full dialog machinery in a jsdom unit test.
vi.mock("@/components/CommandPalette", () => ({
  CommandPalette: () => <div data-testid="command-palette-stub" />,
}));

// ToastViewport reads from ToastContext via useToastState. The full provider
// tree (main.tsx) wraps the app in ToastProvider, but this unit test only
// mounts the layout — stub the viewport so it can render standalone.
vi.mock("@/components/ToastViewport", () => ({
  ToastViewport: () => <div data-testid="toast-viewport-stub" />,
}));

// DevRestartBanner and WorktreeBanner make their own queries; stub to keep
// this layout test focused on layout structure rather than chrome wiring.
vi.mock("@/components/DevRestartBanner", () => ({
  DevRestartBanner: () => null,
}));

vi.mock("@/components/WorktreeBanner", () => ({
  WorktreeBanner: () => null,
}));

// LET-484 — CommandCenterLanding now consumes the live mission/agent feed.
// Stub the api modules so this layout test stays focused on layout structure
// and the queries resolve without network noise.
vi.mock("@/api/issues", () => ({
  issuesApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));

let container: HTMLDivElement | null = null;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

async function renderAt(initialPath: string, child: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  actSync(() => {
    root.render(
      <QueryClientProvider client={makeQueryClient()}>
        <DialogProvider>
          <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
              <Route path="eaos" element={<EaosProductLayout />}>
                {child}
              </Route>
              <Route path="agent-os" element={<EaosProductLayout />}>
                <Route index element={<div data-testid="agent-os-stub">Agent OS content</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </DialogProvider>
      </QueryClientProvider>,
    );
  });
  // Drain react-query promises so the post-resolve re-renders commit inside
  // an act() boundary instead of leaking jsdom warnings — LET-484 nit #4.
  await flushReactQuery();
  return { root };
}

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
});

describe("EaosProductLayout — full-screen product shell (LET-415)", () => {
  it("renders the page-level <main id=\"main-content\"> landmark itself, since no outer Layout wraps it", async () => {
    await renderAt(
      "/eaos",
      <Route element={<EaosShell variant="eaos" />}>
        <Route index element={<CommandCenterLanding />} />
      </Route>,
    );

    const main = container?.querySelector("main#main-content");
    expect(main).not.toBeNull();
    expect(main?.getAttribute("tabindex")).toBe("-1");
  });

  it("renders a skip-to-main-content link for keyboard users", async () => {
    await renderAt(
      "/eaos",
      <Route element={<EaosShell variant="eaos" />}>
        <Route index element={<CommandCenterLanding />} />
      </Route>,
    );

    const skipLink = Array.from(container?.querySelectorAll("a") ?? []).find(
      (a) => a.getAttribute("href") === "#main-content",
    );
    expect(skipLink).not.toBeUndefined();
    expect(skipLink?.textContent).toMatch(/skip to main content/i);
  });

  it("mounts the EAOS shell inside the product layout when /eaos renders", async () => {
    await renderAt(
      "/eaos",
      <Route element={<EaosShell variant="eaos" />}>
        <Route index element={<CommandCenterLanding />} />
      </Route>,
    );

    expect(container?.querySelector('[data-eaos-shell="eaos"]')).not.toBeNull();
    expect(container?.querySelector('header[role="banner"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="eaos-section"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="eaos-command-center-landing"]')).not.toBeNull();
  });

  it("does NOT render the Paperclip board sidebar nav labels (Issues, Routines, Goals, Inbox, Projects, Agents)", async () => {
    await renderAt(
      "/eaos",
      <Route element={<EaosShell variant="eaos" />}>
        <Route index element={<CommandCenterLanding />} />
      </Route>,
    );

    // The Paperclip board <Sidebar> renders an <aside> with NavLink children
    // labeled with kernel board verbs. EaosProductLayout must not pull that
    // chrome — those labels would only appear if the EAOS shell was
    // re-embedded inside Layout.
    const sidebarAside = container?.querySelector("aside");
    expect(sidebarAside, "EaosProductLayout must not render the Paperclip board <aside> sidebar")
      .toBeNull();

    // LET-503: the EAOS primary rail intentionally includes single-noun
    // labels like "Projects" and "Agents" (LET-502 contract §2). The check
    // here must only catch *board chrome* leakage — anchors that originate
    // OUTSIDE the EAOS shell. Filter on `data-testid="eaos-*"` so the
    // primary nav anchors are excluded from the forbidden-label scan.
    const navLinks = Array.from(container?.querySelectorAll("a") ?? []).filter(
      (a) => !(a.getAttribute("data-testid") ?? "").startsWith("eaos-"),
    );
    const textContents = navLinks.map((a) => (a.textContent ?? "").trim());
    for (const forbidden of PAPERCLIP_BOARD_NAV_LABELS) {
      const exactMatch = textContents.find((text) => text === forbidden);
      expect(
        exactMatch,
        `EaosProductLayout must not render a Paperclip-board nav link labelled "${forbidden}"`,
      ).toBeUndefined();
    }
  });

  it("mounts the CommandPalette so the EAOS top bar's ⌘K trigger keeps working", async () => {
    await renderAt(
      "/eaos",
      <Route element={<EaosShell variant="eaos" />}>
        <Route index element={<CommandCenterLanding />} />
      </Route>,
    );

    expect(container?.querySelector('[data-testid="command-palette-stub"]')).not.toBeNull();
  });

  it("renders /agent-os inside the same full-screen product layout (no board chrome)", async () => {
    await renderAt("/agent-os", null);

    // The AgentOs page renders inside EaosProductLayout's <main>, with no
    // Paperclip sidebar / breadcrumb wrapper.
    expect(container?.querySelector('[data-testid="agent-os-stub"]')).not.toBeNull();
    expect(container?.querySelector("aside"), "no Paperclip board sidebar on /agent-os").toBeNull();
    expect(container?.querySelector("main#main-content")).not.toBeNull();
  });
});
