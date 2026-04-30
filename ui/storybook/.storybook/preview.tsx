import { useEffect, useState, type ReactNode } from "react";
import type { Preview } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "@/lib/router";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { CompanyProvider } from "@/context/CompanyContext";
import { DialogProvider } from "@/context/DialogContext";
import { EditorAutocompleteProvider } from "@/context/EditorAutocompleteContext";
import { PanelProvider } from "@/context/PanelContext";
import { SidebarProvider } from "@/context/SidebarContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { ToastProvider } from "@/context/ToastContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  storybookAgents,
  storybookApprovals,
  storybookAuthSession,
  storybookCompanies,
  storybookDashboardSummary,
  storybookIssues,
  storybookLiveRuns,
  storybookProjects,
  storybookSidebarBadges,
} from "../fixtures/paperclipData";
import "@mdxeditor/editor/style.css";
import "./tailwind-entry.css";
import "./styles.css";

function installStorybookApiFixtures() {
  if (typeof window === "undefined") return;
  const currentWindow = window as typeof window & {
    __paperclipStorybookFetchInstalled?: boolean;
  };
  if (currentWindow.__paperclipStorybookFetchInstalled) return;

  const originalFetch = window.fetch.bind(window);
  currentWindow.__paperclipStorybookFetchInstalled = true;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(rawUrl, window.location.origin);

    if (url.pathname === "/api/auth/get-session") {
      return Response.json(storybookAuthSession);
    }

    if (url.pathname === "/api/companies") {
      return Response.json(storybookCompanies);
    }

    if (url.pathname === "/api/companies/company-storybook/user-directory") {
      return Response.json({
        users: [
          {
            principalId: "user-board",
            status: "active",
            user: {
              id: "user-board",
              email: "board@paperclip.local",
              name: "Board Operator",
              image: null,
            },
          },
          {
            principalId: "user-product",
            status: "active",
            user: {
              id: "user-product",
              email: "product@paperclip.local",
              name: "Product Lead",
              image: null,
            },
          },
        ],
      });
    }

    if (url.pathname === "/api/instance/settings/experimental") {
      return Response.json({
        enableIsolatedWorkspaces: true,
        autoRestartDevServerWhenIdle: false,
      });
    }

    if (url.pathname === "/api/adapters") {
      return Response.json([
        {
          type: "claude_local",
          label: "Claude Local",
          source: "builtin",
          modelsCount: 2,
          loaded: true,
          disabled: false,
          capabilities: {
            supportsInstructionsBundle: true,
            supportsSkills: true,
            supportsLocalAgentJwt: true,
            requiresMaterializedRuntimeSkills: false,
            supportsModelProfiles: true,
          },
        },
        {
          type: "codex_local",
          label: "Codex Local",
          source: "builtin",
          modelsCount: 3,
          loaded: true,
          disabled: false,
          capabilities: {
            supportsInstructionsBundle: true,
            supportsSkills: true,
            supportsLocalAgentJwt: true,
            requiresMaterializedRuntimeSkills: false,
            supportsModelProfiles: true,
          },
        },
      ]);
    }

    const adapterModelsMatch = url.pathname.match(
      /^\/api\/companies\/[^/]+\/adapters\/([^/]+)\/(models|model-profiles)$/,
    );
    if (adapterModelsMatch) {
      const [, , resource] = adapterModelsMatch;
      if (resource === "models") {
        return Response.json([
          { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
          { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
          { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
        ]);
      }
      return Response.json([
        {
          key: "cheap",
          label: "Cheap",
          adapterConfig: { model: "claude-sonnet-4-6" },
          source: "adapter_default",
        },
      ]);
    }

    if (url.pathname === "/api/plugins/ui-contributions") {
      return Response.json([]);
    }

    const companyResourceMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/([^/]+)$/);
    if (companyResourceMatch) {
      const [, companyId, resource] = companyResourceMatch;
      if (resource === "agents") {
        return Response.json(companyId === "company-storybook" ? storybookAgents : []);
      }
      if (resource === "projects") {
        return Response.json(companyId === "company-storybook" ? storybookProjects : []);
      }
      if (resource === "approvals") {
        return Response.json(companyId === "company-storybook" ? storybookApprovals : []);
      }
      if (resource === "dashboard") {
        return Response.json({
          ...storybookDashboardSummary,
          companyId,
        });
      }
      if (resource === "heartbeat-runs") {
        return Response.json([]);
      }
      if (resource === "live-runs") {
        return Response.json(companyId === "company-storybook" ? storybookLiveRuns : []);
      }
      if (resource === "inbox-dismissals") {
        return Response.json([]);
      }
      if (resource === "sidebar-badges") {
        return Response.json(
          companyId === "company-storybook"
            ? storybookSidebarBadges
            : { inbox: 0, approvals: 0, failedRuns: 0, joinRequests: 0 },
        );
      }
      if (resource === "join-requests") {
        return Response.json([]);
      }
      if (resource === "issues") {
        const query = url.searchParams.get("q")?.trim().toLowerCase();
        const issues = companyId === "company-storybook" ? storybookIssues : [];
        return Response.json(
          query
            ? issues.filter((issue) =>
                `${issue.identifier ?? ""} ${issue.title} ${issue.description ?? ""}`.toLowerCase().includes(query),
              )
            : issues,
        );
      }
    }

    if (url.pathname.startsWith("/api/invites/") && url.pathname.endsWith("/logo")) {
      return new Response(null, { status: 204 });
    }

    return originalFetch(input, init);
  };
}

function applyStorybookTheme(theme: "light" | "dark") {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

function StorybookProviders({
  children,
  theme,
}: {
  children: ReactNode;
  theme: "light" | "dark";
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Number.POSITIVE_INFINITY,
          },
        },
      }),
  );

  useEffect(() => {
    applyStorybookTheme(theme);
    installStorybookApiFixtures();
  }, [theme]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/PAP/storybook"]}>
          <CompanyProvider>
            <EditorAutocompleteProvider>
              <ToastProvider>
                <TooltipProvider>
                  <BreadcrumbProvider>
                    <SidebarProvider>
                      <PanelProvider>
                        <DialogProvider>{children}</DialogProvider>
                      </PanelProvider>
                    </SidebarProvider>
                  </BreadcrumbProvider>
                </TooltipProvider>
              </ToastProvider>
            </EditorAutocompleteProvider>
          </CompanyProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

const preview: Preview = {
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme === "light" ? "light" : "dark";
      return (
        <StorybookProviders key={theme} theme={theme}>
          <Story />
        </StorybookProviders>
      );
    },
  ],
  globalTypes: {
    theme: {
      description: "Paperclip color mode",
      defaultValue: "dark",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    actions: { argTypesRegex: "^on[A-Z].*" },
    a11y: {
      test: "error",
    },
    backgrounds: {
      disable: true,
    },
    controls: {
      expanded: true,
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    docs: {
      toc: true,
    },
    layout: "fullscreen",
    viewport: {
      viewports: {
        mobile: {
          name: "Mobile",
          styles: { width: "390px", height: "844px" },
        },
        tablet: {
          name: "Tablet",
          styles: { width: "834px", height: "1112px" },
        },
        desktop: {
          name: "Desktop",
          styles: { width: "1440px", height: "960px" },
        },
      },
    },
  },
};

export default preview;
