# vendor/

Tarballs that get installed into the running paperclip image because upstream
isn't where we need it yet, or because fresh PVC bootstrap must not depend on
runtime npm installs. Each entry below names the upstream, the divergence, and
how to refresh.

## ccrotate-1.1.0.tgz

Upstream: <https://github.com/somersby10ml/ccrotate> (latest npm release is
1.0.13; 1.1.0 lives only in the user's local checkout at `~/src/ccrotate`).
Needed for `--target codex`, `tier-cache` JSON output, and `serviceTier`
reporting that `server/src/services/ccrotate-tier-gate.ts` reads. Installed as
a global npm package by the kkroo Dockerfile (`COPY vendor/...` + `npm install
-g /tmp/ccrotate.tgz`). Refresh procedure documented inline in the Dockerfile.

## paperclip-adapter-claude-k8s-0.2.1-kkroo.4.tgz

Upstream: <https://github.com/farhoodlabs/paperclip-adapter-claude-k8s> at
v0.2.1. Patches over upstream live in `dist/server/`:

1. **`job-manifest.js`** — `write-prompt` init container's `volumeMounts` add
   the `data` PVC mount so the init container can
   `mkdir -p /paperclip/instances/.../run-logs/...`. Without this every Job
   fails before the main `claude` container starts.
2. **`job-manifest.js`** — main container's command prepends
   `(command -v ccrotate >/dev/null 2>&1 && ccrotate next --target claude >/dev/null 2>&1) || true`
   so each Job pod gets a freshly-rotated OAuth credential before claude
   reads `~/.claude/.credentials.json`. Without this, Job pods inherit a
   cached token whose `expiresAt` may already be past.
3. **`execute.js` `tailPodLogFile`** *(kkroo.2)* — stable-size drain loop +
   trailing pendingLine flush so cephfs propagation lag and missing-trailing-
   newline output don't drop the result event line and surface a successful
   run as `adapter_failed: "Failed to parse Claude JSON output"`.
4. **`execute.js` unknown-session handler** *(kkroo.4 added 2026-04-30)* —
   removes the `(exitCode ?? 0) !== 0` guard around
   `isClaudeUnknownSessionError(parsed)` so a clean-exit-but-unknown-session
   result (`subtype:"error_during_execution"`, `is_error:true`,
   `errors:["No conversation found with session ID..."]`) also triggers
   `clearSession: true` and `errorCode: "session_unavailable"`. Belt-and-
   suspenders complement to the server-side
   `agent_runtime_state.session_id`-clear-on-adapter-flip fix in
   `server/src/routes/agents.ts` (commit `bf30056f`).

Dockerfile installs all `vendor/paperclip-adapter-*.tgz` packages into
`/opt/paperclip-bundled-adapters/node_modules`. The Helm init container writes
typed `adapter-plugins.json` records whose `localPath` points at those image
paths. Adapter code and dependencies are therefore image state, not PVC state.

Keep exactly one tarball per adapter package in `vendor/`; the Dockerfile uses a
wildcard so the version number does not need to be edited there.

## paperclip-adapter-opencode-k8s-0.1.38-kkroo.2.tgz

Upstream npm package `paperclip-adapter-opencode-k8s@0.1.38`, patched to run
`ccrotate snap --target codex --force` and `ccrotate next --target codex --yes`
before `opencode` reads
`/paperclip/.codex/auth.json` in each Job pod. It is bundled into the image for
the same reason as the Claude adapter: the running pod should not depend on npm
or manual PVC package installs to load `opencode_k8s`.

### How to refresh when upstream cuts a new release

```bash
# 1. Pull the new upstream tarball
cd /tmp && rm -rf k8s-fork && mkdir k8s-fork && cd k8s-fork
npm pack paperclip-adapter-claude-k8s@<NEW>
tar -xzf paperclip-adapter-claude-k8s-<NEW>.tgz

# 2. Apply the data-PVC init-container mount patch to dist/server/job-manifest.js:
sed -i 's|volumeMounts: \[{ name: "prompt", mountPath: "/tmp/prompt" }\]|volumeMounts: [{ name: "prompt", mountPath: "/tmp/prompt" }, { name: "data", mountPath: "/paperclip" }]|' \
  package/dist/server/job-manifest.js
sed -i '/^                { name: "prompt", mountPath: "\/tmp\/prompt" },$/a\                { name: "data", mountPath: "/paperclip" },' \
  package/dist/server/job-manifest.js

# 3. Reapply kkroo patches:
#    - ccrotate next command in package/dist/server/job-manifest.js
#    - tailPodLogFile stable-size drain + pendingLine flush in execute.js
#    - unknown-session clearSession handler in execute.js

# 4. Bump version + repack
cd package
python3 -c "import json; p=json.load(open('package.json')); p['version']='<NEW>-kkroo.<N>'; json.dump(p, open('package.json','w'), indent=2)"
npm pack
mv paperclip-adapter-claude-k8s-<NEW>-kkroo.<N>.tgz <kkroo>/vendor/

# 5. Drop the previous .tgz from vendor/. Keep one tarball per adapter package
#    because the Dockerfile copies vendor/paperclip-adapter-*.tgz.

# 6. Watch upstream — once they fix the bug we can drop the fork entirely.
```
