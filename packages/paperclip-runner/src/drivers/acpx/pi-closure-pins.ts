/**
 * Candidate closure pins from the isolated npm lock and official Node 24.21.0.
 * The non-Node graph is identical across targets, including platform resources.
 * Pi 1.0.0 dependency graphs were independently installed for all three targets.
 * Native platform execution and paid qualification remain separately required.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "fcf42f6800779feb3af0fabee107f3330d07841bbbccd44b6d6aa693b35d86a4",
  "darwin-x64": "46b8147a5607aa73a57280666f0a73a111c3c5c3237373abcc3beb385283af89",
  "linux-x64": "fc61eaf81deed2c059f9f7d856a8ea54bb3a3911d1cf8d6cf6801650d141320c",
});
