import { describe, expect, it } from "vitest";

import { createLiveConsoleBrowserMiddleware, loadLiveConsoleRunner } from "./live-console-browser-server.mjs";

describe("Live console Vite transport bootstrap", () => {
  it("loads the demo helpers from their owning modules instead of the public barrel", async () => {
    const paths = [];
    const runner = await loadLiveConsoleRunner(async (url) => {
      const path = new URL(url).pathname;
      paths.push(path.slice(path.lastIndexOf("/dist/") + 6));
      // Exercise real exports without requiring generated dist in unit tests.
      return import(url.replace("/dist/", "/src/").replace(/\.js$/, ".ts"));
    });
    expect(paths).toEqual([
      "mock-core/live-console-demo-server.js",
      "mock-core/live-console-demo-manifests.js",
      "mock-core/live-console-scripted-driver.js",
      "drivers/codex/codex-app-server-driver.js",
    ]);
    expect(runner.assertLiveConsoleLoopbackBindHost).toBeTypeOf("function");
    expect(runner.LiveConsoleDemoServer).toBeTypeOf("function");
    expect(runner.LiveConsoleScriptedDriver).toBeTypeOf("function");
    expect(runner.CodexAppServerDriver).toBeTypeOf("function");
    expect(runner.liveConsoleDemoManifestCatalogue().length).toBeGreaterThan(0);
    expect(() => runner.assertLiveConsoleLoopbackBindHost("0.0.0.0")).toThrow();
    const middleware = createLiveConsoleBrowserMiddleware({
      workingDirectory: "/server-owned-workspace",
      loadRunner: async () => runner,
    });
    await middleware.prepare("127.0.0.1");
    await middleware.close();
  });

  it("uses the runner's shared bind guard before constructing middleware", async () => {
    const calls = [];
    const middleware = createLiveConsoleBrowserMiddleware({
      workingDirectory: "/server-owned-workspace",
      loadRunner: async () => ({
        assertLiveConsoleLoopbackBindHost(host) {
          calls.push(host);
          throw new Error("shared guard rejected non-loopback bind");
        },
      }),
    });

    await expect(middleware.prepare("0.0.0.0")).rejects.toThrow(
      "shared guard rejected non-loopback bind",
    );
    expect(calls).toEqual(["0.0.0.0"]);
  });

  it("passes the validated Vite bind host into the shared demo server", async () => {
    let serverOptions;
    const middleware = createLiveConsoleBrowserMiddleware({
      workingDirectory: "/server-owned-workspace",
      loadRunner: async () => ({
        assertLiveConsoleLoopbackBindHost(host) {
          expect(host).toBe("127.0.0.1");
        },
        liveConsoleDemoManifestCatalogue: () => [],
        LiveConsoleScriptedDriver: class {},
        LiveConsoleDemoServer: class {
          constructor(options) {
            serverOptions = options;
          }

          middleware() {
            return () => undefined;
          }

          async close() {}
        },
      }),
    });

    await middleware.prepare("127.0.0.1");
    expect(serverOptions).toMatchObject({
      host: "127.0.0.1",
      workingDirectory: "/server-owned-workspace",
    });
  });
});
