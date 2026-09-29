import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { visitCommandLines, writeTopLevelNames } from "./file-sync-stream.js";

it("streams a listing beyond 32 MiB without retaining its lines", async () => {
  let count = 0;
  await visitCommandLines(process.execPath, ["-e", `const fs=require('fs'); for(let i=0;i<10000;i++) fs.writeSync(1,'x'.repeat(4096)+'\\n');`], line => { expect(line.length).toBe(4096); count++; });
  expect(count).toBe(10_000);
}, 30_000);

it("bounds an individual entry and propagates child failure", async () => {
  await expect(visitCommandLines(process.execPath, ["-e", "process.stdout.write('x'.repeat(70000))"], () => undefined)).rejects.toThrow("too long");
  await expect(visitCommandLines(process.execPath, ["-e", "process.exit(7)"], () => undefined)).rejects.toThrow("listing failed");
});

it("writes literal NUL-delimited names without shell expansion or a directory argv", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytona-catalog-"));
  try {
    const source = join(root, "source"), names = join(root, "names"); await mkdir(source);
    const entries = ["-C", "a name", "line\nbreak", "$(not-a-command)"];
    for (const name of entries) await writeFile(join(source, name), "x");
    await writeTopLevelNames(source, names);
    expect((await readFile(names, "utf8")).split("\0").filter(Boolean).sort()).toEqual(entries.map(name => `./${name}`).sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});
