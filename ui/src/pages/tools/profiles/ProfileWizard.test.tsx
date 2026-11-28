// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/context/ToastContext";
import { ProfileWizard } from "./ProfileWizard";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("./useProfilesData", () => ({
  useProfilesData: () => ({
    profiles: { data: { profiles: [] }, isLoading: false },
    applications: { data: { applications: [] } },
    connections: { data: { connections: [] }, isLoading: false },
    agents: { data: [] },
    projects: { data: [] },
    routines: { data: [] },
    catalog: [],
    catalogLoading: false,
    appGroups: [],
    maps: {
      applicationsById: new Map(),
      connectionsById: new Map(),
      agentsById: new Map(),
      projectsById: new Map(),
      routinesById: new Map(),
    },
  }),
}));

describe("ProfileWizard", () => {
  it("positions the fixed footer above MobileBottomNav on mobile and reserves extra bottom scroll padding", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <MemoryRouter>
                <ProfileWizard companyId="company-1" />
              </MemoryRouter>
            </ToastProvider>
          </QueryClientProvider>,
        );
      });

      const wrapper = container.firstElementChild as HTMLElement | null;
      expect(wrapper).not.toBeNull();
      expect(wrapper!.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["pb-36", "md:pb-24"]),
      );

      const footer = container.querySelector(".fixed.inset-x-0") as HTMLElement | null;
      expect(footer).not.toBeNull();
      const footerClasses = footer!.className.split(/\s+/);
      expect(footerClasses).toContain("mobile-nav-composer");
      expect(footerClasses).toContain("bottom-(--tc-composer-bottom)");
      expect(footerClasses).toContain("md:bottom-0");
      expect(footerClasses).toContain("z-20");

      const innerRow = footer!.firstElementChild as HTMLElement | null;
      expect(innerRow?.className.split(/\s+/)).toContain("flex-wrap");
      expect(footer!.textContent).toContain("Cancel");
      expect(footer!.textContent).toContain("Continue");
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });
});
