import { existsSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginLoader } from "../services/plugin-loader.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux" || !process.getuid || process.getuid() === 0)(
  "isolated bundled plugin provenance",
  () => {
    it("rejects an agent-writable catalog before build, manifest import, or worker start", async () => {
      const root = mkdtempSync(path.join(process.cwd(), ".paperclip-bundle-attack-"));
      roots.push(root);
      const bundle = path.join(root, "sandbox-providers", "kubernetes");
      const dist = path.join(bundle, "dist");
      mkdirSync(dist, { recursive: true });
      const buildMarker = path.join(root, "build-ran");
      const importMarker = path.join(root, "manifest-ran");
      writeFileSync(path.join(bundle, "package.json"), JSON.stringify({
        name: "@paperclipai/plugin-kubernetes",
        version: "0.1.0",
        type: "module",
        scripts: { build: `node -e "require('fs').writeFileSync('${buildMarker}', '')"` },
        paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
      }));
      writeFileSync(path.join(dist, "manifest.js"),
        `import fs from 'node:fs'; fs.writeFileSync('${importMarker}', ''); export default {};`);
      chmodSync(root, 0o777); // The host agent can replace the bundle through this parent.
      vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
      vi.stubEnv("PAPERCLIP_BUNDLED_PLUGIN_ROOT", root);

      const plugin = {
        id: "plugin-id",
        pluginKey: "paperclip.kubernetes-sandbox-provider",
        packageName: "@paperclipai/plugin-kubernetes",
        packagePath: bundle,
        status: "ready",
        manifestJson: { entrypoints: { worker: "./dist/worker.js" } },
      };
      const db = {
        select: () => ({ from: () => ({ where: () => Promise.resolve([plugin]) }) }),
      };
      const workerManager = { startWorker: vi.fn() };
      const runtimeServices = {
        instanceInfo: { hostVersion: "test" },
        workerManager,
        lifecycleManager: { markError: vi.fn() },
      };
      const loader = pluginLoader(db as never, {}, runtimeServices as never);

      await expect(loader.installPlugin({ localPath: bundle })).rejects.toThrow(/release-bundled plugin/);
      expect(existsSync(buildMarker)).toBe(false);
      expect(existsSync(importMarker)).toBe(false);

      writeFileSync(path.join(dist, "worker.js"), "export {};");
      const result = await loader.loadSingle(plugin.id, { markErrorOnFailure: false });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/bundled Kubernetes sandbox provider/);
      expect(existsSync(importMarker)).toBe(false);
      expect(workerManager.startWorker).not.toHaveBeenCalled();
    });
  },
);
