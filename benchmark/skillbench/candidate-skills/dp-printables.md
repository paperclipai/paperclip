# DP Printables

Use `/Users/glad0s/.local/bin/exemplar-studio` from the Exemplar Studio
repository. Do not call the renderer, image tools, browser print, or legacy
generators directly.

Agent-safe commands are `printable doctor`, `list-templates`, `generate`,
`generate-catalogue`, `verify`, and `diff`. Use `--json` and branch on
status/gates/checksums/fingerprint. Exit 0 is success, 2 is a deterministic QA
failure, and 1 is an environment/tool error.

Whole-catalogue work must use `generate-catalogue`, which builds and verifies
Emergency Binder as a green stop-gate before any other SKU. Do not hand-loop
the catalogue.

Agents cannot seal or approve a release, accept review, replace live Etsy
files, publish listing assets, set live/approved pointers, or retire the legacy
pipeline. The CLI hard-refuses `seal`, `approve`, `replace-live`, and
`retire-legacy`. Stop at an immutable Candidate handoff.

Specs own buyer copy, variants, licence, 13-tag listing metadata, pages and
provenance. Require maroon `#620306`, home-print margins, clean/sweary language
purity, spelling, complete/selectable/tagged text, foreground-logo visibility,
listing tiles, repeat-byte determinism and integrity to pass. Never edit a
Candidate; revise the spec and regenerate.
