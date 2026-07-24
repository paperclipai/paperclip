import { describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
  getCompanySettings: vi.fn(),
  upsertCompanySettings: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { buildHostServices } from "../services/plugin-host-services.js";

const pluginId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

// Shape mirrors createEventBusStub in plugin-access-authorization-host-services.test.ts:22.
function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
        clear: vi.fn(),
      };
    },
  } as never;
}

function build() {
  // buildHostServices only *captures* db in service factories; no query runs
  // until a service method is invoked, so an empty object is sufficient here.
  return buildHostServices({} as never, pluginId, "paperclip.example", createEventBusStub());
}

const localFoldersManifest = {
  id: "paperclip.example",
  apiVersion: 1 as const,
  version: "0.1.0",
  displayName: "Example",
  description: "Fixture plugin for the local-folders gate-ordering test",
  author: "Paperclip",
  categories: ["automation" as const],
  capabilities: ["local.folders" as const],
  entrypoints: { worker: "./dist/worker.js" },
  localFolders: [
    {
      folderKey: "docs",
      displayName: "Docs root",
      access: "readWrite" as const,
    },
  ],
};

function buildWithLocalFolders() {
  return buildHostServices(
    {} as never,
    pluginId,
    "paperclip.example",
    createEventBusStub(),
    undefined,
    { manifest: localFoldersManifest },
  );
}

describe("host services per-company enablement gate", () => {
  it("rejects company-scoped host calls when the plugin is disabled for the company", async () => {
    mockRegistry.getById.mockResolvedValue({ id: pluginId, manifestJson: {} });
    mockRegistry.getCompanySettings.mockResolvedValue({ enabled: false });
    const services = build();

    await expect(services.config.get({ companyId })).rejects.toMatchObject({
      status: 403,
      details: { code: "plugin_not_enabled_for_company" },
    });
    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
    services.dispose();
  });

  it("allows company-scoped host calls when no settings row exists (default on)", async () => {
    mockRegistry.getById.mockResolvedValue({ id: pluginId, manifestJson: {} });
    mockRegistry.getCompanySettings.mockResolvedValue(null);
    mockRegistry.getConfig.mockResolvedValue({ configJson: { greeting: "hi" } });
    const services = build();

    await expect(services.config.get({ companyId })).resolves.toEqual({ greeting: "hi" });
    expect(mockRegistry.getCompanySettings).toHaveBeenCalledWith(pluginId, companyId);
    services.dispose();
  });

  it('respects manifest default "off" when no settings row exists', async () => {
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      manifestJson: { companyEnablement: { default: "off" } },
    });
    mockRegistry.getCompanySettings.mockResolvedValue(null);
    const services = build();

    await expect(services.config.get({ companyId })).rejects.toMatchObject({ status: 403 });
    services.dispose();
  });

  // Extra verification (prior review): plugin-host-services.ts's localFolders.configure
  // upserts plugin_company_settings with `enabled: existing?.enabled ?? true` — a
  // company-disabled plugin must never reach that upsert. Prove the gate runs first by
  // driving configure() with the plugin disabled and asserting upsertCompanySettings
  // (and the pre-upsert getCompanySettings read at plugin-host-services.ts:1079) never ran.
  it("rejects localFolders.configure before touching plugin_company_settings when the plugin is disabled", async () => {
    vi.clearAllMocks(); // isolate the call-count assertions below from earlier tests in this file
    mockRegistry.getById.mockResolvedValue({ id: pluginId, manifestJson: {} });
    mockRegistry.getCompanySettings.mockResolvedValue({ enabled: false });
    const services = buildWithLocalFolders();

    await expect(
      services.localFolders.configure({
        companyId,
        folderKey: "docs",
        path: "/tmp/does-not-matter",
        access: "readWrite",
      }),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "plugin_not_enabled_for_company" },
    });

    // The only permitted read is the gate's own enablement check; configure()'s
    // subsequent `existing = await registry.getCompanySettings(...)` read (line 1079)
    // must not run, and the upsert (line 1104) must never be reached.
    expect(mockRegistry.getCompanySettings).toHaveBeenCalledTimes(1);
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
    services.dispose();
  });
});
