import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { managedAgentFiles } from "../services/work-folder-agent-import.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-import-"))); roots.push(root); return root; }
async function collect(root: string) { const results: Array<{ path: string; executable: boolean; text: string }> = [];
  for await (const entry of managedAgentFiles(root)) { const chunks: Buffer[] = [];
    if (entry.body) for await (const chunk of entry.body) chunks.push(Buffer.from(chunk));
    results.push({ path: entry.path, executable: entry.executable, text: Buffer.concat(chunks).toString() });
  } return results; }
it("imports nested empty and executable files while excluding credential homes", async () => {
  const root = await fixture(); await fs.mkdir(path.join(root, "notes")); await fs.writeFile(path.join(root, "notes/run.sh"), "", { mode: 0o700 });
  await fs.mkdir(path.join(root, ".codex")); await fs.writeFile(path.join(root, ".codex/auth.json"), "private");
  expect(await collect(root)).toEqual([{ path: "notes", executable: false, text: "" }, { path: "notes/run.sh", executable: true, text: "" }]);
  expect(await collect(path.join(root, "absent"))).toEqual([]);
});
it("rejects symlink and hard-link imports", async () => {
  const root = await fixture(); const other = await fixture(); await fs.writeFile(path.join(other, "private"), "private");
  await fs.symlink(path.join(other, "private"), path.join(root, "linked")); await expect(collect(root)).rejects.toThrow();
  await fs.unlink(path.join(root, "linked")); await fs.link(path.join(other, "private"), path.join(root, "linked"));
  await expect(collect(root)).rejects.toThrow("hard links");
});
it.skipIf(process.platform !== "linux")("keeps an admitted parent pinned when replaced by a symlink", async () => {
  const root = await fixture(); const other = await fixture(); await fs.mkdir(path.join(root, "notes"));
  await fs.writeFile(path.join(root, "notes/file"), "original"); await fs.writeFile(path.join(other, "file"), "private");
  const iterator = managedAgentFiles(root); expect((await iterator.next()).value?.path).toBe("notes");
  await fs.rename(path.join(root, "notes"), path.join(root, "moved")); await fs.symlink(other, path.join(root, "notes"));
  const file = (await iterator.next()).value!; const chunks: Buffer[] = [];
  for await (const chunk of file.body!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe("original"); await iterator.return(undefined);
});
