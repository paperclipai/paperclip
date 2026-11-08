# Standard production image provenance

Canonical `master` pushes publish the standard multi-platform `production`
image at `ghcr.io/paperclipai/paperclip:sha-<full-40-character-SHA>`.
Existing short-SHA, version and channel tags continue to work. Other refs and
manual dispatches do not write the canonical full-SHA tag.

The Docker workflow validates the index contains exactly one Linux amd64 and
one Linux arm64 image, verifies orphan reaping against its immutable digest,
and signs that digest using GitHub artifact attestations. The signer is
`paperclipai/paperclip/.github/workflows/docker.yml@refs/heads/master`.
Consumers must verify the signed source SHA, repository identity and ref,
then compose from the verified digest, never from the mutable lookup tag.
A missing attestation means this producer contract is not available for that
commit. The presence of a tag alone is insufficient.

This proves image provenance, not all application tests. Downstream services
must also require their source verification and migration compatibility gates.
No downstream repository names, credentials or dependencies are needed here.
The separate `-cloud` image producer remains available during migration.

Local contract validation: `node --test scripts/standard-image-contract.test.mjs`.
Actual signing runs only after a canonical master build; a PR cannot publish
trusted provenance.
