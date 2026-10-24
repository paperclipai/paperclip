import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "vite";
import { expect, it } from "vitest";

it("keeps component names through the production bundle for React error traces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-component-names-"));
  try {
    await mkdir(path.join(root, "public"));
    await mkdir(path.join(root, "src/assets"), { recursive: true });
    await writeFile(
      path.join(root, "src/assets/offline-character.webm"),
      await readFile(new URL("../assets/offline-character.webm", import.meta.url)),
    );
    await writeFile(
      path.join(root, "public/sw.js"),
      await readFile(new URL("../../public/sw.js", import.meta.url)),
    );
    await writeFile(
      path.join(root, "src/index.css"),
      await readFile(new URL("../index.css", import.meta.url)),
    );
    const entry = path.join(root, "entry.js");
    await writeFile(entry, `
      function DiagnosticComponent() { return null; }
      class DiagnosticBoundary { render() { return null; } }
      const DiagnosticArrow = () => null;
      globalThis.componentNames = [DiagnosticComponent.name, DiagnosticBoundary.name, DiagnosticArrow.name];
    `);
    const result = await build({
      configFile: fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
      root,
      mode: "production",
      logLevel: "silent",
      build: {
        outDir: path.join(root, "dist"),
        rolldownOptions: { input: entry, output: { format: "iife" } },
      },
    });
    const output = (Array.isArray(result) ? result[0] : result) as { output: Array<{ type: string; fileName: string }> };
    const chunk = output.output.find((item) => item.type === "chunk");
    expect(chunk).toBeDefined();
    const code = await readFile(path.join(root, "dist", chunk!.fileName), "utf8");
    const scope: { componentNames?: string[] } = {};
    runInNewContext(code, scope);
    expect(scope.componentNames).toEqual(["DiagnosticComponent", "DiagnosticBoundary", "DiagnosticArrow"]);
    const worker = await readFile(path.join(root, "dist/sw.js"), "utf8");
    expect(worker).toContain(".paperclip-offline");
    expect(worker).not.toMatch(/__PAPERCLIP_/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
