import fs from "node:fs";
import path from "node:path";

type ViteWatcherEvent = "add" | "change" | "unlink";

export interface ViteWatcherHost {
  transformIndexHtml(url: string, html: string): Promise<string>;
  watcher?: {
    on?: (event: ViteWatcherEvent, listener: (file: string) => void) => unknown;
    off?: (event: ViteWatcherEvent, listener: (file: string) => void) => unknown;
  };
}

export interface CachedViteHtmlRenderer {
  render(_url: string): Promise<string>;
  dispose(): void;
}

const WATCHER_EVENTS: ViteWatcherEvent[] = ["add", "change", "unlink"];

export function createCachedViteHtmlRenderer(opts: {
  vite: ViteWatcherHost;
  uiRoot: string;
  brandHtml?: (html: string) => string;
}): CachedViteHtmlRenderer {
  const uiRoot = path.resolve(opts.uiRoot);
  const templatePath = path.resolve(uiRoot, "index.html");
  const brandHtml = opts.brandHtml ?? ((html: string) => html);
  let cachedTemplate: string | null = null;

  function loadTemplate(): string {
    if (cachedTemplate === null) {
      const rawTemplate = fs.readFileSync(templatePath, "utf-8");
      cachedTemplate = brandHtml(rawTemplate);
    }
    return cachedTemplate;
  }

  function invalidate(): void {
    cachedTemplate = null;
  }

  function onWatchEvent(filePath: string): void {
    const resolvedPath = path.resolve(filePath);
    if (resolvedPath === templatePath) {
      invalidate();
    }
  }

  for (const eventName of WATCHER_EVENTS) {
    opts.vite.watcher?.on?.(eventName, onWatchEvent);
  }

  return {
    render(url): Promise<string> {
      // Vite's transform does more than inject the dev client and React
      // refresh preamble. It also keeps entry-module timestamps aligned with
      // the module graph after an HMR invalidation. Serving the raw entry tag
      // can otherwise evaluate main.tsx twice (unversioned + timestamped),
      // creating two React roots in the same container.
      return opts.vite.transformIndexHtml(url, loadTemplate());
    },

    dispose(): void {
      for (const eventName of WATCHER_EVENTS) {
        opts.vite.watcher?.off?.(eventName, onWatchEvent);
      }
    },
  };
}
