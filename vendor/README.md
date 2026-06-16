# vendor/

This directory does **not** hold tarballs anymore — the Dockerfile builds the
vendored packages from source in a dedicated `vendor` build stage and `COPY
--from=vendor` ships only the resulting `.tgz` into the final image. No build
artifacts (`.tgz`, `dist/`, `node_modules/`, etc.) are committed to this repo.

## Vendored packages

Each fork is pinned by commit SHA in the Dockerfile's `ARG *_REF` lines.

### paperclip-adapter-claude-k8s

- Fork: <https://github.com/kkroo/paperclip-adapter-claude-k8s>
- Upstream: <https://github.com/farhoodlabs/paperclip-adapter-claude-k8s>
- What's vendored over upstream:
  1. `job-manifest.js` — `write-prompt` init container mounts the `data`
     PVC so it can `mkdir -p /paperclip/instances/.../run-logs/...`.
  2. `execute.js` `tailPodLogFile` — stable-size drain loop + trailing
     `pendingLine` flush so cephfs propagation lag does not surface a
     successful run as `adapter_failed: "Failed to parse Claude JSON output"`.
  3. `execute.js` unknown-session handler — clean-exit-but-unknown-session
     results trigger `clearSession: true` and
     `errorCode: "session_unavailable"`.
  4. `k8s-client.js` + `job-manifest.js` — Job pods inherit the parent
     Paperclip pod's `nodeSelector` and `tolerations` by default; explicit
     adapter config still overrides.

### paperclip-adapter-opencode-k8s

- Fork: <https://github.com/kkroo/paperclip-adapter-opencode-k8s>
- Upstream: <https://github.com/farhoodlabs/paperclip-adapter-opencode-k8s>
- What's vendored over upstream: parent-pod scheduling inheritance matching the
  claude adapter. Older adapter preflights still check `command -v ccrotate`,
  but Paperclip no longer installs a local `ccrotate` binary in the production
  image; provider routing is owned by ccrotate-serve/state.

## How to refresh

1. Cut the change against the relevant kkroo fork on github (push directly
   or via PR + merge).
2. Bump the corresponding `*_REF` ARG in the Dockerfile to the new commit
   SHA. Pinning by SHA (not branch name) keeps image builds reproducible.
3. Build the image. The `vendor` stage clones the fork at the pinned SHA,
   runs the package's build, and packs the result.
