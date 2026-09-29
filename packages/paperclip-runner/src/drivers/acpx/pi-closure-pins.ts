/**
 * Candidate closure pins from the isolated npm lock and official Node 24.21.0.
 * The non-Node graph is identical across targets, including platform resources.
 * macOS arm64 executed admission tests; x64 target execution remains pending.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "3703361965d4e0b641fcd5eac4079e9b6c0de47b4b245a5b31b7da7b52c94128",
  "darwin-x64": "885d9fde187bd1a877838ac309aa68df4b928e0727ca341b3b8f3b1e7467ad12",
  "linux-x64": "425afafe8a1419c86333a6eaa93bf56f0e78a4dc919dcef491f13e451550c5e2",
});
