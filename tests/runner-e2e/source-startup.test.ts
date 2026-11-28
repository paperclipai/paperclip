import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareSourceServerDependencies } from "./source-startup.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(source: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-source-startup-")); roots.push(root);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts/ensure-plugin-build-deps.mjs"), source);
  return root;
}

it("prepares missing source dependencies before the entry can import them", async () => {
  const root = await fixture(`import {writeFileSync} from 'node:fs'; writeFileSync('dependency.mjs', 'export default 42');`);
  await expect(readFile(path.join(root, "dependency.mjs"))).rejects.toThrow();
  await prepareSourceServerDependencies(root, {}, false);
  expect(await readFile(path.join(root, "dependency.mjs"), "utf8")).toBe("export default 42");
});

it("fails before server admission when dependency preparation fails", async () => {
  const root = await fixture("process.exit(7)");
  await expect(prepareSourceServerDependencies(root, {}, false)).rejects.toMatchObject({ code: 7 });
});

it("does not execute checkout helpers for an installed package", async () => {
  const root = await fixture("throw new Error('must not execute checkout code')");
  await expect(prepareSourceServerDependencies(root, {}, true)).resolves.toBeUndefined();
});
