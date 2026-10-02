/**
 * Candidate closure pins from the isolated npm lock and official Node 24.21.0.
 * The non-Node graph is identical across targets, including platform resources.
 * Pi 1.0.0 dependency graphs were independently installed for all three targets.
 * Native platform execution and paid qualification remain separately required.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "e17be4d27c589b8f8b5de7d00686c39873fe6f902a3f133bdaf1a9f94dee00a2",
  "darwin-x64": "03351f4a250a8db0e79411a9079b43a0ff05f72a2aff41fae17f1fc2de24bd41",
  "linux-x64": "29dfc829700c57392f1d56373078dcfc80674cbd50f65674ec64fced81dffb68",
});
