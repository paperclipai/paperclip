// Attribute a browser error to the plugin UI module that raised it.
//
// The host imports each plugin's UI module from a `blob:` URL (see
// `importPluginModule` in `plugins/slots.tsx`). A stack frame from that
// module names only the random blob URL, so a Sentry event cannot tell which
// plugin threw, or which plugin aborted a request during an unmount.
//
// The loader records each blob URL with its plugin key here. Sentry's
// `beforeSend` reads the innermost blob frame of an event back and tags the
// event with that plugin key. Blob URLs stay in this module and are never sent.

/** At most this many recent plugin module URLs are remembered. */
const MAX_REMEMBERED_MODULES = 100;
/** Sentry tag values are limited to 200 characters. */
const MAX_TAG_LENGTH = 200;

const pluginKeysByModuleUrl = new Map<string, string>();

/** Record that `url` holds the UI module of plugin `pluginKey`. Never throws. */
export function rememberPluginModuleUrl(url: string, pluginKey: string): void {
  try {
    pluginKeysByModuleUrl.delete(url);
    pluginKeysByModuleUrl.set(url, pluginKey);
    while (pluginKeysByModuleUrl.size > MAX_REMEMBERED_MODULES) {
      const oldest = pluginKeysByModuleUrl.keys().next().value;
      if (oldest === undefined) break;
      pluginKeysByModuleUrl.delete(oldest);
    }
  } catch { /* diagnostic unavailable */ }
}

interface StackFrameLike {
  filename?: string;
  abs_path?: string;
}

interface ExceptionLike {
  stacktrace?: { frames?: readonly StackFrameLike[] };
}

/**
 * The plugin key of the innermost frame that ran from a `blob:` module, or
 * `unmapped` when that blob module is not a recorded plugin module.
 * `undefined` when no frame ran from a blob module. Sentry lists frames from
 * outermost to innermost.
 */
export function readPluginModuleOrigin(
  exceptions: readonly ExceptionLike[] | undefined,
): string | undefined {
  try {
    if (!exceptions) return undefined;
    for (const exception of exceptions) {
      const frames = exception.stacktrace?.frames ?? [];
      for (let index = frames.length - 1; index >= 0; index -= 1) {
        const frame = frames[index];
        const url = [frame.abs_path, frame.filename].find(
          (value): value is string => typeof value === "string" && value.startsWith("blob:"),
        );
        if (!url) continue;
        const pluginKey = pluginKeysByModuleUrl.get(url);
        return pluginKey ? pluginKey.slice(0, MAX_TAG_LENGTH) : "unmapped";
      }
    }
  } catch { /* diagnostic unavailable */ }
  return undefined;
}

/** Test-only: forget every recorded module URL. */
export function __resetPluginModuleOrigins(): void {
  pluginKeysByModuleUrl.clear();
}
