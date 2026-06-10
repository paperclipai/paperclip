import type { UIAdapterModule } from "./types";
import { acpxLocalUIAdapter } from "./acpx-local";
import { claudeLocalUIAdapter } from "./claude-local";
import { codexLocalUIAdapter } from "./codex-local";
import { cursorCloudUIAdapter } from "./cursor-cloud";
import { cursorLocalUIAdapter } from "./cursor";
import { geminiLocalUIAdapter } from "./gemini-local";
import { grokLocalUIAdapter } from "./grok-local";
import { openCodeLocalUIAdapter } from "./opencode-local";
import { piLocalUIAdapter } from "./pi-local";
import { openClawGatewayUIAdapter } from "./openclaw-gateway";
import { hermesLocalUIAdapter } from "./hermes-local";
import { processUIAdapter } from "./process";
import { httpUIAdapter } from "./http";
import { loadDynamicParser, invalidateDynamicParser, setDynamicParserResultNotifier } from "./dynamic-loader";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "./schema-config-fields";

const uiAdapters: UIAdapterModule[] = [];
const adaptersByType = new Map<string, UIAdapterModule>();

// Types registered at module load time — allowed to be overridden by
// external adapters that ship their own ui-parser.js via the server.
const builtinTypes = new Set<string>();

// Original builtin adapters stored for restoration when external overrides
// are deactivated or removed.
const builtinAdaptersByType = new Map<string, UIAdapterModule>();

// Tracks which builtin types currently have an active external override.
const activeExternalOverrides = new Set<string>();

// Generation counter to discard stale dynamic parser loads. When an override
// is deactivated while a load is in-flight, the generation is bumped and the
// stale result is discarded in its .then() handler.
const overrideGeneration = new Map<string, number>();

// Subscriber list — components can register to be notified when adapters change
// (e.g., when a dynamic parser replaces a placeholder).
const adapterChangeListeners = new Set<() => void>();

/** Subscribe to adapter registry changes. Returns unsubscribe function. */
export function onAdapterChange(fn: () => void): () => void {
  adapterChangeListeners.add(fn);
  return () => adapterChangeListeners.delete(fn);
}

function notifyAdapterChange(): void {
  for (const fn of adapterChangeListeners) fn();
}

setDynamicParserResultNotifier(notifyAdapterChange);

function registerBuiltInUIAdapters() {
  for (const adapter of [
    acpxLocalUIAdapter,
    claudeLocalUIAdapter,
    codexLocalUIAdapter,
    cursorCloudUIAdapter,
    geminiLocalUIAdapter,
    grokLocalUIAdapter,
    hermesLocalUIAdapter,
    openCodeLocalUIAdapter,
    piLocalUIAdapter,
    cursorLocalUIAdapter,
    openClawGatewayUIAdapter,
    processUIAdapter,
    httpUIAdapter,
  ]) {
    builtinTypes.add(adapter.type);
    builtinAdaptersByType.set(adapter.type, adapter);
    registerUIAdapter(adapter);
  }
}

export function registerUIAdapter(adapter: UIAdapterModule): void {
  const existingIndex = uiAdapters.findIndex((entry) => entry.type === adapter.type);
  if (existingIndex >= 0) {
    uiAdapters.splice(existingIndex, 1, adapter);
  } else {
    uiAdapters.push(adapter);
  }
  adaptersByType.set(adapter.type, adapter);
  notifyAdapterChange();
}

export function unregisterUIAdapter(type: string): void {
  if (type === processUIAdapter.type || type === httpUIAdapter.type) return;
  const existingIndex = uiAdapters.findIndex((entry) => entry.type === type);
  if (existingIndex >= 0) {
    uiAdapters.splice(existingIndex, 1);
  }
  adaptersByType.delete(type);
}

export function findUIAdapter(type: string): UIAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

registerBuiltInUIAdapters();

export function getUIAdapter(type: string): UIAdapterModule {
  const builtIn = adaptersByType.get(type);

  if (!builtIn) {
    let loadStarted = false;
    return {
      type,
      label: type,
      parseStdoutLine: (line: string, ts: string) => {
        if (!loadStarted) {
          loadStarted = true;
          loadDynamicParser(type).then((parserModule) => {
            if (parserModule) {
              registerUIAdapter({
                type,
                label: type,
                parseStdoutLine: parserModule.parseStdoutLine,
                createStdoutParser: parserModule.createStdoutParser,
                ConfigFields: SchemaConfigFields,
                buildAdapterConfig: buildSchemaAdapterConfig,
              });
            }
          });
        }
        return processUIAdapter.parseStdoutLine(line, ts);
      },
      ConfigFields: SchemaConfigFields,
      buildAdapterConfig: buildSchemaAdapterConfig,
    };
  }

  return builtIn;
}

