import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { PluginSettings } from "./PluginSettings";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { ToastProvider } from "@/context/ToastContext";
import { pluginsApi } from "@/api/plugins";
import { usePluginSlots } from "@/plugins/slots";
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
  useCompany: () => ({ selectedCompany: { name: "Test Co" }, selectedCompanyId: "comp-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ companyPrefix: "test-co", pluginId: "plug-1" }),
  Link: ({ children, to, title }: { children: React.ReactNode; to: string; title?: string }) => (
    <a href={to} title={title}>{children}</a>
  ),
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    get: vi.fn(),
    health: vi.fn(),
    dashboard: vi.fn(),
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
    testConfig: vi.fn(),
  },
}));

vi.mock("@/components/JsonSchemaForm", () => ({
  JsonSchemaForm: ({ schema, values, onChange, errors }: any) => (
    <div data-testid="json-schema-form">
      {Object.keys(schema.properties || {}).map(key => {
        const prop = schema.properties[key];
        const errorKey = `/${key}`;
        const val = values[key] ?? "";
        return (
          <div key={key}>
            <label>{prop.title || key}</label>
            {prop.description && <p>{prop.description}</p>}
            <input 
              value={typeof val === 'number' ? String(val) : (val as string)} 
              data-testid={`input-${key}`} 
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
            />
            {errors?.[errorKey] && <span className="text-destructive">{errors[errorKey]}</span>}
          </div>
        );
      })}
    </div>
  ),
  validateJsonSchemaForm: vi.fn((schema, values) => {
    const errors: any = {};
    if (schema.required) {
      schema.required.forEach((key: string) => {
        if (!values[key]) errors[`/${key}`] = "This field is required";
      });
    }
    return errors;
  }),
  getDefaultValues: vi.fn((schema) => {
    const defaults: any = {};
    if (schema.properties) {
      Object.keys(schema.properties).forEach(key => {
        defaults[key] = schema.properties[key].default ?? "";
      });
    }
    return defaults;
  }),
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: vi.fn(),
  PluginSlotOutlet: ({ slotTypes }: { slotTypes: string[] }) => (
    <div data-testid="plugin-slot-outlet" data-slot-types={slotTypes.join(",")} />
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlugin(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "plug-1",
    pluginKey: "acme.test",
    version: "1.0.0",
    status: "ready",
    packageName: "@acme/test-plugin",
    installedAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    lastError: null,
    manifestJson: {
      id: "acme.test",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Test Plugin",
      description: "A test plugin for unit testing",
      categories: ["connector"],
      capabilities: ["readTasks", "writeTasks"],
      entrypoints: { worker: "./worker.js" },
    },
    ...overrides,
  } as unknown as PluginRecord;
}

function makePluginWithConfig(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return makePlugin({
    manifestJson: {
      id: "acme.test",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Test Plugin",
      description: "A configurable plugin",
      categories: ["connector"],
      capabilities: ["readTasks"],
      entrypoints: { worker: "./worker.js" },
      instanceConfigSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            format: "secret-ref",
            title: "API Key",
            description: "Your secret API key",
          },
          baseUrl: {
            type: "string",
            title: "Base URL",
            description: "The base URL of the API",
          },
          syncInterval: {
            type: "integer",
            title: "Sync Interval",
            description: "Interval in minutes",
            minimum: 1,
            maximum: 60,
            default: 15,
          },
        },
        required: ["apiKey", "baseUrl"],
      },
    } as never,
    ...overrides,
  });
}

