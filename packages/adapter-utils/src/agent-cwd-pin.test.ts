import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The configured agent cwd is an UNCONDITIONAL pin.
 *
 * Every local adapter resolves its working directory through
 * `useConfiguredInsteadOfAgentHome`. That flag must depend only on whether a cwd was
 * configured:
 *
 *     const useConfiguredInsteadOfAgentHome = configuredCwd.length > 0;
 *
 * It once read `workspaceSource === "agent_home" && configuredCwd.length > 0`, which makes
 * the configured cwd the last arm of a fallback chain: `project_primary` and `task_session`
 * both win first, so an agent with an explicitly configured cwd silently runs somewhere
 * else. Agent state that is keyed by the runtime cwd — Claude's auto-memory store, for one —
 * then collapses into a single directory shared by every agent on the project.
 *
 * That conjunct was removed once before, in a commit with no test. It was reintroduced by a
 * later merge and went unnoticed for roughly three weeks. This test is the missing guard.
 *
 * It asserts EQUALITY against the pinned expression rather than the absence of the old
 * conjunct. A battery of negative regexes never terminates: a guard that only looks for
 * `workspaceSource` passes `useConfiguredInsteadOfAgentHome = configuredCwd.length > 0 &&
 * runSource === "agent_home"`. Equality on a fixed one-line expression does terminate.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const ADAPTERS_DIR = path.join(REPO_ROOT, "packages", "adapters");

const SYMBOL = "useConfiguredInsteadOfAgentHome";
const PINNED_EXPRESSION = "configuredCwd.length > 0";
const ASSIGNMENT = new RegExp(`\\b${SYMBOL}\\s*=\\s*([^;]*);`);

/**
 * Adapters known to resolve a configured cwd, and how many assignment sites each one had
 * when this guard was written. Present so the suite cannot pass vacuously: if a rename,
 * a refactor, or a bad merge removes a site, the count drops and this goes red instead of
 * quietly checking nothing. New adapters do not need to be listed — they are covered by the
 * expression check below the moment they declare the symbol.
 */
const KNOWN_SITES: Record<string, number> = {
  "claude-local": 2,
  "codex-local": 1,
  "cursor-local": 1,
  "gemini-local": 1,
  "grok-local": 1,
  "kimi-local": 1,
  "opencode-local": 1,
  "pi-local": 1,
};

interface Site {
  adapter: string;
  file: string;
  line: number;
  expression: string;
}

function assignmentSites(source: string, adapter: string, file: string): Site[] {
  const sites: Site[] = [];
  source.split("\n").forEach((text, index) => {
    const match = ASSIGNMENT.exec(text);
    if (match) {
      sites.push({ adapter, file, line: index + 1, expression: match[1].trim() });
    }
  });
  return sites;
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const adapter of readdirSync(ADAPTERS_DIR).sort()) {
    const file = path.join(ADAPTERS_DIR, adapter, "src", "server", "execute.ts");
    if (!existsSync(file)) continue;
    sites.push(...assignmentSites(readFileSync(file, "utf8"), adapter, file));
  }
  return sites;
}

describe("configured agent cwd is an unconditional pin", () => {
  const sites = collectSites();

  it("finds the adapters it claims to guard", () => {
    // A zero-site run is a blind run, not a passing one.
    expect(sites.length).toBeGreaterThan(0);

    const perAdapter = new Map<string, number>();
    for (const site of sites) {
      perAdapter.set(site.adapter, (perAdapter.get(site.adapter) ?? 0) + 1);
    }
    for (const [adapter, expected] of Object.entries(KNOWN_SITES)) {
      expect(
        perAdapter.get(adapter) ?? 0,
        `${adapter}/src/server/execute.ts should assign ${SYMBOL} ${expected} time(s)`,
      ).toBeGreaterThanOrEqual(expected);
    }
  });

  it.each(collectSites().map((site) => [`${site.adapter}:${site.line}`, site] as const))(
    "%s pins the cwd unconditionally",
    (_label, site) => {
      expect(
        site.expression,
        `${path.relative(REPO_ROOT, site.file)}:${site.line} conditions the configured cwd ` +
          `on something other than whether it was configured. A run whose workspace does not ` +
          `resolve to agent_home would ignore the agent's cwd.`,
      ).toBe(PINNED_EXPRESSION);
    },
  );

  it("rejects the regressions it exists to catch", () => {
    // Negative fixtures. Without these the assertion above could be inert and nobody
    // would know. Each mutation is one that has shipped or could plausibly ship.
    const mutations = [
      // The historical regression, verbatim.
      `workspaceSource === "agent_home" && ${PINNED_EXPRESSION}`,
      // Same conjunct, other order.
      `${PINNED_EXPRESSION} && workspaceSource === "agent_home"`,
      // Widened rather than narrowed: passes any absence-of-conjunct check.
      `${PINNED_EXPRESSION} || workspaceSource === "agent_home"`,
      // Renamed source field, same defect.
      `runSource === "agent_home" && ${PINNED_EXPRESSION}`,
      // Silently disabled.
      "false",
    ];

    for (const mutation of mutations) {
      const mutated = `  const ${SYMBOL} = ${mutation};`;
      const found = assignmentSites(mutated, "fixture", "fixture.ts");
      expect(found, `fixture not parsed: ${mutation}`).toHaveLength(1);
      expect(found[0].expression, `mutation would survive the guard: ${mutation}`).not.toBe(
        PINNED_EXPRESSION,
      );
    }

    // ...and the pinned form itself must still be accepted, or the guard is red always.
    const clean = assignmentSites(
      `  const ${SYMBOL} = ${PINNED_EXPRESSION};`,
      "fixture",
      "fixture.ts",
    );
    expect(clean).toHaveLength(1);
    expect(clean[0].expression).toBe(PINNED_EXPRESSION);
  });
});
