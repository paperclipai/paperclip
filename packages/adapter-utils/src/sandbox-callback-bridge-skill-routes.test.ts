import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authorizeSandboxCallbackBridgeRequestWithRoutes } from "./sandbox-callback-bridge.js";

const SKILL_DIR = new URL("../../../skills/paperclip/", import.meta.url);
const SECTION_HEADING = "## Routes Unavailable Inside a Sandbox";
const METHODS = "GET|POST|PUT|PATCH|DELETE";
const ROUTE_PATTERN = new RegExp(
  `\\b((?:${METHODS})(?:\\\\?\\|(?:${METHODS}))*)\\s*(?:\\|\\s*)?\`?(?:\\$\\{?PAPERCLIP_API_URL\\}?)?(\\/(?:api|llms|runtime-tools)\\/[^\\s\`"')]+)`,
  "g",
);

interface DocumentedRoute {
  method: string;
  variants: string[];
  source: string;
}

function readSkillDocs(): Array<{ name: string; text: string }> {
  const references = readdirSync(new URL("references/", SKILL_DIR))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `references/${name}`);
  return ["SKILL.md", ...references].map((name) => ({
    name,
    text: readFileSync(new URL(name, SKILL_DIR), "utf8"),
  }));
}

function expandPath(raw: string): string[] {
  const trimmed = raw.replace(/\[\?.*$/, "").split("?")[0]!.replace(/[.,;:]+$/, "");
  let variants = [trimmed];
  const optional = /\[([^\]]*)\]/;
  while (variants.some((v) => optional.test(v))) {
    variants = variants.flatMap((v) => {
      const match = optional.exec(v);
      if (!match) return [v];
      return [v.replace(match[0], ""), v.replace(match[0], match[1]!)];
    });
  }
  const alternation = /\{([^}]*,[^}]*)\}/;
  while (variants.some((v) => alternation.test(v))) {
    variants = variants.flatMap((v) => {
      const match = alternation.exec(v);
      if (!match) return [v];
      return match[1]!.split(",").map((option) => v.replace(match[0], option.trim()));
    });
  }
  return variants.map((v) => v.replace(/\{[^}]+\}|:[A-Za-z_]+|<[^>]+>|\$\{?[A-Za-z_]+\}?/g, "x"));
}

function documentedRoutes(docs: Array<{ name: string; text: string }>): DocumentedRoute[] {
  const routes: DocumentedRoute[] = [];
  for (const doc of docs) {
    for (const match of doc.text.matchAll(ROUTE_PATTERN)) {
      const variants = expandPath(match[2]!);
      for (const method of match[1]!.split(/\\?\|/)) {
        routes.push({ method, variants, source: doc.name });
      }
    }
  }
  return routes;
}

function sandboxSection(docs: Array<{ name: string; text: string }>): string {
  const reference = docs.find((doc) => doc.name === "references/api-reference.md")!;
  const start = reference.text.indexOf(SECTION_HEADING);
  if (start === -1) throw new Error(`api-reference.md has no "${SECTION_HEADING}" section`);
  const rest = reference.text.slice(start + SECTION_HEADING.length);
  const end = rest.search(/\n(?:## |---)/);
  return end === -1 ? rest : rest.slice(0, end);
}

function listedRoutes(section: string): Array<{ method: string; path: string; pattern: RegExp }> {
  return [...section.matchAll(new RegExp(`\`(${METHODS}) (\\/[^\`]+)\``, "g"))].map((match) => ({
    method: match[1]!,
    path: match[2]!,
    pattern: new RegExp(`^${match[2]!.replace(/:[A-Za-z_]+/g, "[^/]+")}$`),
  }));
}

const isAllowed = (method: string, path: string) =>
  authorizeSandboxCallbackBridgeRequestWithRoutes({ method, path }) === null;

describe("paperclip skill routes and the sandbox callback bridge allowlist", () => {
  const docs = readSkillDocs();
  const listed = listedRoutes(sandboxSection(docs));

  it("lists every documented route the bridge refuses", () => {
    const unlisted = documentedRoutes(docs)
      .filter(({ method, variants }) =>
        !variants.some(
          (path) =>
            isAllowed(method, path) ||
            listed.some((route) => route.method === method && route.pattern.test(path)),
        ),
      )
      .map(({ method, variants, source }) => `${method} ${variants[0]} (${source})`);

    expect([...new Set(unlisted)]).toEqual([]);
  });

  it("lists only routes the bridge actually refuses", () => {
    expect(listed.length).toBeGreaterThan(0);
    const allowed = listed
      .filter((route) => isAllowed(route.method, route.path.replace(/:[A-Za-z_]+/g, "x")))
      .map((route) => `${route.method} ${route.path}`);

    expect(allowed).toEqual([]);
  });

  it("names the diagnostics and project workspace reads seen refused in sandboxed runs", () => {
    const names = listed.map((route) => `${route.method} ${route.path}`);
    expect(names).toEqual(
      expect.arrayContaining([
        "GET /api/issues/:issueId/diagnostics/blockers",
        "GET /api/issues/:issueId/diagnostics/wakes",
        "GET /api/issues/:issueId/diagnostics/subtree",
        "GET /api/projects/:projectId/workspaces",
      ]),
    );
  });
});
