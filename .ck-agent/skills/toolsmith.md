# Skill: toolsmith — how CK tools come to exist
A "tool" is a function in the plugin `plugin-ck-office` (TypeScript), registered
in `tools.ts` AND declared in `manifest.ts`, then built and hot-upgraded into
Paperclip. Agents only see tools listed in their CK_TOOLS allowlist (org map
shows every unit's list). Lifecycle: gap found → TOOLSMITH-01 writes spec +
acceptance tests → owner approves via decision request → owner-approved coding session
implements, tests, deploys, allowlists → org map regenerated. A tool exists
ONLY when it shows up in the org map. Good specs are small: one job, explicit
params, guard rails stated as refusals, and tests an implementer can run.
