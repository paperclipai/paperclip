import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { canonicalNativeJson } from "./canonical.js";
import { snapshotCleanupProviderHome, copyCleanupProviderHomeTree, findCleanupRollout, readCleanupRolloutHeader } from "./native-cleanup-tree.js";

it("preserves the retained metadata/content fingerprints while copying in bounded chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleanup-tree-")), source = join(root, "source"), destination = join(root, "copy");
  try {
    await mkdir(source); await mkdir(join(source, "sessions")); await mkdir(join(source, "empty"));
    await writeFile(join(source, "sessions", "b"), "retained"); await writeFile(join(source, "Z"), "before lowercase"); await writeFile(join(source, "auth.json"), "exclude");
    const metadata: unknown[] = [], content: unknown[] = [];
    const oracle = async (relative: string) => {
      const path = join(source, relative), stat = await lstat(path), directory = stat.isDirectory(), size = directory ? 0 : stat.size;
      metadata.push({ path: relative, directory, dev: stat.dev, ino: stat.ino, size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
      content.push({ path: relative, directory, size, ...(!directory ? { sha256: createHash("sha256").update(await readFile(path)).digest("hex") } : {}) });
      if (directory) for (const name of (await readdir(path)).sort()) { if (!relative && name === "auth.json") continue; await oracle(relative ? `${relative}/${name}` : name); }
    };
    await oracle("");
    const snapshot = await snapshotCleanupProviderHome(source, true, ["auth.json"]);
    const sha = (value: unknown) => createHash("sha256").update(canonicalNativeJson(value)).digest("hex");
    expect(snapshot.metadataFingerprint).toBe(sha(metadata)); expect(snapshot.fingerprint).toBe(sha(content));
    await copyCleanupProviderHomeTree(source, destination, snapshot, ["auth.json"]);
    expect((await snapshotCleanupProviderHome(destination, true, ["auth.json"])).fingerprint).toBe(snapshot.fingerprint);
    await expect(readFile(join(destination, "auth.json"))).rejects.toThrow();
    await writeFile(join(source, "Z"), "changed");
    await expect(copyCleanupProviderHomeTree(source, join(root, "changed-copy"), snapshot, ["auth.json"])).rejects.toThrow("unproven");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reads only the bounded header of a multi-gigabyte rollout and rejects duplicate identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleanup-rollout-"));
  try {
    await mkdir(join(root, "sessions"));
    const path = join(root, "sessions", "rollout-thread.jsonl"), file = await open(path, "wx", 0o600);
    const header = JSON.stringify({ type: "session_meta", payload: { id: "thread" } });
    try { await file.writeFile(header + "\n"); await file.truncate(3 * 1024 ** 3); } finally { await file.close(); }
    const rollout = await findCleanupRollout(root, "thread", []);
    expect(rollout.size).toBe(3 * 1024 ** 3);
    expect((await readCleanupRolloutHeader(root, rollout)).toString()).toBe(header);
    await writeFile(join(root, "sessions", "another-thread.jsonl"), header + "\n");
    await expect(findCleanupRollout(root, "thread", [])).rejects.toThrow("unproven");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("refuses symlinks in the source inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleanup-tree-link-"));
  try { await symlink("/etc/passwd", join(root, "escape")); await expect(snapshotCleanupProviderHome(root, true, [])).rejects.toThrow("unproven"); }
  finally { await rm(root, { recursive: true, force: true }); }
});
