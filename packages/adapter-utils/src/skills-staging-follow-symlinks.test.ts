import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoAdaptersDir = path.resolve(__moduleDir, "../../adapters");

// One flat object literal, such as an asset entry in an `assets: [...]`
// array. `[^{}]*` stops at the object's own closing brace, so a match never
// bleeds into a sibling asset (e.g. `mcp-config`) later in the same array.
const OBJECT_LITERAL = /\{[^{}]*\}/g;
const KEY_IS_SKILLS = /key:\s*"skills"/;
// Property order inside the object is not significant: `key: "skills"` can
// come before or after `followSymlinks`, so each is matched on its own
// against the whole block instead of one property chained after the other.
const FOLLOW_SYMLINKS_VALUE = /followSymlinks:\s*(true|false)/;

/**
 * The `followSymlinks` value of every `key: "skills"` object literal in a
 * source string, regardless of the order its properties appear in.
 */
function parseSkillsAssetFollowSymlinksValues(source: string): boolean[] {
  const followSymlinksValues: boolean[] = [];
  for (const [block] of source.matchAll(OBJECT_LITERAL)) {
    if (!KEY_IS_SKILLS.test(block)) continue;
    const followSymlinksMatch = FOLLOW_SYMLINKS_VALUE.exec(block);
    if (!followSymlinksMatch) continue;
    followSymlinksValues.push(followSymlinksMatch[1] === "true");
  }
  return followSymlinksValues;
}

/**
 * Every real occurrence of a `key: "skills"` staging asset under
 * `packages/adapters`, keyed by its repo-relative path. This walks the real
 * adapter source tree, so it catches a new staging site as soon as it lands
 * — a test that only checks a hand-picked list, or a fabricated string,
 * cannot. It also catches a site whose `key` and `followSymlinks`
 * properties appear in either order.
 */
async function findSkillsStagingSites(): Promise<Map<string, boolean[]>> {
  const sites = new Map<string, boolean[]>();

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!fullPath.endsWith(".ts") || fullPath.endsWith(".test.ts")) continue;

      const source = await fs.readFile(fullPath, "utf8");
      const followSymlinksValues = parseSkillsAssetFollowSymlinksValues(source);
      if (followSymlinksValues.length === 0) continue;

      const relativePath = path
        .relative(repoAdaptersDir, fullPath)
        .split(path.sep)
        .join("/");
      sites.set(relativePath, followSymlinksValues);
    }
  }

  await walk(repoAdaptersDir);
  return sites;
}

// The known `key: "skills"` staging sites and their reviewed
// `followSymlinks` setting, as of this test's authorship. Each site's value
// is a deliberate choice: the remote Claude ACP lane stages an
// already-materialized, owned copy of the skill bundle (never a symlink),
// so it must set `followSymlinks: false` — following a link there turns
// into tar's `-h` flag (`sandbox-managed-runtime.ts`) and dereferences a
// symlink planted in the bundle directory after it was built. Every other
// listed site still stages the user's live skills directory directly and
// relies on `followSymlinks: true` to resolve that directory's own
// symlinks. A change to any of these values, or a new unlisted site, must
// fail this test and force a deliberate review.
const EXPECTED_SKILLS_STAGING_SITES: Record<string, boolean> = {
  "claude-local/src/server/acp.ts": false,
  "claude-local/src/server/execute.ts": true,
  "cursor-local/src/server/execute.ts": true,
  "gemini-local/src/server/acp.ts": true,
  "gemini-local/src/server/execute.ts": true,
  "kimi-local/src/server/execute.ts": true,
  "opencode-local/src/server/execute.ts": true,
  "pi-local/src/server/execute.ts": true,
};

describe("remote skills staging sites (real source scan)", () => {
  it("matches the reviewed followSymlinks setting at every known site, and finds no unlisted site", async () => {
    const discoveredSites = await findSkillsStagingSites();

    for (const [relativePath, followSymlinksValues] of discoveredSites) {
      expect(
        relativePath in EXPECTED_SKILLS_STAGING_SITES,
        `Found an unreviewed "skills" staging site at ${relativePath}. ` +
          "Add it to EXPECTED_SKILLS_STAGING_SITES with a deliberate " +
          "followSymlinks choice.",
      ).toBe(true);
      for (const value of followSymlinksValues) {
        expect(
          value,
          `${relativePath} sets followSymlinks: ${value}, but the reviewed ` +
            `value is ${EXPECTED_SKILLS_STAGING_SITES[relativePath]}.`,
        ).toBe(EXPECTED_SKILLS_STAGING_SITES[relativePath]);
      }
    }

    for (const relativePath of Object.keys(EXPECTED_SKILLS_STAGING_SITES)) {
      expect(
        discoveredSites.has(relativePath),
        `Expected a "skills" staging site at ${relativePath}; it is missing ` +
          "or no longer sets followSymlinks in that object literal.",
      ).toBe(true);
    }
  });

  it("stages the remote Claude ACP skill bundle without following a symlink", async () => {
    // The one site this change owns: the materialized skill bundle must
    // never be staged with tar's `-h` flag. A regression here would let a
    // symlink planted in the bundle directory after it was built escape
    // into the sandbox.
    const discoveredSites = await findSkillsStagingSites();
    const claudeAcpValues = discoveredSites.get(
      "claude-local/src/server/acp.ts",
    );
    expect(claudeAcpValues).toEqual([false]);
  });

  it("finds a skills asset's followSymlinks value in either property order", () => {
    const keyFirst = `{ key: "skills", localDir: dir, followSymlinks: false }`;
    const followSymlinksFirst = `{ followSymlinks: true, localDir: dir, key: "skills" }`;

    expect(parseSkillsAssetFollowSymlinksValues(keyFirst)).toEqual([false]);
    expect(parseSkillsAssetFollowSymlinksValues(followSymlinksFirst)).toEqual([
      true,
    ]);
  });
});
