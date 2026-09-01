/**
 * Public test-only surface for deterministic adapters and conformance kits.
 *
 * Production Paperclip code imports the package root. Tests, Paperclip Evals,
 * and other conformance consumers import this explicit subpath so test helpers
 * never become an accidental runtime dependency.
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
