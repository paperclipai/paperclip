// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoTravelConcierge } from "./DemoTravelConcierge";
import { ThemeProvider } from "../context/ThemeContext";

const getSessionMock = vi.hoisted(() => vi.fn());
const listTemplatesMock = vi.hoisted(() => vi.fn());

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
  },
}));

vi.mock("../api/companyTemplates", () => ({
  companyTemplatesApi: {
    list: () => listTemplatesMock(),
    deploy: vi.fn(),
  },
}));

function renderPage() {
  const el = document.createElement("div");
  const root = createRoot(el);
  root.render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/demo/travel-concierge"]}>
          <DemoTravelConcierge />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return el;
}

describe("DemoTravelConcierge", () => {
  beforeEach(() => {
    getSessionMock.mockResolvedValue(null);
    listTemplatesMock.mockResolvedValue([
      {
        key: "travel-concierge",
        name: "Travel Concierge",
        description: "A ready-to-run travel concierge company",
        industry: "Travel & Hospitality",
        icon: "✈️",
        company: {
          name: "Voyager Concierge",
          description: "AI-powered travel concierge",
          brandColor: "#0f766e",
        },
        starterPackKey: "travel-industry",
      },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders the hero heading", async () => {
    const container = renderPage();

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Travel Concierge");
    });
  });

  it("shows all three agent profiles", async () => {
    const container = renderPage();

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Atlas");
      expect(container.textContent).toContain("Lyra");
      expect(container.textContent).toContain("Sage");
    });
  });

  it("shows deploy button for unauthenticated users", async () => {
    const container = renderPage();

    await vi.waitFor(() => {
      // The main CTA button with "Deploy" text (not the header "Sign In" button)
      const deployBtn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Deploy"),
      );
      expect(deployBtn).toBeTruthy();
    });
  });

  it("shows sign-in prompt for unauthenticated users", async () => {
    const container = renderPage();

    await vi.waitFor(() => {
      expect(container.textContent).toMatch(/sign in/i);
    });
  });
});