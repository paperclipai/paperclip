import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("ccrotate plugin retirement", () => {
  it("does not build or bootstrap the legacy ccrotate plugin in production", () => {
    const dockerfile = readRepoFile("Dockerfile");
    const kkrooBootstrap = readRepoFile("server/src/bootstrap/kkroo-bundled-plugins.ts");

    expect(dockerfile).not.toContain("pnpm --filter @kkroo/paperclip-plugin-ccrotate build");
    expect(kkrooBootstrap).not.toContain('pluginKey: "kkroo.ccrotate"');
    expect(kkrooBootstrap).not.toContain("packages/plugins/paperclip-plugin-ccrotate");
  });

  it("retires already-installed ccrotate plugin rows before plugin loadAll", () => {
    const app = readRepoFile("server/src/app.ts");

    expect(app).toContain('const LEGACY_CCROTATE_PLUGIN_KEY = "kkroo.ccrotate"');
    expect(app).toContain("Retired after Penstock migration");
    expect(app).toContain("retired legacy ccrotate plugin before plugin loadAll");
    expect(app).toContain(".then(() => retireLegacyCcrotatePlugin())");
    expect(app.indexOf(".then(() => retireLegacyCcrotatePlugin())")).toBeLessThan(
      app.indexOf(".then(() => loader.loadAll())"),
    );
  });
});
