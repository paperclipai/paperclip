import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES } from "../constants.js";
import { resolveDeclaredSandboxCapabilities } from "../environment-support.js";
import { pluginManagedRoutineDeclarationSchema, pluginManifestV1Schema, pluginUiSlotDeclarationSchema } from "./plugin.js";

function buildSandboxProviderManifest(driver: Record<string, unknown>) {
  return {
    id: "paperclip.capability-provider",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Capability Provider",
    description: "Sandbox provider that declares fine-grained capabilities.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["environment.drivers.register"],
    entrypoints: { worker: "./dist/worker.js" },
    environmentDrivers: [
      {
        driverKey: "capability-provider",
        kind: "sandbox_provider",
        displayName: "Capability Provider",
        configSchema: { type: "object" },
        ...driver,
      },
    ],
  };
}

describe("plugin capability constants", () => {
  it("exposes each capability once", () => {
    expect(new Set(PLUGIN_CAPABILITIES).size).toBe(PLUGIN_CAPABILITIES.length);
  });
});

describe("plugin manifest validators", () => {
  it("accepts existing-style plugins that do not request access or authorization capabilities", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "paperclip.compat-dashboard",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Compat Dashboard",
      description: "Dashboard-only plugin without access or authorization host APIs.",
      author: "Paperclip",
      categories: ["ui"],
      capabilities: ["ui.dashboardWidget.register"],
      entrypoints: {
        worker: "./dist/worker.js",
        ui: "./dist/ui.js",
      },
      ui: {
        slots: [
          {
            type: "dashboardWidget",
            id: "compat-dashboard",
            displayName: "Compat Dashboard",
            exportName: "CompatDashboard",
          },
        ],
      },
    });

    expect(parsed.capabilities).toEqual(["ui.dashboardWidget.register"]);
  });

  it("accepts sandbox provider template config bindings", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "paperclip.template-provider",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Template Provider",
      description: "Sandbox provider with captured template config binding.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["environment.drivers.register"],
      entrypoints: { worker: "./dist/worker.js" },
      environmentDrivers: [
        {
          driverKey: "template-provider",
          kind: "sandbox_provider",
          displayName: "Template Provider",
          supportsTemplateCapture: true,
          templateRefKind: "provider_template",
          templateConfigBinding: {
            field: "templateId",
            unsetFields: ["image"],
          },
          configSchema: { type: "object" },
        },
      ],
    });

    expect(parsed.environmentDrivers?.[0]?.templateConfigBinding).toEqual({
      field: "templateId",
      unsetFields: ["image"],
    });
  });

  it("rejects template config bindings that replace provider identity", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      id: "paperclip.bad-template-provider",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Bad Template Provider",
      categories: ["automation"],
      capabilities: ["environment.drivers.register"],
      entrypoints: { worker: "./dist/worker.js" },
      environmentDrivers: [
        {
          driverKey: "bad-template-provider",
          kind: "sandbox_provider",
          displayName: "Bad Template Provider",
          templateConfigBinding: {
            field: "provider",
          },
          configSchema: { type: "object" },
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("provider key"))).toBe(true);
  });
});

describe("plugin managed routine validators", () => {
  it("accepts core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.parse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      activityGatePolicy: "require_external_activity",
      activityGateScope: "project",
      issueTemplate: { surfaceVisibility: "default" },
    });

    expect(parsed.issueTemplate?.surfaceVisibility).toBe("default");
    expect(parsed.activityGatePolicy).toBe("require_external_activity");
    expect(parsed.activityGateScope).toBe("project");
  });

  it("rejects non-core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.safeParse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      issueTemplate: { surfaceVisibility: "normal" },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("plugin managed skill validators", () => {
  const baseManifest = {
    id: "paperclip.test-managed-skills",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Skills",
    description: "Managed skills test plugin.",
    author: "Paperclip",
    categories: ["automation"],
    entrypoints: { worker: "./dist/worker.js" },
  } as const;

  it("requires skills.managed when managed skills are declared", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: [],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("skills.managed"))).toBe(true);
  });

  it("accepts managed skills with the skills.managed capability", () => {
    const parsed = pluginManifestV1Schema.parse({
      ...baseManifest,
      capabilities: ["skills.managed"],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.skills?.[0]?.skillKey).toBe("wiki-maintainer");
  });
});

