// Restart chaos provider-message faults for ACPX agents: loaded into the wave's server only
// (`NODE_OPTIONS=--import <this file>`, set by the harness). Product code launches the local ACPX
// sidecar from the runner package that owns the module computing the path
// (`dist/live/runnerd-codex-transport.js`, from its own `import.meta.url`), and the runner verifies
// that file's digest at launch. This hook loads that one module from the harness's stand-in package
// (a mirror of the runner package whose `dist/cli/acpx-runtime-sidecar.cjs` is the fault stand-in),
// so the digest product code computes and the runner verifies is the stand-in's. Every import the
// module makes still resolves to the real package, so there is one copy of every other module.
// Product code is unchanged.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const real = process.env.RESTART_CHAOS_ACPX_TRANSPORT_REAL;
const shadow = process.env.RESTART_CHAOS_ACPX_TRANSPORT_SHADOW;
if (real && shadow) {
  const realUrl = pathToFileURL(real).href;
  const shadowUrl = pathToFileURL(shadow).href;
  registerHooks({
    resolve(specifier, context, next) {
      // The stand-in's own imports resolve as the real module's would.
      const parentURL = context.parentURL === shadowUrl ? realUrl : context.parentURL;
      const resolved = next(specifier, parentURL === context.parentURL ? context : { ...context, parentURL });
      if (resolved.url === realUrl) return { ...resolved, url: shadowUrl, format: "module", shortCircuit: true };
      return resolved;
    },
  });
}
// The server's children (runner, providers, agent tools) must not load this hook:
// remove only its own option and keep anything else the harness inherited.
const remaining = (process.env.NODE_OPTIONS ?? "").split(/\s+/).filter(option => option && !option.includes("acpx-sidecar-hook")).join(" ");
if (remaining) process.env.NODE_OPTIONS = remaining; else delete process.env.NODE_OPTIONS;
