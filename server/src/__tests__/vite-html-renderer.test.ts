import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCachedViteHtmlRenderer, type ViteWatcherHost } from "../vite-html-renderer.js";
import { injectRuntimeFeaturesHtml } from "../runtime-features-html.js";

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

  it("reuses the injected dev html shell until index.html changes", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vite-html-"));
    tempDirs.push(tempDir);
    const indexPath = path.join(tempDir, "index.html");
    fs.writeFileSync(
      indexPath,
      '<html><body>v1<script type="module" src="/src/main.tsx"></script></body></html>',
      "utf8",
    );

    const watcher = createWatcher();
    const vite: ViteWatcherHost = {
      watcher,
    };

    const renderer = createCachedViteHtmlRenderer({ vite, uiRoot: tempDir });

    await expect(renderer.render("/")).resolves.toContain("/@vite/client");
    await expect(renderer.render("/")).resolves.toContain('"/@react-refresh"');
    const first = await renderer.render("/");
    const second = await renderer.render("/issues");
    expect(first).toBe(second);
    expect(first.match(/\/@vite\/client/g)?.length).toBe(1);
    expect(first).toContain("window.$RefreshReg$");

    const sourcePath = path.join(tempDir, "src", "main.tsx");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "export {};\n", "utf8");
    watcher.emit("change", sourcePath);
    expect(await renderer.render("/")).toBe(first);

    fs.writeFileSync(
      indexPath,
      '<html><body>v2<script type="module" src="/src/main.tsx"></script></body></html>',
      "utf8",
    );
    watcher.emit("change", indexPath);

    await expect(renderer.render("/")).resolves.toContain("v2");

    renderer.dispose();
  });

  it("does not duplicate the vite client tag or react refresh preamble when already present", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vite-html-"));
    tempDirs.push(tempDir);
    fs.writeFileSync(
      path.join(tempDir, "index.html"),
      '<html><head><script type="module">import { injectIntoGlobalHook } from "/@react-refresh";injectIntoGlobalHook(window);window.$RefreshReg$ = () => {};window.$RefreshSig$ = () => (type) => type;</script></head><body><script type="module" src="/@vite/client"></script><script type="module" src="/src/main.tsx"></script></body></html>',
      "utf8",
    );

    const vite: ViteWatcherHost = {
      watcher: createWatcher(),
    };

    const renderer = createCachedViteHtmlRenderer({ vite, uiRoot: tempDir });

    const html = await renderer.render("/");
    expect(html.match(/\/@vite\/client/g)?.length).toBe(1);
    expect(html.match(/\/@react-refresh/g)?.length).toBe(1);
  });

  it("injects a fresh runtime feature snapshot into the cached dev shell", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vite-html-"));
    tempDirs.push(tempDir);
    fs.writeFileSync(
      path.join(tempDir, "index.html"),
      '<html><head><!-- PAPERCLIP_RUNTIME_FEATURES --></head><body><script type="module" src="/src/main.tsx"></script></body></html>',
      "utf8",
    );

    let enabled = false;
    const renderer = createCachedViteHtmlRenderer({
      vite: { watcher: createWatcher() },
      uiRoot: tempDir,
      injectHtml: (html) => injectRuntimeFeaturesHtml(html, {
        schemaVersion: 1,
        hostFeatures: enabled ? ["apps.named_mcp_gateways"] : [],
      }),
    });

    const disabledHtml = await renderer.render("/");
    enabled = true;
    const enabledHtml = await renderer.render("/");

    expect(disabledHtml).toContain('"hostFeatures":[]');
    expect(enabledHtml).toContain('"hostFeatures":["apps.named_mcp_gateways"]');
    expect(enabledHtml.match(/paperclip-runtime-features/g)?.length).toBe(1);
  });
});
