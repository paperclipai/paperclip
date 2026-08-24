import { describe, expect, it } from "vitest";

import { createPhase4bBrowserMiddleware } from "./phase4b-browser-server.mjs";

describe("Phase 4b Vite transport bootstrap", () => {
  it("uses the runner's shared bind guard before constructing middleware", async () => {
    const calls = [];
    const middleware = createPhase4bBrowserMiddleware({
      workingDirectory: "/server-owned-workspace",
      loadRunner: async () => ({
        assertPhase4bLoopbackBindHost(host) {
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
    const middleware = createPhase4bBrowserMiddleware({
      workingDirectory: "/server-owned-workspace",
      loadRunner: async () => ({
        assertPhase4bLoopbackBindHost(host) {
          expect(host).toBe("127.0.0.1");
        },
        phase4bDemoManifestCatalogue: () => [],
        Phase4bScriptedDriver: class {},
        Phase4bDemoServer: class {
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
