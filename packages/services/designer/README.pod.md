# designer — pod / Linux container deployment

This is a deployment guide for running `designer` inside a Kubernetes pod where
the agent (Claude Code, paperclip-agent, or any other AI agent) is the workload.

It deliberately keeps the agent identity model in mind: each pod has its **own**
Google account profile (e.g. an `ally@blockcast.net` workspace seat per agent),
*not* a borrowed human session. Profile cookies are scoped to the agent.

The container model trades the desktop "real Chrome window" assumption for
**real Chrome on a virtual display (Xvfb)** — still headful from
Cloudflare's/Google's bot-detection perspective, but with no display surface
attached.

## Architecture in one diagram

```
┌─────────────────────────────────────────── pod ────────────────────────────────────────────┐
│                                                                                              │
│    ┌──── /opt/designer (CLI + MCP, npm-global) ────┐    ┌────── /data ──────┐               │
│    │                                                │    │ (PVC mount)        │              │
│    │  agent ──MCP stdio──> designer ──CDP─┐         │    │                    │              │
│    └──────────────────────────────────────┼─────────┘    │ chrome-designer-   │              │
│                                            │              │   profile/        │ ◄─ seeded by │
│    ┌────────── Xvfb :99 ─────────────┐    │              │   ├── Cookies      │   Secret or  │
│    │  virtual 1920×1080 X server      │ ◄──┼─DISPLAY─────│   ├── Login Data    │   PVC init   │
│    └──────────────────────────────────┘    │              │   └── ...          │              │
│                                            ▼              └────────────────────┘              │
│    ┌────────── chrome --remote-debugging-port=9222 ──────────────────────┐                   │
│    │     --user-data-dir=/data/chrome-designer-profile                    │                   │
│    │     --no-sandbox --disable-dev-shm-usage                             │                   │
│    └──────────────────────────────────────────────────────────────────────┘                   │
│                                                                                                │
│    /usr/local/bin/designer-entrypoint     (tini supervises)                                   │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Image build

```bash
docker buildx build --platform linux/amd64 \
  -t blockcast/designer-runtime:pod \
  -f Dockerfile.pod .
```

This builds **just** the designer runtime (Chrome + Xvfb + agent-browser +
designer global). Layer your agent (paperclip-agent, claude-code, etc.) on top:

```Dockerfile
FROM blockcast/designer-runtime:pod
# install your agent
RUN npm i -g @anthropic-ai/claude-code
CMD ["claude"]
```

Or use multi-stage `COPY --from=blockcast/designer-runtime:pod` if you want
finer control over the layering.

## Profile bootstrap (one-time, per agent identity)

`designer` requires a signed-in claude.ai/design session. In a pod, the human
sign-in step has to happen *outside* the pod, and the resulting profile is
mounted in.

Two paths, depending on profile size after pruning.

### Path A — Secret (preferred when profile fits in 1 MiB)

On any machine with Chrome:

```bash
# 1. Launch a clean Chrome with a fresh profile.
mkdir -p /tmp/bootstrap-profile
google-chrome \
  --user-data-dir=/tmp/bootstrap-profile \
  --remote-debugging-port=9333 \
  https://claude.ai/design &

# 2. Sign in as the agent identity (e.g. ally@blockcast.net).
#    Complete any 2FA. Land on claude.ai/design (not /login).

# 3. Quit Chrome. Then prune the profile to just auth-related artifacts:
cd /tmp/bootstrap-profile/Default
PRUNED=/tmp/profile-pruned/Default
mkdir -p "$PRUNED"
cp Cookies "$PRUNED/" 2>/dev/null || true
cp "Login Data" "$PRUNED/" 2>/dev/null || true
cp Preferences "$PRUNED/" 2>/dev/null || true
cp Web\ Data "$PRUNED/" 2>/dev/null || true
cp -r Local\ Storage "$PRUNED/" 2>/dev/null || true
cp ../Local\ State /tmp/profile-pruned/ 2>/dev/null || true

# 4. Pack + size-check.
tar -czf /tmp/profile-pruned.tar.gz -C /tmp/profile-pruned .
ls -la /tmp/profile-pruned.tar.gz
# Must be < ~750 KiB after base64 (Secret cap is 1 MiB, base64 inflates 33%).

# 5. Create the Secret (one per agent identity).
kubectl -n paperclip create secret generic designer-profile-ally \
  --from-file=profile.tar.gz=/tmp/profile-pruned.tar.gz
```

Pod spec mounts the Secret as a file and points `DESIGNER_PROFILE_BOOTSTRAP`
at it; the entrypoint extracts it into `DESIGNER_CHROME_PROFILE` on first boot:

```yaml
env:
  - name: DESIGNER_CHROME_PROFILE
    value: /data/chrome-designer-profile
  - name: DESIGNER_PROFILE_BOOTSTRAP
    value: /etc/designer-bootstrap/profile.tar.gz
volumeMounts:
  - name: profile
    mountPath: /data
  - name: bootstrap
    mountPath: /etc/designer-bootstrap
    readOnly: true