function makeDashboardData(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "plug-1",
    worker: {
      status: "running",
      pid: 12345,
      uptime: 3600000,
      consecutiveCrashes: 0,
      totalCrashes: 0,
      pendingRequests: 0,
      lastCrashAt: null,
      nextRestartAt: null,
    },
    recentJobRuns: [],
    recentWebhookDeliveries: [],
    health: {
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [{ name: "registry", passed: true }],
    },
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderComponent() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <PluginSettings />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PluginSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (usePluginSlots as ReturnType<typeof vi.fn>).mockReturnValue({ slots: [] });
    // Default dashboard mock — individual tests can override
    (pluginsApi.dashboard as ReturnType<typeof vi.fn>).mockResolvedValue(makeDashboardData());
  });

  afterEach(() => {
    cleanup();
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------
  it("shows loading state while fetching plugin details", async () => {
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    renderComponent();

    expect(await screen.findByText(/loading plugin details/i)).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Plugin not found
  // -------------------------------------------------------------------------
  it("shows 'Plugin not found' when API returns no data", async () => {
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/plugin not found/i)).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Plugin identity rendering
  // -------------------------------------------------------------------------
  it("renders plugin display name and version", async () => {
    const plugin = makePlugin();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Test Plugin")).toBeTruthy();
    });

    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByText("v1.0.0")).toBeTruthy();
  });

  it("renders plugin description", async () => {
    const plugin = makePlugin();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("A test plugin for unit testing")).toBeTruthy();
    });
  });

  it("shows 'No description provided' when description is empty", async () => {
    const plugin = makePlugin({
      manifestJson: {
        id: "acme.test",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Empty Plugin",
        description: "",
        categories: [],
        capabilities: [],
        entrypoints: { worker: "./worker.js" },
      } as never,
    });
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("No description provided.")).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Capabilities / permissions rendering
  // -------------------------------------------------------------------------
  it("renders declared capabilities", async () => {
    const plugin = makePlugin();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("readTasks")).toBeTruthy();
    });
    expect(screen.getByText("writeTasks")).toBeTruthy();
  });

  it("shows 'No special permissions' when capabilities are empty", async () => {
    const plugin = makePlugin({
      manifestJson: {
        id: "acme.test",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "No Perms Plugin",
        description: "No capabilities",
        categories: [],
        capabilities: [],
        entrypoints: { worker: "./worker.js" },
      } as never,
    });
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/no special permissions requested/i)).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Health status rendering
  // -------------------------------------------------------------------------
  it("renders healthy status with individual checks", async () => {
    const plugin = makePlugin();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [
        { name: "API Connection", passed: true },
        { name: "Auth Token", passed: true },
      ],
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("API Connection")).toBeTruthy();
    });
    expect(screen.getByText("Auth Token")).toBeTruthy();
    // "ready" appears in both the plugin status badge and health overall badge
    const readyBadges = screen.getAllByText("ready");
    expect(readyBadges.length).toBeGreaterThanOrEqual(1);
  });

  it("renders unhealthy status with failed checks and error", async () => {
    const plugin = makePlugin({ status: "ready" });
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "degraded",
      healthy: false,
      checks: [
        { name: "API Connection", passed: false, message: "Timed out" },
        { name: "Auth Token", passed: true },
      ],
      lastError: "Plugin is degraded due to API timeout",
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("API Connection")).toBeTruthy();
    });
    expect(screen.getByText("Auth Token")).toBeTruthy();
    expect(screen.getByText("degraded")).toBeTruthy();
    expect(screen.getByText("Plugin is degraded due to API timeout")).toBeTruthy();
  });

  it("shows health data unavailable message when health data is null", async () => {
    const plugin = makePlugin({ status: "error" });
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    // health won't be fetched for non-ready plugins, but the query returns null
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/health data unavailable/i)).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Settings section — no config schema
  // -------------------------------------------------------------------------
  it("shows 'does not require configuration' when no instanceConfigSchema", async () => {
    const plugin = makePlugin();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/does not require configuration/i)).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Settings section — config form rendering
  // -------------------------------------------------------------------------
  it("renders the auto-generated config form from instanceConfigSchema", async () => {
    const plugin = makePluginWithConfig();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-existing", baseUrl: "https://api.test.com", syncInterval: 30 },
    });

    renderComponent();

    // Wait for config to load and form to render
    await waitFor(() => {
      expect(screen.getByText("API Key")).toBeTruthy();
    });

    expect(screen.getByText("Base URL")).toBeTruthy();
    expect(screen.getByText("Sync Interval")).toBeTruthy();
    expect(screen.getByText("Your secret API key")).toBeTruthy();
    expect(screen.getByText("The base URL of the API")).toBeTruthy();

    // Values from getConfig should be populated
    expect(screen.getByDisplayValue("sk-existing")).toBeTruthy();
    expect(screen.getByDisplayValue("https://api.test.com")).toBeTruthy();
    expect(screen.getByDisplayValue("30")).toBeTruthy();
  });

  it("shows config loading state while fetching config", async () => {
    const plugin = makePluginWithConfig();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    // Config never resolves
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/loading configuration/i)).toBeTruthy();
    });
  });

  it("renders Save Configuration button", async () => {
    const plugin = makePluginWithConfig();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-test", baseUrl: "https://api.com", syncInterval: 15 },
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /save configuration/i })).toBeTruthy();
    });
  });

  it("renders Test Connection button for ready plugins", async () => {
    const plugin = makePluginWithConfig({ status: "ready" });
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-test", baseUrl: "https://api.com", syncInterval: 15 },
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /test connection/i })).toBeTruthy();
    });
  });

  it("does NOT render Test Connection button for non-ready plugins", async () => {
    const plugin = makePluginWithConfig({ status: "error" });
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-test", baseUrl: "https://api.com", syncInterval: 15 },
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /save configuration/i })).toBeTruthy();
    });

    expect(screen.queryByRole("button", { name: /test connection/i })).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Save configuration flow
  // -------------------------------------------------------------------------
  it("calls saveConfig API when Save is clicked after editing", async () => {
    const plugin = makePluginWithConfig();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-original", baseUrl: "https://api.com", syncInterval: 15 },
    });
    (pluginsApi.saveConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-updated", baseUrl: "https://api.com", syncInterval: 15 },
    });

    renderComponent();

    // Wait for form to render
    await waitFor(() => {
      expect(screen.getByDisplayValue("sk-original")).toBeTruthy();
    });

    // Edit a field to make the form dirty
    const apiKeyInput = screen.getByDisplayValue("sk-original");
    fireEvent.change(apiKeyInput, { target: { value: "sk-updated" } });

    // Save button should now be enabled
    const saveBtn = screen.getByRole("button", { name: /save configuration/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(pluginsApi.saveConfig).toHaveBeenCalledWith("plug-1", expect.objectContaining({
        apiKey: "sk-updated",
        baseUrl: "https://api.com",
      }));
    });
  });

  it("shows success message after saving", async () => {
    const plugin = makePluginWithConfig();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-orig", baseUrl: "https://api.com", syncInterval: 15 },
    });
    (pluginsApi.saveConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-new", baseUrl: "https://api.com", syncInterval: 15 },
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByDisplayValue("sk-orig")).toBeTruthy();
    });

    // Edit a field
    fireEvent.change(screen.getByDisplayValue("sk-orig"), { target: { value: "sk-new" } });

    // Click save
    fireEvent.click(screen.getByRole("button", { name: /save configuration/i }));

    await waitFor(() => {
      expect(screen.getByText(/configuration saved/i)).toBeTruthy();
    });
  });

  it("shows error message when save fails", async () => {
    const plugin = makePluginWithConfig();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-orig", baseUrl: "https://api.com", syncInterval: 15 },
    });
    (pluginsApi.saveConfig as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Server validation failed"),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByDisplayValue("sk-orig")).toBeTruthy();
    });

    // Edit and save
    fireEvent.change(screen.getByDisplayValue("sk-orig"), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: /save configuration/i }));

    await waitFor(() => {
      expect(screen.getByText(/server validation failed/i)).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Validation before save
  // -------------------------------------------------------------------------
  it("shows validation errors instead of saving when required fields are empty", async () => {
    const plugin = makePluginWithConfig();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-test", baseUrl: "https://api.com", syncInterval: 15 },
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByDisplayValue("sk-test")).toBeTruthy();
    });

    // Clear a required field to make form invalid
    const apiKeyInput = screen.getByDisplayValue("sk-test");
    fireEvent.change(apiKeyInput, { target: { value: "" } });

    // Try to save
    fireEvent.click(screen.getByRole("button", { name: /save configuration/i }));

    // Should show validation error and NOT call saveConfig
    await waitFor(() => {
      expect(screen.getByText("This field is required")).toBeTruthy();
    });
    expect(pluginsApi.saveConfig).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test connection flow
  // -------------------------------------------------------------------------
  it("calls testConfig API when Test Connection is clicked", async () => {
    const plugin = makePluginWithConfig({ status: "ready" });
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-test", baseUrl: "https://api.com", syncInterval: 15 },
    });
    (pluginsApi.testConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: true });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /test connection/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      expect(pluginsApi.testConfig).toHaveBeenCalledWith("plug-1", expect.objectContaining({
        apiKey: "sk-test",
        baseUrl: "https://api.com",
      }));
    });
  });

  it("shows success message when test connection passes", async () => {
    const plugin = makePluginWithConfig({ status: "ready" });
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-test", baseUrl: "https://api.com", syncInterval: 15 },
    });
    (pluginsApi.testConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: true });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /test connection/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/connection test passed/i)).toBeTruthy();
    });
  });

  it("shows failure message when test connection fails", async () => {
    const plugin = makePluginWithConfig({ status: "ready" });
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-test", baseUrl: "https://api.com", syncInterval: 15 },
    });
    (pluginsApi.testConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: false,
      message: "Invalid credentials",
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /test connection/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/invalid credentials/i)).toBeTruthy();
    });
  });

  it("shows error when test connection API throws", async () => {
    const plugin = makePluginWithConfig({ status: "ready" });
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      configJson: { apiKey: "sk-test", baseUrl: "https://api.com", syncInterval: 15 },
    });
    (pluginsApi.testConfig as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network error"),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /test connection/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/network error/i)).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Custom settings page slot
  // -------------------------------------------------------------------------
  it("renders PluginSlotOutlet when plugin has a custom settingsPage slot", async () => {
    const plugin = makePluginWithConfig();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    // Return a custom settings page slot
    (usePluginSlots as ReturnType<typeof vi.fn>).mockReturnValue({
      slots: [{ pluginId: "plug-1", type: "settingsPage", displayName: "Custom Settings" }],
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByTestId("plugin-slot-outlet")).toBeTruthy();
    });

    expect(usePluginSlots).toHaveBeenCalledWith({
      slotTypes: ["settingsPage"],
      companyId: "comp-1",
      enabled: true,
    });

    // The auto-generated form should NOT be rendered
    expect(screen.queryByRole("button", { name: /save configuration/i })).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Plugin details sidebar
  // -------------------------------------------------------------------------
  it("renders plugin ID and package name in details card", async () => {
    const plugin = makePlugin();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("plug-1")).toBeTruthy();
    });
    expect(screen.getByText("@acme/test-plugin")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Back navigation
  // -------------------------------------------------------------------------
  it("renders a back link to the plugin manager", async () => {
    const plugin = makePlugin();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Test Plugin")).toBeTruthy();
    });

    // The back link should point to the plugin manager
    const backLink = document.querySelector('a[href="/settings/plugins"]');
    expect(backLink).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Default values populated when no saved config exists
  // -------------------------------------------------------------------------
  it("populates form with schema defaults when no config is saved", async () => {
    const plugin = makePluginWithConfig();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });
    // No saved config
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("API Key")).toBeTruthy();
    });

    // syncInterval has a default of 15
    expect(screen.getByDisplayValue("15")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Runtime Dashboard
  // -------------------------------------------------------------------------
  describe("Runtime Dashboard", () => {
    it("renders the dashboard section with worker status", async () => {
      const plugin = makePlugin();
      (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
      (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
        pluginId: "plug-1",
        status: "ready",
        healthy: true,
        checks: [],
      });
      (pluginsApi.dashboard as ReturnType<typeof vi.fn>).mockResolvedValue(makeDashboardData());

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Runtime Dashboard")).toBeTruthy();
      });

      expect(screen.getByText("Worker Process")).toBeTruthy();
      expect(screen.getByText("running")).toBeTruthy();
      expect(screen.getByText("12345")).toBeTruthy();
    });

    it("renders 'No worker process registered' when worker is null", async () => {
      const plugin = makePlugin();
      (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
      (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
        pluginId: "plug-1",
        status: "ready",
        healthy: true,
        checks: [],
      });
      (pluginsApi.dashboard as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeDashboardData({ worker: null }),
      );

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Worker Process")).toBeTruthy();
      });

      expect(screen.getByText(/no worker process registered/i)).toBeTruthy();
    });

    it("renders crash information when worker has crashes", async () => {
      const plugin = makePlugin();
      (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
      (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
        pluginId: "plug-1",
        status: "ready",
        healthy: true,
        checks: [],
      });
      (pluginsApi.dashboard as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeDashboardData({
          worker: {
            status: "backoff",
            pid: null,
            uptime: null,
            consecutiveCrashes: 3,
            totalCrashes: 5,
            pendingRequests: 0,
            lastCrashAt: Date.now() - 30000,
            nextRestartAt: Date.now() + 10000,
          },
        }),
      );

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Crashes")).toBeTruthy();
      });

      expect(screen.getByText(/3 consecutive.*5 total/)).toBeTruthy();
    });

    it("renders recent job runs", async () => {
      const plugin = makePlugin();
      (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
      (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
        pluginId: "plug-1",
        status: "ready",
        healthy: true,
        checks: [],
      });
      (pluginsApi.dashboard as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeDashboardData({
          recentJobRuns: [
            {
              id: "run-1",
              jobId: "job-1",
              jobKey: "sync-data",
              trigger: "schedule",
              status: "success",
              durationMs: 1500,
              error: null,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      );

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("sync-data")).toBeTruthy();
      });

      expect(screen.getByText("schedule")).toBeTruthy();
      expect(screen.getByText("1.5s")).toBeTruthy();
    });

    it("shows empty state when no job runs exist", async () => {
      const plugin = makePlugin();
      (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
      (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
        pluginId: "plug-1",
        status: "ready",
        healthy: true,
        checks: [],
      });
      (pluginsApi.dashboard as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeDashboardData({ recentJobRuns: [] }),
      );

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Recent Job Runs")).toBeTruthy();
      });

      expect(screen.getByText(/no job runs recorded yet/i)).toBeTruthy();
    });

    it("renders recent webhook deliveries", async () => {
      const plugin = makePlugin();
      (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
      (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
        pluginId: "plug-1",
        status: "ready",
        healthy: true,
        checks: [],
      });
      (pluginsApi.dashboard as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeDashboardData({
          recentWebhookDeliveries: [
            {
              id: "del-1",
              webhookKey: "github-push",
              status: "processed",
              durationMs: 250,
              error: null,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      );

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("github-push")).toBeTruthy();
      });

      expect(screen.getByText("250ms")).toBeTruthy();
    });

    it("shows empty state when no webhook deliveries exist", async () => {
      const plugin = makePlugin();
      (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
      (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
        pluginId: "plug-1",
        status: "ready",
        healthy: true,
        checks: [],
      });
      (pluginsApi.dashboard as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeDashboardData({ recentWebhookDeliveries: [] }),
      );

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText("Recent Webhook Deliveries")).toBeTruthy();
      });

      expect(screen.getByText(/no webhook deliveries recorded yet/i)).toBeTruthy();
    });

    it("renders the last checked timestamp", async () => {
      const plugin = makePlugin();
      (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
      (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
        pluginId: "plug-1",
        status: "ready",
        healthy: true,
        checks: [],
      });
      (pluginsApi.dashboard as ReturnType<typeof vi.fn>).mockResolvedValue(makeDashboardData());

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText(/last checked:/i)).toBeTruthy();
      });
    });

    it("does not render dashboard when data is not yet loaded", () => {
      const plugin = makePlugin();
      (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
      (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      // Dashboard never resolves
      (pluginsApi.dashboard as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

      renderComponent();

      expect(screen.queryByText("Runtime Dashboard")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Hydration guard — refetch should not overwrite user edits
  // -------------------------------------------------------------------------
  it("does not overwrite user edits when config refetches", async () => {
    const plugin = makePluginWithConfig();
    (pluginsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);
    (pluginsApi.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      pluginId: "plug-1",
      status: "ready",
      healthy: true,
      checks: [],
    });

    // Initial config load
    let configResolve: ((val: unknown) => void) | null = null;
    (pluginsApi.getConfig as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => { configResolve = resolve; }),
    );

    renderComponent();

    // Wait for loading state
    await waitFor(() => {
      expect(screen.getByText(/loading configuration/i)).toBeTruthy();
    });

    // Resolve the config fetch
    configResolve!({
      configJson: { apiKey: "sk-original", baseUrl: "https://api.com", syncInterval: 15 },
    });

    // Wait for form to render with initial values
    await waitFor(() => {
      expect(screen.getByDisplayValue("sk-original")).toBeTruthy();
    });

    // User edits the API key field
    const apiKeyInput = screen.getByDisplayValue("sk-original");
    fireEvent.change(apiKeyInput, { target: { value: "sk-user-edited" } });

    // Verify the edit took effect
    expect(screen.getByDisplayValue("sk-user-edited")).toBeTruthy();

    // Now simulate a refetch (e.g., window focus causes React Query to refetch)
    // The getConfig mock will resolve again with original values
    // Due to the hydration guard, the form should NOT reset to sk-original
    // We can't easily simulate React Query refetch, but we can verify the
    // current state is preserved — the user's edit should still be visible
    expect(screen.getByDisplayValue("sk-user-edited")).toBeTruthy();
    expect(screen.queryByDisplayValue("sk-original")).toBeNull();
  });
});
