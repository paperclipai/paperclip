# PROVENANCE — vendor/lifecycle-guard/core.js

Byte-identical vendored copy of the lifecycle-guard v1-b policy core from the staged
gateway plugin bundle `/home/node/.openclaw/plugins-local/lifecycle-guard/lib/core.js`.

- sha256: `746791a2b187bcf8d7c30b3540732813a88d01e3a69e90a3e52191f6bed3f492`
  (the SON-4142 executed-byte pin recorded on Paperclip SON-3671).
- Vendored for `server/src/services/lifecycle-guard-wake-field.ts` (SON-4117,
  rollout-checklist Step 6, control-plane side) so the wake-payload orphan predicate
  is byte-identical to the plugin/enforcement core.
- Sync test: `server/src/__tests__/lifecycle-guard-vendored-core.test.ts` asserts this
  sha256; update both together and re-pin on the parent card.
- The server tsconfig has `rootDir: src` and does not compile `.js` sources, so the
  package build copies `src/vendor/lifecycle-guard/` into
  `dist/vendor/lifecycle-guard/` (same pattern as `dist/services/scripts`).
