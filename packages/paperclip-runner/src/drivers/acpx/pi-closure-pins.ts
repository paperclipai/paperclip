/**
 * Candidate closure pins from the isolated npm lock and official Node 24.21.0.
 * The non-Node graph is identical across targets, including platform resources.
 * Pi 1.0.0 dependency graphs were independently installed for all three targets.
 * Native platform execution and paid qualification remain separately required.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "0eb9dc05031551461f80594a5a449af1c34785e0544ad927e7a57ef1bcfe2e32",
  "darwin-x64": "5651bca5f8a11c05d753c4da1d3c90b022fabaaa891989372ee874f0ab8b8214",
  "linux-x64": "863b30b0ab85fb3ca92a38678af58a8b1dae40c9e50da5e319b57aecb524064d",
});
