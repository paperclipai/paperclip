import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("keeps real application call sites when capture and Drizzle share a map-free runtime bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "capture-bundle-"));
  try {
    const output = join(directory, "server/dist-runtime/chunk-ABCDEFGH.mjs");
    await mkdir(join(directory, "server/dist-runtime"), { recursive: true });
    await build({ entryPoints: [fileURLToPath(new URL("./__tests__/response-capture-bundle-fixture.ts", import.meta.url))],
      outfile: output, bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: false });
    expect(await readdir(join(directory, "server/dist-runtime"))).toEqual(["chunk-ABCDEFGH.mjs"]);
    const source = await readFile(output, "utf8");
    expect(source).toContain("function installDatabaseResponseCapture");
    expect(source).toContain("PgDialect = class");
    const lines = source.split("\n");
    const expectedLines = lines.flatMap((line, index) => (line.includes("return db.select(") || line.includes("return db.execute(")) ? [index + 1] : []);
    expect(expectedLines).toHaveLength(4);
    const result = await (await import(/* @vite-ignore */ pathToFileURL(output).href)).runBundleProof();
    for (const item of result.cases) {
      expect(item.driverCalls).toBe(9);
      const entries = item.events.filter((event: Record<string, unknown>) => Array.isArray(event.callers));
      if (["disabled", "future", "expired"].includes(item.mode)) {
        expect(item.stacks).toBe(0);
        expect(entries).toEqual([]);
      } else if (item.mode === "response.presentation") {
        expect(item.stacks).toBe(0);
        expect(entries.reduce((sum: number, entry: { calls: number }) => sum + entry.calls, 0)).toBe(9);
        expect(entries.every((entry: { owner: string; callers: string[] }) => entry.owner === item.mode && entry.callers.length === 0)).toBe(true);
      } else {
        expect(item.stacks).toBe(9);
        const located = entries.filter((entry: { callers: string[] }) => entry.callers.length > 0);
        expect(entries.filter((entry: { callers: string[] }) => entry.callers.length === 0).reduce((sum: number, entry: { calls: number }) => sum + entry.calls, 0)).toBe(2);
        expect(located.map((entry: { callers: string[] }) => Number(entry.callers[0]!.split(":")[1])).sort((a: number, b: number) => a - b))
          .toEqual(expectedLines);
        expect(located.map((entry: { calls: number }) => entry.calls).sort()).toEqual([1, 1, 2, 3]);
        for (const entry of located) {
          expect(entry.callers).toHaveLength(1);
          expect(entry.callers[0]).toMatch(/^dist-runtime\/chunk-ABCDEFGH\.mjs:\d+:\d+$/);
          expect(entry.owner).toBe(item.mode === "unowned" ? "unattributed" : item.mode);
        }
      }
    }
    const serialized = JSON.stringify(result);
    for (const privateValue of [directory, "00000000-0000", "firstApplicationCaller", "select ", "where ", "node_modules", "response-capture.ts"])
      expect(serialized).not.toContain(privateValue);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
