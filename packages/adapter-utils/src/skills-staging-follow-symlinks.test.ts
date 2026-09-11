import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoAdaptersDir = path.resolve(__moduleDir, "../../adapters");

// Every remote lane that stages a `skills` asset into a sandbox or an SSH
// target. `followSymlinks` on that asset becomes tar's `-h` flag
// (`sandbox-managed-runtime.ts`), which dereferences every symlink in the
// staged directory. The skills builder for each of these sites now
// materializes an owned, admission-gated copy (never a symlink), so the
// asset must always set `followSymlinks: false`. This list is exhaustive:
// `git grep -n 'key: "skills"'` across `packages/adapters` must return
// exactly these sites.
const SKILLS_STAGING_SITES = [
  "claude-local/src/server/execute.ts",
  "cursor-local/src/server/execute.ts",
  "gemini-local/src/server/acp.ts",
  "gemini-local/src/server/execute.ts",
  "kimi-local/src/server/execute.ts",
  "opencode-local/src/server/execute.ts",
  "pi-local/src/server/execute.ts",
];

// A `key: "skills"` asset literal, with `followSymlinks` set inside the
// SAME object literal. `[^{}]*` stops at the object's own closing brace, so
// this never bleeds into a sibling asset (e.g. `mcp-config`) later in the
// same `assets: [...]` array.
const SKILLS_ASSET_FOLLOW_SYMLINKS_FALSE =
  /key:\s*"skills"[^{}]*followSymlinks:\s*false/;
const SKILLS_ASSET_FOLLOW_SYMLINKS_TRUE =
  /key:\s*"skills"[^{}]*followSymlinks:\s*true/;

describe("remote skills staging never carries tar -h", () => {
  it.each(SKILLS_STAGING_SITES)(
    "%s stages the skills asset with followSymlinks: false",
    async (relativePath) => {
      const source = await fs.readFile(
        path.join(repoAdaptersDir, relativePath),
        "utf8",
      );
      expect(source).toMatch(SKILLS_ASSET_FOLLOW_SYMLINKS_FALSE);
      expect(source).not.toMatch(SKILLS_ASSET_FOLLOW_SYMLINKS_TRUE);
    },
  );

  it("finds no key: \"skills\" site outside the known list (sensitivity control)", async () => {
    // Proves the regex above is not vacuously true: an unlisted site with
    // followSymlinks: true must be caught, not silently skipped.
    const bogusSource = 'assets: [{ key: "skills", localDir: x, followSymlinks: true }]';
    expect(bogusSource).toMatch(SKILLS_ASSET_FOLLOW_SYMLINKS_TRUE);
    expect(bogusSource).not.toMatch(SKILLS_ASSET_FOLLOW_SYMLINKS_FALSE);
  });
});
