/**
 * Candidate closure pins from the isolated npm lock and official Node 24.21.0.
 * The non-Node graph is identical across targets, including platform resources.
 * Pi 1.0.0 dependency graphs were independently installed for all three targets.
 * Native platform execution and paid qualification remain separately required.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "282022db10150c6632b3444df421342e7d534bdf5d5fb1097a2e79d0625a2bcf",
  "darwin-x64": "64e251e19009f755c0b04f73ce2138246faab71a961b0f13d75ebfcc34bef12e",
  "linux-x64": "713b1fdff42fb56a1518bdc084f181d70bee8ebadc3e4b1d76321ed9108c8410",
});
