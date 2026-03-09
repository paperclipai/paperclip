import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
import { getUiBuildSnapshot, startPluginDevServer } from "@paperclipai/plugin-sdk/dev-server";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "plugin-sdk-dev-tools-"));
}

function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("createPluginBundlerPresets", () => {
  it("returns worker+manifest presets by default", () => {
    const presets = createPluginBundlerPresets();

    expect(presets.esbuild.worker.entryPoints).toEqual(["src/worker.ts"]);
    expect(presets.esbuild.manifest.entryPoints).toEqual(["src/manifest.ts"]);
    expect(presets.esbuild.ui).toBeUndefined();
    expect(presets.rollup.ui).toBeUndefined();
  });

  it("includes ui presets when uiEntry is provided", () => {
    const presets = createPluginBundlerPresets({
      uiEntry: "src/ui/index.tsx",
      outdir: "build",
      minify: true,
      sourcemap: false,
    });

    expect(presets.esbuild.ui?.entryPoints).toEqual(["src/ui/index.tsx"]);
    expect(presets.esbuild.ui?.outdir).toBe("build/ui");
    expect(presets.esbuild.worker.outdir).toBe("build");
    expect(presets.esbuild.worker.minify).toBe(true);
    expect(presets.esbuild.ui?.external).toEqual(expect.arrayContaining([
      "@paperclipai/plugin-sdk/ui",
      "@paperclipai/plugin-sdk/ui/hooks",
      "@paperclipai/plugin-sdk/ui/components",
      "react/jsx-runtime",
    ]));
    expect(presets.rollup.ui?.external).toEqual(expect.arrayContaining([
      "@paperclipai/plugin-sdk/ui",
      "@paperclipai/plugin-sdk/ui/hooks",
      "@paperclipai/plugin-sdk/ui/components",
      "react/jsx-runtime",
    ]));
    expect(presets.rollup.ui?.output.dir).toBe("build/ui");
  });
});

describe("startPluginDevServer", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmTmpDir(dir);
    tempDirs.length = 0;
  });

  it("serves health and static ui files", async () => {
    const root = mkTmpDir();
    tempDirs.push(root);
    const uiDir = path.join(root, "dist", "ui");
    fs.mkdirSync(uiDir, { recursive: true });
    fs.writeFileSync(path.join(uiDir, "index.js"), "console.log('ok');");

    const server = await startPluginDevServer({ rootDir: root, port: 0 });
    try {
      const health = await httpGet(`${server.url}/__paperclip__/health`);
      expect(health.statusCode).toBe(200);
      expect(JSON.parse(health.body)).toMatchObject({ ok: true });

      const file = await httpGet(`${server.url}/index.js`);
      expect(file.statusCode).toBe(200);
      expect(file.body).toContain("console.log('ok');");
    } finally {
      await server.close();
    }
  });

  it("emits reload events over SSE when ui files change", async () => {
    const root = mkTmpDir();
    tempDirs.push(root);
    const uiDir = path.join(root, "dist", "ui");
    fs.mkdirSync(uiDir, { recursive: true });
    const entry = path.join(uiDir, "index.js");
    fs.writeFileSync(entry, "console.log('v1');");

    const server = await startPluginDevServer({ rootDir: root, port: 0 });
    const chunks: string[] = [];
    try {
      const sseRequest = http.get(`${server.url}/__paperclip__/events`, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => chunks.push(chunk));
      });

      await waitFor(() => chunks.join("").includes("event: connected"));

      fs.writeFileSync(entry, "console.log('v2');");
      await waitFor(() => chunks.join("").includes("event: reload"), 6000);

      sseRequest.destroy();
    } finally {
      await server.close();
    }
  });
});

describe("getUiBuildSnapshot", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmTmpDir(dir);
    tempDirs.length = 0;
  });

  it("returns sorted relative file rows with mtimes", async () => {
    const root = mkTmpDir();
    tempDirs.push(root);
    const uiDir = path.join(root, "dist", "ui");
    fs.mkdirSync(path.join(uiDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(uiDir, "z.js"), "z");
    fs.writeFileSync(path.join(uiDir, "nested", "a.js"), "a");

    const rows = await getUiBuildSnapshot(root, "dist/ui");

    expect(rows.map((row) => row.file)).toEqual(["nested/a.js", "z.js"]);
    expect(rows[0]?.mtimeMs).toBeTypeOf("number");
  });
});
