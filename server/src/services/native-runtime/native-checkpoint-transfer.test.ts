import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { checkpointTar, downloadCheckpointDirectory, uploadCheckpointArchive } from "./native-checkpoint-transfer.js";
import { loopbackCheckpointRunner } from "./native-checkpoint-transfer.test-support.js";

it("round-trips over 64 MiB and 20,000 entries through bounded command chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-checkpoint-scale-"));
  try {
    const source = join(root, "source"), remote = join(root, "remote's home"), restored = join(root, "restored"), archive = join(root, "history.tar.gz");
    await mkdir(source); await mkdir(join(source, "receipts"));
    const chunk = randomBytes(192 * 1024), expected = createHash("sha256"), file = await open(join(source, "history"), "wx", 0o600);
    try { for (let index = 0; index < 350; index++) { await file.writeFile(chunk); expected.update(chunk); } } finally { await file.close(); }
    for (let first = 0; first < 20_100; first += 100) await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(source, "receipts", `r-${first + index}`), "receipt")));
    await writeFile(join(source, "auth.json"), "must remain local");
    await checkpointTar(["--exclude=./auth.json", "-czf", archive, "-C", source, "."]);
    expect((await stat(archive)).size).toBeGreaterThan(64 * 1024 * 1024);
    let maxRequest = 0, maxResponse = 0, transfers = 0;
    const runner = loopbackCheckpointRunner((input, stdout) => {
      maxRequest = Math.max(maxRequest, input.stdin?.length ?? 0); maxResponse = Math.max(maxResponse, stdout.length);
      if (input.args?.[1]?.includes("dd ")) transfers++;
      return stdout;
    });
    await uploadCheckpointArchive({ runner, archive, targetPath: remote, mode: 0o700 });
    await downloadCheckpointDirectory({ runner, sourcePath: remote, targetPath: restored, mode: 0o700 });
    const actual = createHash("sha256"), restoredFile = await open(join(restored, "history"), "r");
    try { for await (const bytes of restoredFile.createReadStream({ autoClose: false })) actual.update(bytes); } finally { await restoredFile.close(); }
    expect(actual.digest("hex")).toBe(expected.digest("hex"));
    expect(await readdir(join(restored, "receipts"))).toHaveLength(20_100);
    await expect(stat(join(restored, "auth.json"))).rejects.toThrow();
    expect(maxRequest).toBeLessThan(300_000); expect(maxResponse).toBeLessThan(300_000); expect(transfers).toBeGreaterThan(600);
    expect((await readdir(root)).filter(name => name.startsWith(".paperclip-checkpoint-"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 240_000);

it("rejects a corrupted chunk and preserves the previously durable checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-checkpoint-corrupt-"));
  try {
    const source = join(root, "source"), target = join(root, "target"); await mkdir(source); await mkdir(target);
    await writeFile(join(source, "history"), "new"); await writeFile(join(target, "history"), "preserved");
    const runner = loopbackCheckpointRunner((input, stdout) => input.args?.[1]?.includes("dd if=") ? stdout.replace(/./, "!") : stdout);
    await expect(downloadCheckpointDirectory({ runner, sourcePath: source, targetPath: target, mode: 0o700 })).rejects.toThrow("chunk_invalid");
    expect(await readFile(join(target, "history"), "utf8")).toBe("preserved");
    expect((await readdir(root)).filter(name => name.startsWith(".paperclip-checkpoint-"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects linked remote entries before replacing the local checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-checkpoint-link-"));
  try {
    const source = join(root, "source"), target = join(root, "target"); await mkdir(source); await mkdir(target);
    await writeFile(join(target, "history"), "preserved"); await symlink("/etc/passwd", join(source, "escape"));
    await expect(downloadCheckpointDirectory({ runner: loopbackCheckpointRunner(), sourcePath: source, targetPath: target, mode: 0o700 })).rejects.toThrow("unsafe_entry");
    expect(await readFile(join(target, "history"), "utf8")).toBe("preserved");
  } finally { await rm(root, { recursive: true, force: true }); }
});
