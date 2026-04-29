# vendor/

Tarballs that get installed into the running paperclip image or PVC because
upstream isn't where we need it yet. Each entry below names the upstream, the
divergence, and how to refresh.

## ccrotate-1.1.0.tgz

Upstream: <https://github.com/somersby10ml/ccrotate> (latest npm release is
1.0.13; 1.1.0 lives only in the user's local checkout at `~/src/ccrotate`).
Needed for `--target codex`, `tier-cache` JSON output, and `serviceTier`
reporting that `server/src/services/ccrotate-tier-gate.ts` reads. Installed as
a global npm package by the kkroo Dockerfile (`COPY vendor/...` + `npm install
-g /tmp/ccrotate.tgz`). Refresh procedure documented inline in the Dockerfile.

## paperclip-adapter-claude-k8s-0.2.1-kkroo.1.tgz

Upstream: <https://github.com/farhoodlabs/paperclip-adapter-claude-k8s> at
v0.2.1. Diverges in **two** places — the small-prompt and large-prompt
branches in `dist/server/job-manifest.js` — to add a missing `data` PVC mount
to the `write-prompt` init container's `volumeMounts`. Without that mount the
init container can't `mkdir -p /paperclip/instances/.../run-logs/...` and
every Job fails before reaching the main `claude` container. Bug write-up:
`~/.claude/projects/.../memory/claude_k8s_adapter_init_volumemount_bug.md`.

### How to install on a running paperclip-0 pod

This adapter does NOT auto-install via the kkroo bootstrap; install once after
each fresh PVC:

```bash
# 1. Copy the tarball into the pod
kubectl -n paperclip cp \
  vendor/paperclip-adapter-claude-k8s-0.2.1-kkroo.1.tgz \
  paperclip/paperclip-0:/tmp/p-claude-k8s.tgz

# 2. Extract on the pod (preserve existing node_modules):
kubectl -n paperclip exec paperclip-0 -- bash -c '
  mkdir -p /tmp/p-claude-k8s
  tar -xzf /tmp/p-claude-k8s.tgz -C /tmp/p-claude-k8s --strip-components=1

  # First time only: install the upstream adapter so node_modules gets seeded.
  # Existing kkroo deployments already have this from the original
  #   POST /api/adapters/install paperclip-adapter-claude-k8s
  # call. Skip if /paperclip/adapter-plugins/node_modules/paperclip-adapter-claude-k8s
  # already exists.

  # Overlay the patched dist/* + package.json onto the installed copy:
  rsync -a --exclude=node_modules /tmp/p-claude-k8s/ \
    /paperclip/adapter-plugins/node_modules/paperclip-adapter-claude-k8s/
'

# 3. Reload the adapter (clears Node module cache; or restart paperclip-0 if
# the reload endpoint isn't enough):
TOKEN=<your pcp_board_* token>
kubectl -n paperclip exec paperclip-0 -- curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:3100/api/adapters/claude_k8s/reload

# 4. Verify:
kubectl -n paperclip exec paperclip-0 -- \
  grep version /paperclip/adapter-plugins/node_modules/paperclip-adapter-claude-k8s/package.json
# expect 0.2.1-kkroo.1
```

### How to refresh when upstream cuts a new release

```bash
# 1. Pull the new upstream tarball
cd /tmp && rm -rf k8s-fork && mkdir k8s-fork && cd k8s-fork
npm pack paperclip-adapter-claude-k8s@<NEW>
tar -xzf paperclip-adapter-claude-k8s-<NEW>.tgz

# 2. Apply the same two seds to dist/server/job-manifest.js:
sed -i 's|volumeMounts: \[{ name: "prompt", mountPath: "/tmp/prompt" }\]|volumeMounts: [{ name: "prompt", mountPath: "/tmp/prompt" }, { name: "data", mountPath: "/paperclip" }]|' \
  package/dist/server/job-manifest.js
sed -i '/^                { name: "prompt", mountPath: "\/tmp\/prompt" },$/a\                { name: "data", mountPath: "/paperclip" },' \
  package/dist/server/job-manifest.js

# 3. Bump version + repack
cd package
python3 -c "import json; p=json.load(open('package.json')); p['version']='<NEW>-kkroo.1'; json.dump(p, open('package.json','w'), indent=2)"
npm pack
mv paperclip-adapter-claude-k8s-<NEW>-kkroo.1.tgz <kkroo>/vendor/

# 4. Drop the previous .tgz from vendor/ if it's no longer referenced.

# 5. Watch upstream — once they fix the bug we can drop the fork entirely.
```
