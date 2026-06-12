import { useEffect } from "react";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { ensureStarted, type Dictionary } from "../engine.js";
import deDictionary from "../dictionary/de.json" with { type: "json" };

/**
 * The German seed dictionary. `de.json` is the swappable, human-edited /
 * harvested source of truth; it is inlined into the UI bundle at build time
 * (esbuild's JSON loader), so no JSON module is fetched in the browser.
 */
const dictionary: Dictionary = deDictionary;

/**
 * Invisible sidebar mount.
 *
 * Renders nothing. Its only job is to start the page-lifetime translation
 * engine once, when the host first mounts the sidebar slot. `ensureStarted`
 * is itself a singleton, so re-mounts are harmless no-ops.
 */
export function I18nOverlayMount(_props: PluginSidebarProps) {
  useEffect(() => {
    ensureStarted(dictionary);
  }, []);

  return null;
}
