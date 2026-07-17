# cortex-beta deploy agent — systemd install

The on-host, pull-based deploy agent for the **cortex-beta** staging instance
(`https://cortex-beta.neoreef.com`, loopback `127.0.0.1:3200`). It carries merged
`origin/master` onto the running beta tree with no manual step. This is the root of the
NEO-522 CI/CD pipeline (subtask 522a / NEO-526).

- `../cortex-deploy.sh` — the deploy cycle: `fetch → ff-only → pnpm build → restart → health gate → auto-rollback on failure`.
- `cortex-deploy.service` — systemd **oneshot** that runs one cycle.
- `cortex-deploy.timer` — polls `origin/master` every 5 min and triggers the service.

## Why on-host (pull), not a GitHub Action (push)

beta binds loopback only (`127.0.0.1:3200`, Caddy fronts the public host), so cloud CI cannot
reach it. The deploy executor + verify probes must run **on the controller host**. See
NEO-522 plan §3 (Option A).

## Install (one-time, on the beta host)

```sh
# Units reference /home/ubuntu/projects/cortex-beta/scripts/cortex-deploy.sh directly, so they
# are symlinked (not copied) — a later deploy that updates the script is picked up for free.
sudo ln -sf /home/ubuntu/projects/cortex-beta/scripts/systemd/cortex-deploy.service /etc/systemd/system/cortex-deploy.service
sudo ln -sf /home/ubuntu/projects/cortex-beta/scripts/systemd/cortex-deploy.timer   /etc/systemd/system/cortex-deploy.timer
sudo systemctl daemon-reload
sudo systemctl enable --now cortex-deploy.timer
```

`ubuntu` must have passwordless `sudo systemctl restart paperclip-beta.service` (it already
does on the beta host).

## Observe

```sh
systemctl list-timers cortex-deploy.timer     # next/last run
journalctl -u cortex-deploy -f                # live deploy log
systemctl start cortex-deploy.service         # force a cycle now
```

## Dry-run / pre-flight (no mutation)

```sh
scripts/cortex-deploy.sh --check     # report deployed vs target, list pending commits
scripts/cortex-deploy.sh --dry-run   # same, after fetch
```

## Failure behaviour (no half-deploy)

| failure               | outcome                                                              |
|-----------------------|---------------------------------------------------------------------|
| non-fast-forward      | abort before any build; last-known-good keeps running; **ALERT**    |
| dirty beta tree       | abort before any build; **ALERT**                                   |
| `pnpm build` fails    | tree reset to last-known-good (running process untouched); **ALERT**|
| unhealthy after restart | roll back → rebuild → restart last-known-good; **ALERT**           |
| content-verify fails (522b) | roll back → rebuild → restart last-known-good; **ALERT**      |

Alerts always hit journald (`ALERT` marker). Set `CORTEX_DEPLOY_ALERT_CMD` (invoked as
`"$CORTEX_DEPLOY_ALERT_CMD" "<message>"`) to also fan out to an external sink. Drop overrides
in a unit drop-in: `sudo systemctl edit cortex-deploy.service`.

## Content-verify hook (522b coordination point)

After the health gate passes, the script runs `CORTEX_DEPLOY_VERIFY_CMD` if set; a non-zero
exit triggers the same auto-rollback. **522b** (NEO-527) wires its `scripts/verify-content.mjs`
probe in here via a `cortex-deploy.service` drop-in:

```
[Service]
Environment=CORTEX_DEPLOY_VERIFY_CMD=node /home/ubuntu/projects/cortex-beta/scripts/verify-content.mjs
```
