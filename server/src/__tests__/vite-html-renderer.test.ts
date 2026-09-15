import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCachedViteHtmlRenderer, type ViteWatcherHost } from "../vite-html-renderer.js";

function createWatcher() {
  const listeners = new Map<string, Set<(file: string) => void>>();

  return {
    on(event: string, listener: (file: string) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(listener);
    },
    off(event: string, listener: (file: string) => void) {
      listeners.get(event)?.delete(listener);
    },
    emit(event: string, file: string) {
      for (const listener of listeners.get(event) ?? []) {
        listener(file);
      }
    },
  };
}

describe("createCachedViteHtmlRenderer", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caches the branded template until index.html changes while transforming every request", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vite-html-"));
    tempDirs.push(tempDir);
    const indexPath = path.join(tempDir, "index.html");
    fs.writeFileSync(
      indexPath,
      '<html><body>v1<script type="module" src="/src/main.tsx"></script></body></html>',
      "utf8",
    );

    const watcher = createWatcher();
    const transformIndexHtml = vi.fn(async (_url: string, html: string) =>
      html.replace(
        '<script type="module" src="/src/main.tsx"></script>',
        '<script type="module" src="/@vite/client"></script>\n<script type="module" src="/src/main.tsx"></script>',
      ),
    );
    const brandHtml = vi.fn((html: string) => html.replace("<body>", '<body data-brand="paperclip">'));
    const vite: ViteWatcherHost = {
      watcher,
      transformIndexHtml,
    };

    const renderer = createCachedViteHtmlRenderer({ vite, uiRoot: tempDir, brandHtml });

    await expect(renderer.render("/")).resolves.toContain("/@vite/client");
    const first = await renderer.render("/");
    const second = await renderer.render("/issues");
    expect(first).toBe(second);
    expect(first).toContain('data-brand="paperclip"');
    expect(first.match(/\/@vite\/client/g)?.length).toBe(1);
    expect(brandHtml).toHaveBeenCalledTimes(1);
    expect(transformIndexHtml).toHaveBeenCalledTimes(3);
    expect(transformIndexHtml).toHaveBeenLastCalledWith("/issues", expect.stringContaining("v1"));

    const sourcePath = path.join(tempDir, "src", "main.tsx");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "export {};\n", "utf8");
    watcher.emit("change", sourcePath);
    expect(await renderer.render("/")).toBe(first);
    expect(brandHtml).toHaveBeenCalledTimes(1);

    fs.writeFileSync(
      indexPath,
      '<html><body>v2<script type="module" src="/src/main.tsx"></script></body></html>',
      "utf8",
    );
    watcher.emit("change", indexPath);

    await expect(renderer.render("/")).resolves.toContain("v2");
    expect(brandHtml).toHaveBeenCalledTimes(2);

    renderer.dispose();
  });

  it("runs Vite's HTML transform on every render so HMR entry timestamps stay current", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vite-html-"));
    tempDirs.push(tempDir);
    fs.writeFileSync(
      path.join(tempDir, "index.html"),
      '<script type="module" src="/src/main.tsx"></script>',
      "utf8",
    );

    let timestamp = 0;
    const transformIndexHtml = vi.fn(async (_url: string, html: string) =>
      html.replace("/src/main.tsx", `/src/main.tsx?t=${++timestamp}`),
    );
    const vite: ViteWatcherHost = {
      watcher: createWatcher(),
      transformIndexHtml,
    };

    const renderer = createCachedViteHtmlRenderer({ vite, uiRoot: tempDir });

    await expect(renderer.render("/")).resolves.toContain("/src/main.tsx?t=1");
    await expect(renderer.render("/issues/ISS-1")).resolves.toContain("/src/main.tsx?t=2");
    expect(transformIndexHtml).toHaveBeenCalledTimes(2);
  });
});
