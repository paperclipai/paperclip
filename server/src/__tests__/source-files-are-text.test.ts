import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Category safeguard (BRO-2453).
 *
 * A stray NUL byte reached a template-string separator in
 * services/routable-blocked.ts. The code still ran and every test passed, but
 * git reclassified the file as binary — so `git diff` showed "Binary files
 * differ" and the change became invisible to human and automated review alike.
 * A defect that hides the diff it lives in is worth failing the build over.
 */
async function collectTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(full);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
  }));
  return files.flat();
}

describe("server source files stay reviewable text", () => {
  it("contains no NUL bytes that would make git treat a source file as binary", async () => {
    const files = await collectTypeScriptFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const contents = await readFile(file);
      const index = contents.indexOf(0);
      if (index !== -1) offenders.push(`${path.relative(SRC_ROOT, file)} (byte ${index})`);
    }

    expect(offenders).toEqual([]);
  });
});
