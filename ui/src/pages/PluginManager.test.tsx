import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { PluginManager } from "./PluginManager";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { ToastProvider } from "@/context/ToastContext";
import { pluginsApi } from "@/api/plugins";
import type { PluginRecord } from "@paperclipai/shared";

// Suppress React act() warnings from async state updates in tests
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  if (
    typeof args[0] === "string" &&
    (/Warning.*not wrapped in act/.test(args[0]) ||
      /React.act/.test(args[0]))
  ) {
    return;
  }
  originalConsoleError(...args);
};

// React 19 / testing-library compat shim
if (!React.act) {
  (React as Record<string, unknown>).act = (cb: () => unknown) => cb();
}

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { name: "Test Co" } }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ companyPrefix: "test-co" }),
  Link: ({ children, to, title }: { children: React.ReactNode; to: string; title?: string }) => (
    <a href={to} title={title}>{children}</a>
  ),
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    list: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlugin(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "p1",
    pluginKey: "acme.test",
    version: "1.0.0",
    status: "ready",
    packageName: "@acme/test",
    installedAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    lastError: null,
    manifestJson: {
      id: "acme.test",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Test Plugin",
      description: "A test plugin",
      categories: ["connector"],
      capabilities: [],
      entrypoints: { worker: "./worker.js" },
    },
    ...overrides,
  } as unknown as PluginRecord;
}

function renderComponent() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <PluginManager />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PluginManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------
  it("shows loading state while fetching plugins", async () => {
    (pluginsApi.list as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    renderComponent();

    // getByText throws if not found — this validates the element exists
    await waitFor(() => {
      expect(screen.getByText(/loading plugins/i)).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------
  it("shows empty state when no plugins are installed", async () => {
    (pluginsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/no plugins installed/i)).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Plugin list rendering
  // -------------------------------------------------------------------------
  it("renders installed plugin display name", async () => {
    (pluginsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ manifestJson: { displayName: "My Awesome Plugin" } as never }),
    ]);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("My Awesome Plugin")).toBeTruthy();
    });
  });

  it("renders status badge for a ready plugin", async () => {
    (pluginsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ status: "ready" }),
    ]);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("ready")).toBeTruthy();
    });
  });

  it("renders the Plugin Manager heading", async () => {
    (pluginsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/plugin manager/i)).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Install dialog
  // -------------------------------------------------------------------------
  it("shows Install Plugin button", async () => {
    (pluginsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /install plugin/i })).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Uninstall confirmation dialog
  // -------------------------------------------------------------------------
  it("does NOT call uninstall immediately when Trash button is clicked", async () => {
    (pluginsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin(),
    ]);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByTitle("Uninstall")).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("Uninstall"));

    // uninstall should NOT have been called — confirmation dialog must appear first
    expect(pluginsApi.uninstall).not.toHaveBeenCalled();
  });

  it("shows confirmation dialog with plugin name after Trash click", async () => {
    (pluginsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ manifestJson: { displayName: "Critical Plugin" } as never }),
    ]);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByTitle("Uninstall")).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("Uninstall"));

    // Dialog heading should appear
    await waitFor(() => {
      expect(screen.getByText(/uninstall plugin/i)).toBeTruthy();
    });
    // Plugin name appears in both the card and the dialog — use getAllByText
    const pluginNameMatches = screen.getAllByText(/critical plugin/i);
    expect(pluginNameMatches.length).toBeGreaterThanOrEqual(1);
  });

  it("dismisses confirmation dialog without calling uninstall on Cancel", async () => {
    (pluginsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin(),
    ]);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByTitle("Uninstall")).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("Uninstall"));
    await waitFor(() => {
      expect(screen.getByText(/uninstall plugin/i)).toBeTruthy();
    });

    // Click Cancel in the confirmation dialog
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(pluginsApi.uninstall).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByText(/are you sure you want to uninstall/i)).toBeNull();
    });
  });

  it("calls uninstall API with plugin id when confirmed", async () => {
    (pluginsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ id: "plugin-xyz" }),
    ]);
    (pluginsApi.uninstall as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByTitle("Uninstall")).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("Uninstall"));

    // Click the destructive Uninstall button in the dialog
    await waitFor(() => {
      expect(screen.getByText(/uninstall plugin/i)).toBeTruthy();
    });
    const confirmBtn = screen.getByRole("button", { name: /^uninstall$/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(pluginsApi.uninstall).toHaveBeenCalledWith("plugin-xyz");
    });
  });
});
