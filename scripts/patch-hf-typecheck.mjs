#!/usr/bin/env node
import fs from "node:fs";

function patchFile(path, replacements) {
  let source = fs.readFileSync(path, "utf8");
  let changed = false;
  for (const [from, to] of replacements) {
    if (source.includes(to)) continue;
    if (!source.includes(from)) {
      console.warn(`[patch-hf-typecheck] pattern not found in ${path}: ${from}`);
      continue;
    }
    source = source.replace(from, to);
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(path, source, "utf8");
    console.log(`[patch-hf-typecheck] patched ${path}`);
  } else {
    console.log(`[patch-hf-typecheck] no changes needed for ${path}`);
  }
}

patchFile("server/src/routes/access.ts", [
  [
    "(membership) =>\n        membership.companyId === companyId && membership.status === \"active\",",
    "(membership: { companyId?: string; status?: string }) =>\n        membership.companyId === companyId && membership.status === \"active\",",
  ],
]);

patchFile("server/src/routes/authz.ts", [
  [
    "const membership = req.actor.memberships.find((item) => item.companyId === companyId);",
    "const membership = req.actor.memberships.find((item: { companyId?: string; status?: string; membershipRole?: string }) => item.companyId === companyId);",
  ],
]);
