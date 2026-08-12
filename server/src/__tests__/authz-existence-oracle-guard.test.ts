import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static guard against the cross-tenant existence oracle.
 *
 * Route handlers that look a resource up by id and then call
 * `assertCompanyAccess(req, resource.companyId)`, or a local wrapper helper
 * that internally calls it, leak resource existence across tenants: missing ids
 * return 404 while cross-tenant ids return 403, letting any authenticated user
 * enumerate other tenants' ids. The required pattern (documented on
 * `hasCompanyAccess` in routes/authz.ts) folds the access check into the
 * existence check:
 *
 *     const issue = await svc.getById(id);
 *     if (!issue || !hasCompanyAccess(req, issue.companyId)) {
 *       res.status(404).json({ error: "Issue not found" });
 *       return;
 *     }
 *     assertCompanyAccess(req, issue.companyId); // write paths only
 *
 * This test scans every route file and fails when it finds a company access
 * assertion on `req, <resource>.companyId` that is not preceded by a
 * `hasCompanyAccess(req, <resource>.companyId)`-style gate. Sites where the
 * companyId comes from request input (params/body) rather than a looked-up
 * resource carry no oracle and belong on the allowlist below.
 */

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");

// "<file>:<variable>" call sites where the companyId is request input, not a
// discovered resource. Add new entries only when the value cannot reveal
// whether a cross-tenant resource exists.
const REQUEST_INPUT_ALLOWLIST = new Set([
  "companies.ts:target", // import target chosen by the caller (req.body.target)
  "plugins.ts:runContext", // run context supplied in the request body
]);

const GATE_LOOKBACK_LINES = 12;

const COMPANY_ACCESS_ASSERTION_HELPERS = [
  "assertCompanyAccess",
  "assertBoardToolPermission",
  "assertBoardAnyToolPermission",
  "assertToolAppMutationAccess",
  "assertToolsAdmin",
  "assertToolsRuntimeManage",
] as const;

const LOOKED_UP_RESOURCE_GATE_HELPERS = [
  "hasCompanyAccess",
  "assertLookedUpToolResourceAccess",
] as const;

function helperAlternation(helpers: readonly string[]) {
  return helpers.join("|");
}

const companyAccessAssertionPattern = new RegExp(
  `\\b(${helperAlternation(COMPANY_ACCESS_ASSERTION_HELPERS)})\\(req,\\s*(\\w+)\\.companyId\\b`,
);

function gatePatternFor(variable: string) {
  return new RegExp(
    `\\b(${helperAlternation(LOOKED_UP_RESOURCE_GATE_HELPERS)})\\(req,\\s*${variable}\\.companyId\\b`,
  );
}

function assertionPatternFor(variable: string) {
  return new RegExp(
    `\\b(${helperAlternation(COMPANY_ACCESS_ASSERTION_HELPERS)})\\(req,\\s*${variable}\\.companyId\\b`,
  );
}

function findUngatedSites() {
  const ungated: string[] = [];
  for (const file of readdirSync(ROUTES_DIR).filter((name) => name.endsWith(".ts"))) {
    if (file === "authz.ts") continue;
    const lines = readFileSync(join(ROUTES_DIR, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      const match = line.match(companyAccessAssertionPattern);
      if (!match) return;
      const [, helper, variable] = match;
      if (!helper || !variable) return;
      const lookback = lines
        .slice(Math.max(0, index - GATE_LOOKBACK_LINES), index)
        .join("\n");
      if (gatePatternFor(variable).test(lookback)) return;
      if (REQUEST_INPUT_ALLOWLIST.has(`${file}:${variable}`)) return;
      ungated.push(`${file}:${index + 1} (${helper} on ${variable}.companyId)`);
    });
  }
  return ungated;
}

describe("cross-tenant existence oracle guard", () => {
  it("requires a 404 gate before company access wrappers on looked-up resources", () => {
    const ungated = findUngatedSites();
    expect(
      ungated,
      "Company access wrappers on a looked-up resource without a hasCompanyAccess 404 gate "
        + "reintroduce the cross-tenant existence oracle (403 vs 404). "
        + "Apply the two-step pattern documented on hasCompanyAccess in routes/authz.ts, "
        + "or, only if the companyId is request input, add the site to REQUEST_INPUT_ALLOWLIST. "
        + `Offending sites: ${ungated.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the allowlist free of stale entries", () => {
    const stale: string[] = [];
    for (const entry of REQUEST_INPUT_ALLOWLIST) {
      const [file, variable] = entry.split(":");
      const source = readFileSync(join(ROUTES_DIR, file!), "utf8");
      if (!variable || !assertionPatternFor(variable).test(source)) {
        stale.push(entry);
      }
    }
    expect(stale, `Allowlist entries no longer present in the code: ${stale.join(", ")}`).toEqual([]);
  });
});