volumes:
  - name: profile
    persistentVolumeClaim:
      claimName: designer-profile-ally     # writable, survives pod restarts
  - name: bootstrap
    secret:
      secretName: designer-profile-ally
      defaultMode: 0400
```

After first boot the PVC has the profile, the Secret remains as a safety
re-seed but the entrypoint skips re-extracting (idempotent — only seeds
empty profile dirs).

### Path B — PVC seed (profile too big for a Secret)

If even the pruned profile exceeds 1 MiB (rare, but possible with extensive
`Local Storage` state), upload the tarball to Ceph RGW instead:

```bash
# Upload to a per-agent bucket.
mc cp /tmp/profile-pruned.tar.gz blockcast-rgw/designer-bootstrap/ally.tar.gz

# Use an initContainer to seed the PVC on first boot:
initContainers:
  - name: seed-profile
    image: amazon/aws-cli:latest
    command: [/bin/sh, -c]
    args:
      - |
        if [ ! -f /data/chrome-designer-profile/Cookies ]; then
          mkdir -p /data/chrome-designer-profile
          aws s3 cp s3://designer-bootstrap/ally.tar.gz /tmp/bootstrap.tar.gz \
            --endpoint-url https://ceph-rgw.internal
          tar -xzf /tmp/bootstrap.tar.gz -C /data/chrome-designer-profile
        fi
    envFrom:
      - secretRef:
          name: designer-rgw-creds
    volumeMounts:
      - name: profile
        mountPath: /data
```

Same Pod-level mount as Path A, minus the `bootstrap` volume.

## Pod spec essentials

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: designer-uxdesigner
  namespace: paperclip
spec:
  replicas: 1                  # Chrome profiles are not concurrency-safe; 1 per agent identity.
  selector: {matchLabels: {app: designer, agent: ally}}
  template:
    metadata:
      labels: {app: designer, agent: ally}
    spec:
      containers:
        - name: agent
          image: blockcast/designer-runtime:pod   # plus the agent layered on
          env:
            - name: DESIGNER_CDP
              value: "9222"
            - name: DESIGNER_CHROME_PROFILE
              value: /data/chrome-designer-profile
            - name: DESIGNER_PROFILE_BOOTSTRAP
              value: /etc/designer-bootstrap/profile.tar.gz
            - name: DESIGNER_DISPLAY
              value: ":99"
          resources:
            requests: {cpu: 500m, memory: 1Gi}
            limits:   {cpu: 2,    memory: 3Gi}    # Chrome alone wants ~1.5 GiB.
          volumeMounts:
            - {name: profile,   mountPath: /data}
            - {name: bootstrap, mountPath: /etc/designer-bootstrap, readOnly: true}
            - {name: dshm,      mountPath: /dev/shm}
            - {name: run,       mountPath: /run/designer}
      volumes:
        - name: profile
          persistentVolumeClaim: {claimName: designer-profile-ally}
        - name: bootstrap
          secret: {secretName: designer-profile-ally, defaultMode: 0400}
        - name: dshm                              # /dev/shm default 64M is too small for Chrome.
          emptyDir: {medium: Memory, sizeLimit: 1Gi}
        - name: run                               # PID files.
          emptyDir: {medium: Memory}
```

## Verification

After deploy, exec into the pod and:

```bash
curl -fs http://127.0.0.1:9222/json/version | jq .
# {"Browser": "Chrome/...", "Protocol-Version": "1.3", ...}

curl -fs http://127.0.0.1:9222/json/list | jq '.[] | {url, title}'
# Expect a tab on https://claude.ai/design (not /login).

designer doctor
# All checks green.
```

If `/json/list` shows a login screen, the bootstrap profile is stale — re-bootstrap
(Google may have revoked the session) and rotate the Secret/PVC seed.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Chrome exits immediately, no CDP | Usually `/dev/shm` too small. Confirm the `dshm` emptyDir mount. |
| `Cookies` access denied | Profile dir is read-only. The Secret-as-mount route stores `0400` files; entrypoint extracts to the PVC mount which must be `rw`. |
| `/json/list` always returns `[]` | Chrome started but display didn't initialize. Check `Xvfb :99` is running (`pgrep -f Xvfb`). |
| Cloudflare 403 on first navigation | The Secret-mounted tar is stale and Cloudflare flagged the resurrected session. Re-bootstrap with a fresh sign-in. |
| Profile keeps re-seeding every restart | The PVC isn't actually persisting, or the entrypoint sees the profile dir as empty. Check storage class + reclaim policy. |

## Identity recommendations

- **One Google identity per agent.** Don't share `ally@blockcast.net`'s
  profile across multiple pods — Google's session-monitoring will flag the
  parallel logins and force revalidation.
- **Workspace seats only**, not personal Google accounts. Workspace policy
  lets admins inspect + revoke if a profile leaks.
- **Profile rotation cadence**: re-bootstrap once a quarter, or after any
  cluster restore-from-backup.

## Known limitations (v1)

- **File uploads/downloads from designer break in pod mode.** Chrome runs
  in the bot pod, not the agent pod; file_chooser paths resolve to bot-pod
  filesystem. Iteration-only flow (URL ↔ prompts) works. Future v2: CDP
  fileChooser tunneling or a designer-side artifact API.
