/**
 * Public test-only surface for deterministic fixtures and conformance kits.
 *
 * Production consumers import the package root. Tests import this explicit
 * subpath so Node-only fixture loading and comparison helpers cannot become an
 * accidental production dependency.
 */
export * from "./index.js";
export * from "./conformance/semantic-conformance.js";
export * from "./protocol/replay-loader.js";
