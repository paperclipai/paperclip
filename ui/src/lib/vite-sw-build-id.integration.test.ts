// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "vite";
import { SERVICE_WORKER_BUILD_ID_PLACEHOLDER, serviceWorkerBuildIdPlugin } from "./vite-sw-build-id";

describe("service worker build stamping", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(entry: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-sw-build-"));
    roots.push(root);
    await mkdir(path.join(root, "public"));
    await writeFile(path.join(root, "public/sw.js"), `const BUILD_ID = "${SERVICE_WORKER_BUILD_ID_PLACEHOLDER}";`);
    await writeFile(path.join(root, "index.html"), '<script type="module" src="/entry.js"></script>');
    await writeFile(path.join(root, "entry.js"), entry);
    return root;
  }

  async function buildFixture(root: string) {
    return build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [serviceWorkerBuildIdPlugin()],
      build: { outDir: path.join(root, "dist") },
    });
  }

  it("preserves the original diagnostic when bundling fails", async () => {
    const root = await fixture('import "./missing.js";');
    await expect(buildFixture(root)).rejects.toMatchObject({
      message: expect.stringContaining("missing.js"),
    });
    await expect(readFile(path.join(root, "dist/sw.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stamps the emitted service worker with the successful entry bundle id", async () => {
    const root = await fixture('console.log("valid");');
    const result = await buildFixture(root);
    if (Array.isArray(result) || !("output" in result)) throw new Error("Expected a single build output");
    const entry = result.output.find((item) => item.type === "chunk" && item.isEntry);
    expect(entry).toBeDefined();
    const worker = await readFile(path.join(root, "dist/sw.js"), "utf8");
    expect(worker).toBe(`const BUILD_ID = "${path.basename(entry!.fileName, ".js")}";`);
    expect(worker).not.toContain(SERVICE_WORKER_BUILD_ID_PLACEHOLDER);
  });
});
