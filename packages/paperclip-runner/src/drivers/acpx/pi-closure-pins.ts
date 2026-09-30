/**
 * Candidate closure pins from the isolated npm lock and official Node 24.21.0.
 * The non-Node graph is identical across targets, including platform resources.
 * macOS arm64 executed admission tests; x64 target execution remains pending.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "0187153354338cf4919d213dd2977e1be1073ad3941c7b9b5c8a09c5b32828e4",
  "darwin-x64": "22c593576e78edb27bbe6234aabd31a7d65f6be7503683f568d0730ebe6c75a0",
  "linux-x64": "016ce3653bdfc1c7269e3bf7d4bf26e48b0d0b7d409fd153f3f1b882e986654d",
});
