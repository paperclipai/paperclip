/**
 * PluginCapabilityValidator — enforces the capability model at both
 * install-time and runtime.
 *
 * Every plugin declares the capabilities it requires in its manifest
 * (`manifest.capabilities`). This service checks those declarations
 * against a mapping of operations → required capabilities so that:
 *
 * 1. **Install-time validation** — `validateManifestCapabilities()`
 *    ensures that declared features (tools, jobs, webhooks, UI slots)
 *    have matching capability entries, giving operators clear feedback
 *    before a plugin is activated.
 *
 * 2. **Runtime gating** — `checkOperation()` / `assertOperation()` are
 *    called on every worker→host bridge call to enforce least-privilege
 *    access. If a plugin attempts an operation it did not declare, the
 *    call is rejected with a 403 error.
 *
 * @see PLUGIN_SPEC.md §15 — Capability Model
 * @see host-client-factory.ts — SDK-side capability gating
 */
import type {
  PluginCapability,
  PaperclipPluginManifestV1,
  PluginUiSlotType,
  PluginLauncherPlacementZone,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Capability requirement mappings
// ---------------------------------------------------------------------------

/**
 * Maps high-level operations to the capabilities they require.
 *
 * When the bridge receives a call from a plugin worker, the host looks up
 * the operation in this map and checks the plugin's declared capabilities.
 * If any required capability is missing, the call is rejected.
 *
 * @see PLUGIN_SPEC.md §15 — Capability Model
 */
const OPERATION_CAPABILITIES: Record<string, readonly PluginCapability[]> = {
  // Data read operations
  "companies.list": ["companies.read"],
  "companies.get": ["companies.read"],
  "projects.list": ["projects.read"],
  "projects.get": ["projects.read"],
  "project.workspaces.list": ["project.workspaces.read"],
  "project.workspaces.get": ["project.workspaces.read"],
  "issues.list": ["issues.read"],
  "issues.get": ["issues.read"],
  "issue.comments.list": ["issue.comments.read"],
  "issue.comments.get": ["issue.comments.read"],
  "agents.list": ["agents.read"],
  "agents.get": ["agents.read"],
  "goals.list": ["goals.read"],
  "goals.get": ["goals.read"],
  "activity.list": ["activity.read"],
  "activity.get": ["activity.read"],
  "costs.list": ["costs.read"],
  "costs.get": ["costs.read"],

  // Data write operations
  "issues.create": ["issues.create"],
  "issues.update": ["issues.update"],
  "issue.comments.create": ["issue.comments.create"],
  "activity.log": ["activity.log.write"],
  "metrics.write": ["metrics.write"],

  // Plugin state operations
  "plugin.state.get": ["plugin.state.read"],
  "plugin.state.list": ["plugin.state.read"],
  "plugin.state.set": ["plugin.state.write"],
  "plugin.state.delete": ["plugin.state.write"],

  // Runtime / Integration operations
  "events.subscribe": ["events.subscribe"],
  "events.emit": ["events.emit"],
  "jobs.schedule": ["jobs.schedule"],
  "jobs.cancel": ["jobs.schedule"],
  "webhooks.receive": ["webhooks.receive"],
  "http.request": ["http.outbound"],
  "secrets.resolve": ["secrets.read-ref"],

  // Agent tools
  "agent.tools.register": ["agent.tools.register"],
  "agent.tools.execute": ["agent.tools.register"],
};

/**
 * Maps UI slot types to the capability required to register them.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 */
const UI_SLOT_CAPABILITIES: Record<PluginUiSlotType, PluginCapability> = {
  sidebar: "ui.sidebar.register",
  sidebarPanel: "ui.sidebar.register",
  projectSidebarItem: "ui.sidebar.register",
  page: "ui.page.register",
  detailTab: "ui.detailTab.register",
  taskDetailView: "ui.detailTab.register",
  dashboardWidget: "ui.dashboardWidget.register",
  globalToolbarButton: "ui.action.register",
  toolbarButton: "ui.action.register",
  contextMenuItem: "ui.action.register",
  commentAnnotation: "ui.commentAnnotation.register",
  commentContextMenuItem: "ui.action.register",
  settingsPage: "instance.settings.register",
};

/**
 * Launcher placement zones align with host UI surfaces and therefore inherit
 * the same capability requirements as the equivalent slot type.
 */
const LAUNCHER_PLACEMENT_CAPABILITIES: Record<
  PluginLauncherPlacementZone,
  PluginCapability
> = {
  page: "ui.page.register",
  detailTab: "ui.detailTab.register",
  taskDetailView: "ui.detailTab.register",
  dashboardWidget: "ui.dashboardWidget.register",
  sidebar: "ui.sidebar.register",
  sidebarPanel: "ui.sidebar.register",
  projectSidebarItem: "ui.sidebar.register",
  globalToolbarButton: "ui.action.register",
  toolbarButton: "ui.action.register",
  contextMenuItem: "ui.action.register",
  commentAnnotation: "ui.commentAnnotation.register",
  commentContextMenuItem: "ui.action.register",
  settingsPage: "instance.settings.register",
};

/**
 * Maps feature declarations in the manifest to their required capabilities.
 */
const FEATURE_CAPABILITIES: Record<string, PluginCapability> = {
  tools: "agent.tools.register",
  jobs: "jobs.schedule",
  webhooks: "webhooks.receive",
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Result of a capability check. When `allowed` is false, `missing` contains
 * the capabilities that the plugin does not declare but the operation requires.
 */
export interface CapabilityCheckResult {
  allowed: boolean;
  missing: PluginCapability[];
  operation?: string;
  pluginId?: string;
}

// ---------------------------------------------------------------------------
// PluginCapabilityValidator interface
// ---------------------------------------------------------------------------

export interface PluginCapabilityValidator {
  /**
   * Check whether a plugin has a specific capability.
   */
  hasCapability(
    manifest: PaperclipPluginManifestV1,
    capability: PluginCapability,
  ): boolean;

  /**
   * Check whether a plugin has all of the specified capabilities.
   */
  hasAllCapabilities(
    manifest: PaperclipPluginManifestV1,
    capabilities: PluginCapability[],
  ): CapabilityCheckResult;

  /**
   * Check whether a plugin has at least one of the specified capabilities.
   */
  hasAnyCapability(
    manifest: PaperclipPluginManifestV1,
    capabilities: PluginCapability[],
  ): boolean;

  /**
   * Check whether a plugin is allowed to perform the named operation.
   *
   * Operations are mapped to required capabilities via OPERATION_CAPABILITIES.
   * Unknown operations are rejected by default.
   */
  checkOperation(
    manifest: PaperclipPluginManifestV1,
    operation: string,
  ): CapabilityCheckResult;

  /**
   * Assert that a plugin is allowed to perform an operation.
   * Throws a 403 HttpError if the capability check fails.
   */
  assertOperation(
    manifest: PaperclipPluginManifestV1,
    operation: string,
  ): void;

  /**
   * Assert that a plugin has a specific capability.
   * Throws a 403 HttpError if the capability is missing.
   */
  assertCapability(
    manifest: PaperclipPluginManifestV1,
    capability: PluginCapability,
  ): void;

  /**
   * Check whether a plugin can register the given UI slot type.
   */
  checkUiSlot(
    manifest: PaperclipPluginManifestV1,
    slotType: PluginUiSlotType,
  ): CapabilityCheckResult;

  /**
   * Validate that a manifest's declared capabilities are consistent with its
   * declared features (tools, jobs, webhooks, UI slots).
   *
   * Returns all missing capabilities rather than failing on the first one.
   * This is useful for install-time validation to give comprehensive feedback.
   */
  validateManifestCapabilities(
    manifest: PaperclipPluginManifestV1,
  ): CapabilityCheckResult;

  /**
   * Get the capabilities required for a named operation.
   * Returns an empty array if the operation is unknown.
   */
  getRequiredCapabilities(operation: string): readonly PluginCapability[];

  /**
   * Get the capability required for a UI slot type.
   */
  getUiSlotCapability(slotType: PluginUiSlotType): PluginCapability;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a PluginCapabilityValidator.
 *
 * This service enforces capability gates for plugin operations.  The host
 * uses it to verify that a plugin's declared capabilities permit the
 * operation it is attempting, both at install time (manifest validation)
 * and at runtime (bridge call gating).
 *
 * Usage:
 * ```ts
 * const validator = pluginCapabilityValidator();
 *
 * // Runtime: gate a bridge call
 * validator.assertOperation(plugin.manifestJson, "issues.create");
 *
 * // Install time: validate manifest consistency
 * const result = validator.validateManifestCapabilities(manifest);
 * if (!result.allowed) {
 *   throw badRequest("Missing capabilities", result.missing);
 * }
 * ```
 */
export function pluginCapabilityValidator(): PluginCapabilityValidator {
  const log = logger.child({ service: "plugin-capability-validator" });

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  function capabilitySet(manifest: PaperclipPluginManifestV1): Set<PluginCapability> {
    return new Set(manifest.capabilities);
  }

  function buildForbiddenMessage(
    manifest: PaperclipPluginManifestV1,
    operation: string,
    missing: PluginCapability[],
  ): string {
    return (
      `Plugin '${manifest.id}' is not allowed to perform '${operation}'. ` +
      `Missing required capabilities: ${missing.join(", ")}`
    );
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    hasCapability(manifest, capability) {
      return manifest.capabilities.includes(capability);
    },

    hasAllCapabilities(manifest, capabilities) {
      const declared = capabilitySet(manifest);
      const missing = capabilities.filter((cap) => !declared.has(cap));
      return {
        allowed: missing.length === 0,
        missing,
        pluginId: manifest.id,
      };
    },

    hasAnyCapability(manifest, capabilities) {
      const declared = capabilitySet(manifest);
      return capabilities.some((cap) => declared.has(cap));
    },

    checkOperation(manifest, operation) {
      const required = OPERATION_CAPABILITIES[operation];

      if (!required) {
        log.warn(
          { pluginId: manifest.id, operation },
          "capability check for unknown operation – rejecting by default",
        );
        return {
          allowed: false,
          missing: [],
          operation,
          pluginId: manifest.id,
        };
      }

      const declared = capabilitySet(manifest);
      const missing = required.filter((cap) => !declared.has(cap));

      if (missing.length > 0) {
        log.debug(
          { pluginId: manifest.id, operation, missing },
          "capability check failed",
        );
      }

      return {
        allowed: missing.length === 0,
        missing,
        operation,
        pluginId: manifest.id,
      };
    },

    assertOperation(manifest, operation) {
      const result = this.checkOperation(manifest, operation);
      if (!result.allowed) {
        const msg = result.missing.length > 0
          ? buildForbiddenMessage(manifest, operation, result.missing)
          : `Plugin '${manifest.id}' attempted unknown operation '${operation}'`;
        throw forbidden(msg);
      }
    },

    assertCapability(manifest, capability) {
      if (!this.hasCapability(manifest, capability)) {
        throw forbidden(
          `Plugin '${manifest.id}' lacks required capability '${capability}'`,
        );
      }
    },

    checkUiSlot(manifest, slotType) {
      const required = UI_SLOT_CAPABILITIES[slotType];
      if (!required) {
        return {
          allowed: false,
          missing: [],
          operation: `ui.${slotType}.register`,
          pluginId: manifest.id,
        };
      }

      const has = manifest.capabilities.includes(required);
      return {
        allowed: has,
        missing: has ? [] : [required],
        operation: `ui.${slotType}.register`,
        pluginId: manifest.id,
      };
    },

    validateManifestCapabilities(manifest) {
      const declared = capabilitySet(manifest);
      const allMissing: PluginCapability[] = [];

      // Check feature declarations → required capabilities
      for (const [feature, requiredCap] of Object.entries(FEATURE_CAPABILITIES)) {
        const featureValue = manifest[feature as keyof PaperclipPluginManifestV1];
        if (Array.isArray(featureValue) && featureValue.length > 0) {
          if (!declared.has(requiredCap)) {
            allMissing.push(requiredCap);
          }
        }
      }

      // Check UI slots → required capabilities
      const uiSlots = manifest.ui?.slots ?? [];
      if (uiSlots.length > 0) {
        for (const slot of uiSlots) {
          const requiredCap = UI_SLOT_CAPABILITIES[slot.type];
          if (requiredCap && !declared.has(requiredCap)) {
            if (!allMissing.includes(requiredCap)) {
              allMissing.push(requiredCap);
            }
          }
        }
      }

      // Check launcher declarations → required capabilities
      const launchers = [
        ...(manifest.launchers ?? []),
        ...(manifest.ui?.launchers ?? []),
      ];
      if (launchers.length > 0) {
        for (const launcher of launchers) {
          const requiredCap = LAUNCHER_PLACEMENT_CAPABILITIES[launcher.placementZone];
          if (requiredCap && !declared.has(requiredCap) && !allMissing.includes(requiredCap)) {
            allMissing.push(requiredCap);
          }
        }
      }

      return {
        allowed: allMissing.length === 0,
        missing: allMissing,
        pluginId: manifest.id,
      };
    },

    getRequiredCapabilities(operation) {
      return OPERATION_CAPABILITIES[operation] ?? [];
    },

    getUiSlotCapability(slotType) {
      return UI_SLOT_CAPABILITIES[slotType];
    },
  };
}
