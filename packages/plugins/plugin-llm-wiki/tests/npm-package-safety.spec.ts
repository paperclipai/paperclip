import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TEMPLATES_DIR = join(__dirname, "..", "templates");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("npm package safety", () => {
  // npm rewrites any packaged file named `.gitignore` to `.npmignore` inside the
  // published tarball, so a runtime-required template with that name silently
  // vanishes after publish (0.1.0 shipped broken because of this). Templates
  // that represent ignore files must use a non-dot name like `gitignore.template`.
  it("ships no template file that npm would rename or drop", () => {
    const hazardous = walk(TEMPLATES_DIR)
      .filter((path) => /\.(git|npm)ignore$/.test(path.split("/").pop()!));
    expect(hazardous).toEqual([]);
  });
});
