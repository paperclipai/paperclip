import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const protectedFields = new Set(["pauseReason", "pausedAt", "lifecycleState", "lifecycleVersion", "lifecycleError", "lifecycleOperation", "lifecycleParticipants", "lifecycleHolds"]);
export function agentLifecycleWriteViolations(source) {
  const aliases = [...source.matchAll(/\bagents(?:\s+as\s+(\w+))?\s*[,}]/g)].map(match => match[1] ?? "agents");
  const violations = [];
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  for (const alias of new Set(aliases)) {
    for (const match of text.matchAll(new RegExp(`\\.(insert|delete|update)\\(\\s*${alias}\\s*\\)([^;]*)`, "g"))) {
      const [, operation, chain] = match;
      if (operation !== "update") { violations.push(`Use the agent lifecycle module to ${operation} an agent`); continue; }
      for (const field of protectedFields) {
        if (new RegExp(`(?<![\\w.])${field}\\s*(?=:|[,}])`).test(chain)) violations.push(`Use the agent lifecycle module to change ${field}`);
      }
      if (/\bstatus\s*:/.test(chain) && !chain.includes(`eq(${alias}.lifecycleState, "ready")`)) {
        violations.push("An execution status write must require lifecycleState ready");
      }
    }
  }
  return violations;
}

export function scanAgentLifecycleBoundaries(root = resolve(fileURLToPath(new URL("..", import.meta.url)))) {
  const violations = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", "__tests__"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      const label = relative(root, path);
      if (label.includes("modules/agent-lifecycle/")) continue;
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
        for (const reason of agentLifecycleWriteViolations(readFileSync(path, "utf8"), label)) violations.push(`${label}: ${reason}`);
      }
    }
  }
  for (const directory of ["server/src", "server/scripts", "cli/src", "packages/db/src"]) walk(resolve(root, directory));
  return violations;
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const violations = scanAgentLifecycleBoundaries();
  if (violations.length) { console.error(violations.join("\n")); process.exitCode = 1; }
  else console.log("Agent lifecycle write boundary check passed.");
}
