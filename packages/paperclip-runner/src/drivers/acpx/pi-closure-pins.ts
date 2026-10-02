/**
 * Candidate closure pins from the isolated npm lock and official Node 24.21.0.
 * The non-Node graph is identical across targets, including platform resources.
 * Pi 1.0.0 dependency graphs were independently installed for all three targets.
 * Native platform execution and paid qualification remain separately required.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "f6538a35e08f1c1816e738277a1843acfa1ce4522bbaa3340dbddd859dc7dd04",
  "darwin-x64": "4728e5a4e7fc1ba602c3e219824fb84884b05a06cdd19dd3e521ee312e1b373a",
  "linux-x64": "2957c0ec20ca1ace64d1a2b10c4a99f47f59e0c5c33a89161c1d5b48341c2b25",
});