/**
 * Keep the UI adapter registry in sync with the server's adapter list.
 *
 * Two concerns:
 *
 * 1. **Builtin overrides** — when an external adapter ships a ui-parser.js for a
 *    builtin type, the external parser takes priority.  When the external is
 *    disabled or removed the original builtin parser is restored transparently.
 *    A generation counter guards against stale loads that resolve after the
 *    override has been torn down.
 *
 * 2. **Non-builtin externals** — register a bridge adapter that lazily loads the
 *    dynamic parser on first stdout line, falling back to the generic process
 *    adapter.  Once the parser resolves the bridge is replaced.
 */
export function syncExternalAdapters(
  serverAdapters: {
    type: string;
    label: string;
    disabled?: boolean;
    /** When true, the external override for a builtin type is client-side paused. */
    overrideDisabled?: boolean;
  }[],
): void {
  const enabledExternalTypes = new Set(
    serverAdapters.filter((a) => !a.disabled && !a.overrideDisabled).map((a) => a.type),
  );
  const allExternalTypes = new Set(
    serverAdapters.map((a) => a.type),
  );

  // ── Builtin override lifecycle ──────────────────────────────────────────

  for (const builtinType of builtinTypes) {
    const originalBuiltin = builtinAdaptersByType.get(builtinType);
    if (!originalBuiltin) continue;

    const hasExternal = allExternalTypes.has(builtinType);
    const externalEnabled = enabledExternalTypes.has(builtinType);
    const wasOverridden = activeExternalOverrides.has(builtinType);

    if (hasExternal && externalEnabled && !wasOverridden) {
      // Activate: external just became active → replace builtin with bridge.
      activeExternalOverrides.add(builtinType);

      const gen = (overrideGeneration.get(builtinType) ?? 0) + 1;
      overrideGeneration.set(builtinType, gen);

      let loadStarted = false;
      const fallbackParser = originalBuiltin.parseStdoutLine;
      const externalEntry = serverAdapters.find((a) => a.type === builtinType);
      const label = externalEntry?.label ?? builtinType;

      registerUIAdapter({
        type: builtinType,
        label,
        parseStdoutLine: (line: string, ts: string) => {
          if (!loadStarted) {
            loadStarted = true;
            loadDynamicParser(builtinType).then((parserModule) => {
              // Discard if the override was torn down while the load was in-flight.
              if (parserModule && overrideGeneration.get(builtinType) === gen) {
                registerUIAdapter({
                  type: builtinType,
                  label,
                  parseStdoutLine: parserModule.parseStdoutLine,
                  createStdoutParser: parserModule.createStdoutParser,
                  ConfigFields: originalBuiltin.ConfigFields,
                  buildAdapterConfig: originalBuiltin.buildAdapterConfig,
                });
              }
            });
          }
          return fallbackParser(line, ts);
        },
        ConfigFields: originalBuiltin.ConfigFields,
        buildAdapterConfig: originalBuiltin.buildAdapterConfig,
      });
    } else if ((!hasExternal || !externalEnabled) && wasOverridden) {
      // Deactivate: external disabled or removed → restore builtin.
      activeExternalOverrides.delete(builtinType);
      overrideGeneration.delete(builtinType);
      invalidateDynamicParser(builtinType);
      registerUIAdapter(originalBuiltin);
    }
  }

  // ── Non-builtin externals ───────────────────────────────────────────────

  for (const { type, label } of serverAdapters) {
    if (builtinTypes.has(type)) continue; // handled above

    const existing = adaptersByType.get(type);

    // If this type already has an externally-loaded dynamic parser, skip —
    // it was loaded from disk on a previous sync. Only re-trigger loading
    // when the server returns a new external adapter that hasn't been loaded yet.
    if (existing && existing !== processUIAdapter) continue;

    let loadStarted = false;
    // Use the existing built-in parser as fallback (if any) so we don't
    // regress to the generic process parser while the dynamic one loads.
    const fallbackParser = existing?.parseStdoutLine ?? processUIAdapter.parseStdoutLine;

    registerUIAdapter({
      type,
      label,
      parseStdoutLine: (line: string, ts: string) => {
        if (!loadStarted) {
          loadStarted = true;
          loadDynamicParser(type).then((parserModule) => {
            if (parserModule) {
              registerUIAdapter({
                type,
                label,
                parseStdoutLine: parserModule.parseStdoutLine,
                createStdoutParser: parserModule.createStdoutParser,
                ConfigFields: existing?.ConfigFields ?? SchemaConfigFields,
                buildAdapterConfig: existing?.buildAdapterConfig ?? buildSchemaAdapterConfig,
              });
            }
          });
        }
        return fallbackParser(line, ts);
      },
      ConfigFields: existing?.ConfigFields ?? SchemaConfigFields,
      buildAdapterConfig: existing?.buildAdapterConfig ?? buildSchemaAdapterConfig,
    });
  }
}

export function listUIAdapters(): UIAdapterModule[] {
  return [...uiAdapters];
}
