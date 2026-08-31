/**
 * Public test-only surface for deterministic fixtures and conformance kits.
 *
 * Production consumers import the package root. Tests import this explicit
 * subpath so Node-only fixture loading and comparison helpers cannot become an
 * accidental production dependency.
 */
export * from "./index.js";
export * from "./conformance/control-plane-port.js";
export * from "./conformance/harness-driver.js";
export * from "./conformance/semantic-conformance.js";
export * from "./mock-core/deterministic-harness-driver.js";
export * from "./mock-core/mock-control-plane-adapter.js";
export * from "./mock-core/capability-control-plane-types.js";
export * from "./mock-core/capability-mock-control-plane-adapter.js";
export * from "./protocol/conformance-fixture.js";
export * from "./protocol/replay-loader.js";
export * from "./tracer/conformance-runner.js";
