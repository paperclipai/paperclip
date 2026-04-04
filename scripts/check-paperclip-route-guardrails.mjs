#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, "..");

const defaultTargets = [
  "agents.ts",
  "approvals.ts",
  "companies.ts",
  "costs.ts",
  "issues.ts",
  "projects.ts",
  "goals.ts",
  "assets.ts",
  "company-skills.ts",
  "execution-workspaces.ts",
  "routines.ts",
  "secrets.ts",
  "activity.ts",
];

function parseArgs(argv) {
  const result = {
    root: defaultRoot,
    only: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      result.root = path.resolve(argv[i + 1] ?? defaultRoot);
      i += 1;
      continue;
    }
    if (arg === "--only") {
      result.only = (argv[i + 1] ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    }
  }

  return result;
}

function requireIncludes(source, file, patterns) {
  return patterns
    .filter((pattern) => !source.includes(pattern))
    .map((pattern) => `${file}: missing required pattern "${pattern}"`);
}

const parsed = parseArgs(process.argv.slice(2));
const targets = parsed.only ?? defaultTargets;
const routeRoot = path.join(parsed.root, "server", "src", "routes");
const errors = [];

for (const file of targets) {
  const fullPath = path.join(routeRoot, file);
  if (!fs.existsSync(fullPath)) {
    errors.push(`${file}: route file not found under ${routeRoot}`);
    continue;
  }

  const source = fs.readFileSync(fullPath, "utf8");

  if (file === "activity.ts") {
    // This route writes directly to the activity stream via svc.create().
    // Requiring logActivity() here would create a second activity event for the same write.
    errors.push(
      ...requireIncludes(source, file, [
        "assertCompanyAccess",
        "assertBoard",
        'router.post("/companies/:companyId/activity"',
        "svc.create(",
      ]),
    );
    continue;
  }

  errors.push(...requireIncludes(source, file, ["assertCompanyAccess", "logActivity"]));

  if (file === "issues.ts") {
    errors.push(
      ...requireIncludes(source, file, [
        'router.post("/issues/:id/checkout"',
        "res.status(409).json",
        "requireAgentRunId",
      ]),
    );
  }
}

if (errors.length > 0) {
  console.error("[paperclip-route-guardrails] Guardrail check failed.\n");
  console.error(errors.map((entry) => `- ${entry}`).join("\n"));
  process.exit(1);
}

console.log("[paperclip-route-guardrails] Guardrail check passed.");
console.log(`  checked files: ${targets.join(", ")}`);
