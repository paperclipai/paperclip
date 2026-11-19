import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyFileManifest } from "./file-manifest-cache.js";

const temporaryDirectories: string[] = [];

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-manifest-"));
  temporaryDirectories.push(directory);
  const content = "# Test skill\n";
  const filename = path.join(directory, "SKILL.md");
  await fs.writeFile(filename, content);
  return {
    directory,
    filename,
    manifest: [{
      path: "SKILL.md",
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      executable: false,
    }],
  };
}

function reportModeAs0777(filename: string) {
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    const result = await lstat(...args);
    if (path.resolve(String(args[0])) !== path.resolve(filename)) return result;
    return new Proxy(result, {
      get(target, property, receiver) {
        if (property === "mode") return typeof target.mode === "bigint" ? 0o100777n : 0o100777;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("file manifest permissions", () => {
  it("accepts CIFS mode masking while preserving content integrity", async () => {
    const { directory, filename, manifest } = await fixture();
    reportModeAs0777(filename);
    vi.spyOn(fs, "statfs").mockResolvedValue({ type: 0xff534d42n } as Awaited<ReturnType<typeof fs.statfs>>);

    await expect(verifyFileManifest(directory, manifest)).resolves.toBe(true);
    await fs.writeFile(filename, "# Evil skill\n");
    await expect(verifyFileManifest(directory, manifest)).resolves.toBe(false);
  });

  it("keeps mode mismatches strict on a POSIX filesystem", async () => {
    const { directory, filename, manifest } = await fixture();
    reportModeAs0777(filename);
    vi.spyOn(fs, "statfs").mockResolvedValue({ type: 0xef53n } as Awaited<ReturnType<typeof fs.statfs>>);

    await expect(verifyFileManifest(directory, manifest)).resolves.toBe(false);
  });

  it("fails closed when the filesystem type cannot be read", async () => {
    const { directory, filename, manifest } = await fixture();
    reportModeAs0777(filename);
    vi.spyOn(fs, "statfs").mockRejectedValue(new Error("statfs unavailable"));

    await expect(verifyFileManifest(directory, manifest)).resolves.toBe(false);
  });
});
