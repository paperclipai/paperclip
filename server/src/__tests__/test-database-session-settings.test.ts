import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const roots = ["server/src", "packages"];
const roleSetting = /alter\s+(?:role|user)\s[^`'"]*\bset\b/i;

async function testFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries.map(async entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : testFiles(target);
    return /\.test\.(?:ts|tsx|mts|mjs|js)$/.test(entry.name) ? [target] : [];
  }));
  return files.flat();
}

describe("test database session settings", () => {
  it("scope session settings to the suite's own database, never to the shared role", async () => {
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of await testFiles(path.join(repoRoot, root))) {
        const lines = (await fs.readFile(file, "utf8")).split("\n");
        lines.forEach((line, index) => {
          if (roleSetting.test(line)) offenders.push(`${path.relative(repoRoot, file)}:${index + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