describe("plugin UI slot validators", () => {
  it("accepts route-scoped sidebar slots with a routePath", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "routeSidebar",
      id: "wiki-route-sidebar",
      displayName: "Wiki Sidebar",
      exportName: "WikiSidebar",
      routePath: "wiki",
    });

    expect(parsed.routePath).toBe("wiki");
  });

  it("requires route-scoped sidebar slots to declare a routePath", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "routeSidebar",
      id: "wiki-route-sidebar",
      displayName: "Wiki Sidebar",
      exportName: "WikiSidebar",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toBe("routeSidebar slots require routePath");
  });

  it("keeps reserved company route protection for route-scoped sidebars", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "routeSidebar",
      id: "settings-route-sidebar",
      displayName: "Settings Sidebar",
      exportName: "SettingsSidebar",
      routePath: "settings",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("reserved by the host"))).toBe(true);
  });

  it("accepts workspace entity types as detailTab targets", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "detailTab",
      id: "workspace-diff-viewer",
      displayName: "Diff",
      exportName: "WorkspaceDiffViewer",
      entityTypes: ["execution_workspace", "project_workspace"],
    });

    expect(parsed.entityTypes).toEqual(["execution_workspace", "project_workspace"]);
  });

  it("accepts execution_workspace as a toolbarButton entityType", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "toolbarButton",
      id: "workspace-open-diff",
      displayName: "Open diff",
      exportName: "OpenWorkspaceDiffButton",
      entityTypes: ["execution_workspace"],
    });

    expect(parsed.entityTypes).toEqual(["execution_workspace"]);
  });

  it("accepts company settings page slots with a non-core settings route", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "companySettingsPage",
      id: "permissions-settings",
      displayName: "Permissions",
      exportName: "PermissionsSettingsPage",
      routePath: "permissions",
    });

    expect(parsed.routePath).toBe("permissions");
  });

  it("prevents company settings page slots from shadowing core settings routes", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "companySettingsPage",
      id: "instance-settings",
      displayName: "Instance",
      exportName: "InstanceSettingsPage",
      routePath: "instance",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("reserved by the host"))).toBe(true);
  });
});

describe("sandbox provider capability declaration validators", () => {
  it("test_manifest_accepts_sandbox_capabilities_and_rejects_unknown_capability_keys", () => {
    const parsed = pluginManifestV1Schema.parse(
      buildSandboxProviderManifest({
        sandboxCapabilities: {
          reusableLeases: true,
          nativeSyncIn: true,
          nativeSyncOut: false,
          persistentProcessSessions: true,
          independentControlCommands: false,
          incrementalSessionOutput: true,
        },
      }),
    );

    expect(parsed.environmentDrivers?.[0]?.sandboxCapabilities).toEqual({
      reusableLeases: true,
      nativeSyncIn: true,
      nativeSyncOut: false,
      persistentProcessSessions: true,
      independentControlCommands: false,
      incrementalSessionOutput: true,
    });

    const rejected = pluginManifestV1Schema.safeParse(
      buildSandboxProviderManifest({
        sandboxCapabilities: {
          reusableLeases: true,
          // A typo or unknown capability name must fail validation, not drop
          // silently. The nested schema is `.strict()`.
          nativeSync: true,
        },
      }),
    );

    expect(rejected.success).toBe(false);
  });

  it("test_removed_concurrency_capabilities_are_rejected_as_unknown_keys", () => {
    // The concurrency flags left the public contract because no runtime path
    // enforced them. The strict schema now rejects them, so a manifest cannot
    // declare a capability the host does not honor.
    for (const key of ["concurrentSyncAndExec", "concurrentSyncOperations"]) {
      const rejected = pluginManifestV1Schema.safeParse(
        buildSandboxProviderManifest({
          sandboxCapabilities: { [key]: true },
        }),
      );
      expect(rejected.success).toBe(false);
    }
  });

  it("test_supports_reusable_leases_compat_maps_to_reusable_leases", () => {
    const parsed = pluginManifestV1Schema.parse(
      buildSandboxProviderManifest({ supportsReusableLeases: true }),
    );
    const driver = parsed.environmentDrivers?.[0];

    expect(driver?.sandboxCapabilities).toBeUndefined();
    expect(resolveDeclaredSandboxCapabilities(driver!).reusableLeases).toBe(true);
  });

  it("test_sandbox_capabilities_reusable_leases_wins_over_compat_field", () => {
    const parsed = pluginManifestV1Schema.parse(
      buildSandboxProviderManifest({
        supportsReusableLeases: true,
        sandboxCapabilities: { reusableLeases: false },
      }),
    );
    const driver = parsed.environmentDrivers?.[0];

    // The nested declaration wins over the legacy compat flag when both exist.
    expect(resolveDeclaredSandboxCapabilities(driver!).reusableLeases).toBe(false);
  });
});
