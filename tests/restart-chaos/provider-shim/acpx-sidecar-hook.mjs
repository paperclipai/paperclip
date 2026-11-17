// Restart chaos provider-message faults for ACPX agents: loaded into the wave's server only
// (`NODE_OPTIONS=--import <this file>`, set by the harness). Product code launches the local ACPX
// sidecar from the runner package that owns the module computing the path
// (`runnerd-codex-transport`, from its own `import.meta.url`), and the runner verifies that file's
// digest at launch. This hook loads that one module from the harness's stand-in package (a mirror
// of the runner package whose `dist/cli/acpx-runtime-sidecar.cjs` is the fault stand-in), so the
// digest product code computes and the runner verifies is the stand-in's. A source server loads
// `src/live/runnerd-codex-transport.ts`, a built one `dist/live/runnerd-codex-transport.js`; both
// are covered. Every import the module makes still resolves to the real package, so there is one
// copy of every other module. Product code is unchanged.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const realRoot = process.env.RESTART_CHAOS_ACPX_RUNNER_REAL;
const shadowRoot = process.env.RESTART_CHAOS_ACPX_RUNNER_SHADOW;
const MODULES = ["src/live/runnerd-codex-transport.ts", "dist/live/runnerd-codex-transport.js"];
if (realRoot && shadowRoot) {
  const realPrefix = `${pathToFileURL(realRoot).href}/`;
  const shadowPrefix = `${pathToFileURL(shadowRoot).href}/`;
  const targets = new Set(MODULES.map(module => `${realPrefix}${module}`));
  let announced = false;
  registerHooks({
    resolve(specifier, context, next) {
      // The stand-in module's own imports resolve as the real module's would.
      const parentURL = context.parentURL?.startsWith(shadowPrefix) ? `${realPrefix}${context.parentURL.slice(shadowPrefix.length)}` : context.parentURL;
      const resolved = next(specifier, parentURL === context.parentURL ? context : { ...context, parentURL });
      const url = resolved.url.split("?")[0];
      if (!targets.has(url)) return resolved;
      if (!announced) {
        announced = true;
        process.stderr.write(`[restart-chaos] acpx-sidecar-hook: pid ${process.pid} loads ${url.slice(realPrefix.length)} from the stand-in package\n`);
      }
      return { ...resolved, url: `${shadowPrefix}${resolved.url.slice(realPrefix.length)}`, shortCircuit: true };
    },
  });
}
// The server's children (runner, providers, agent tools) must not load this hook:
// remove only its own option and keep anything else the harness inherited.
const remaining = (process.env.NODE_OPTIONS ?? "").split(/\s+/).filter(option => option && !option.includes("acpx-sidecar-hook")).join(" ");
if (remaining) process.env.NODE_OPTIONS = remaining; else delete process.env.NODE_OPTIONS;
