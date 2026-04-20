/**
 * Plugin bridge initialization.
 *
 * Registers the host's React instances and bridge hook implementations
 * on a global object so that the plugin module loader can inject them
 * into plugin UI bundles at load time.
 *
 * Call `initPluginBridge()` once during app startup (in `main.tsx`), before
 * any plugin UI modules are loaded.
 *
 * @see PLUGIN_SPEC.md §19.0.1 — Plugin UI SDK
 * @see PLUGIN_SPEC.md §19.0.2 — Bundle Isolation
 */

import {
  usePluginData,
  usePluginAction,
  useHostContext,
  usePluginStream,
  usePluginToast,
} from "./bridge.js";

// ---------------------------------------------------------------------------
// Global bridge registry
// ---------------------------------------------------------------------------

/**
 * i18n bridge interface exposed to plugins.
 *
 * Provides read-only access to the host's i18next singleton so that
 * plugins can translate their own UI strings and react to language changes.
 *
 * @see docs/paperclip-analysis/15-i18n-architecture-design.md §3 — i18n 컨벤션
 */
export interface PluginI18nBridge {
  /**
   * Translate a key. Falls back to defaultValue or key itself.
   * Intentionally narrowed from i18next TFunction — plugins get a simple
   * string-in/string-out contract without returnObjects/returnDetails.
   */
  t: (key: string, defaultValueOrOptions?: string | Record<string, unknown>) => string;
  /** Current active language code (e.g., "en", "ko"). */
  language: () => string;
  /** List of all loaded language codes. */
  languages: () => readonly string[];
  /** Subscribe to language changes. Returns unsubscribe function. */
  onLanguageChanged: (callback: (lng: string) => void) => () => void;
}

/**
 * The global bridge registry shape.
 *
 * This is placed on `globalThis.__paperclipPluginBridge__` and consumed by
 * the plugin module loader to provide implementations for external imports.
 */
export interface PluginBridgeRegistry {
  react: unknown;
  reactDom: unknown;
  sdkUi: Record<string, unknown>;
  /** i18n bridge — available when host has i18next initialized. */
  i18n?: PluginI18nBridge;
}

declare global {
  // eslint-disable-next-line no-var
  var __paperclipPluginBridge__: PluginBridgeRegistry | undefined;
}

/**
 * Initialize the plugin bridge global registry.
 *
 * Registers the host's React, ReactDOM, SDK UI bridge implementations,
 * and i18n bridge on `globalThis.__paperclipPluginBridge__` so the plugin
 * module loader can provide them to plugin bundles.
 *
 * @param react - The host's React module
 * @param reactDom - The host's ReactDOM module
 * @param i18next - Optional i18next instance for plugin i18n support
 */
export function initPluginBridge(
  react: typeof import("react"),
  reactDom: typeof import("react-dom"),
  i18next?: typeof import("i18next").default,
): void {
  const i18nBridge: PluginI18nBridge | undefined = i18next
    ? {
        t: (key: string, defaultValueOrOptions?: string | Record<string, unknown>) => {
          const opts = typeof defaultValueOrOptions === "string"
            ? { defaultValue: defaultValueOrOptions }
            : defaultValueOrOptions;
          return i18next.t(key, opts) as string;
        },
        language: () => i18next.language,
        languages: () => i18next.languages,
        onLanguageChanged: (callback: (lng: string) => void) => {
          i18next.on("languageChanged", callback);
          return () => {
            i18next.off("languageChanged", callback);
          };
        },
      }
    : undefined;

  globalThis.__paperclipPluginBridge__ = {
    react,
    reactDom,
    sdkUi: {
      usePluginData,
      usePluginAction,
      useHostContext,
      usePluginStream,
      usePluginToast,
    },
    i18n: i18nBridge,
  };
}
