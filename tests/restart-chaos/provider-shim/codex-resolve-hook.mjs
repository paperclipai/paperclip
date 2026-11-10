// Restart chaos provider-message faults: loaded into the wave's server only
// (`NODE_OPTIONS=--import <this file>`, set by the harness). Product code
// resolves the local Codex executable through the installed
// `@openai/codex/package.json`; this hook answers that one lookup with the
// harness's stand-in package, whose `codex` bin is the fault shim in front of
// the real Codex. Nothing else resolves differently, and product code is unchanged.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const target = process.env.RESTART_CHAOS_CODEX_PACKAGE_JSON;
if (target) {
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@openai/codex/package.json") return { url: pathToFileURL(target).href, format: "json", shortCircuit: true };
      return next(specifier, context);
    },
  });
}
// The server's children (runner, providers, agent tools) must not load this hook:
// remove only its own option and keep anything else the harness inherited.
const remaining = (process.env.NODE_OPTIONS ?? "").split(/\s+/).filter(option => option && !option.includes("codex-resolve-hook")).join(" ");
if (remaining) process.env.NODE_OPTIONS = remaining; else delete process.env.NODE_OPTIONS;
