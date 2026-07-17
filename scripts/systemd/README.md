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

---

# Cortex weekly canary+fleet train — systemd install (522d / NEO-529)

The **top** of the NEO-522 pipeline. Where the deploy agent (522a) keeps *beta* continuously
current, the weekly train promotes the **approved+tested beta snapshot** onto the **live
orchestrator** (`cortex.neoreef.com`, loopback `127.0.0.1:3100`) once a week — and *only* behind
a final CTO release-approval (NEO-522 plan §2.0). See `doc/CORTEX-BETA-RUNBOOK.md` §6.

- `../cortex-weekly-train.sh` — `preflight (beta green?) → CTO approval GATE → canary (§5 → live) → fleet (stable cut + ring)`, every stage rollback-capable.
- `cortex-weekly-train.service` — systemd **oneshot** that runs one train.
- `cortex-weekly-train.timer` — fires weekly (`Mon 09:00`).

## The approval gate (nothing goes live without it)

The train **never** mutates live without a matching CTO approval token. A timer-driven run with
no token verifies beta is green, raises the `request_confirmation` to Werner, and **halts** — no
live change. The approval is materialized as a token file holding the exact candidate SHA; once
present, the next run (timer or `--promote`) promotes that snapshot via DEV-PROCESS §5 (DB backup
first). The token is **snapshot-scoped + single-use**: an approval for one snapshot can never
silently promote a different one.

```sh
# Install (one-time, on the beta/controller host) — symlinked so a later deploy updates them.
sudo ln -sf /home/ubuntu/projects/cortex-beta/scripts/systemd/cortex-weekly-train.service /etc/systemd/system/cortex-weekly-train.service
sudo ln -sf /home/ubuntu/projects/cortex-beta/scripts/systemd/cortex-weekly-train.timer   /etc/systemd/system/cortex-weekly-train.timer
sudo systemctl daemon-reload
sudo systemctl enable --now cortex-weekly-train.timer

# Wire the approval-request hook + optional alert sink (drop-in):
sudo systemctl edit cortex-weekly-train.service   # add CORTEX_RELEASE_APPROVAL_REQUEST_CMD / CORTEX_TRAIN_ALERT_CMD
```

## Observe / drive it manually

```sh
systemctl list-timers cortex-weekly-train.timer   # next/last run
journalctl -u cortex-weekly-train -f              # live train log
scripts/cortex-weekly-train.sh --status           # candidate / approval / pending state
scripts/cortex-weekly-train.sh --preflight        # verify beta green; no live change
scripts/cortex-weekly-train.sh --dry-run          # full walk-through, no mutation
scripts/cortex-weekly-train.sh --request          # raise the CTO approval request; halt
# After Werner approves:
echo '<candidate-sha>' > /var/tmp/cortex-release-approval.token
scripts/cortex-weekly-train.sh --promote          # canary (§5 → live) + fleet
```

## Failure behaviour (each stage independently rollback-capable)

| failure                         | outcome                                                                       |
|---------------------------------|-------------------------------------------------------------------------------|
| beta not healthy / probes red   | abort before the gate; no approval requested; **ALERT**                       |
| no matching approval token      | halt after preflight; (re)raise the request; **no live change**               |
| live `db:backup` fails          | abort before any live mutation; **ALERT**                                     |
| build / migrate / health / probe fails on live | code auto-rollback to last-known-good + rebuild + restart; **ALERT** naming the pre-promotion backup for DB restore (§5.4 / NEO-198) |
| **auto-rollback itself fails to restore green** | **escalate to out-of-band recovery** (`cortex-oob-recover.sh --auto`, see below); **ALERT** |
| stable `release.sh stable` fails (armed) | fleet stage aborts; **ALERT** (canary already verified independently) |

`release.sh stable` (npm `latest`) publishes only when `CORTEX_FLEET_PUBLISH=1` — otherwise it
runs `--dry-run`, so a train never publishes npm unless explicitly armed. The instance ring
(`CORTEX_FLEET_INSTANCES`) is empty today (single live instance = no-op ring); the verify+rollback
machinery is wired for future instances.

## Out-of-band update-failure recovery (522f / NEO-532)

- `../cortex-release-handoff.sh` — materializes a pre-primed recovery artifact (`HANDOFF.md` +
  `context.env`) to the **stable host path** `/var/lib/cortex-release/<cut>/` **before** any live
  change; the train calls it, and carries the same change log in the CTO approval request.
- `../cortex-oob-recover.sh` — the **host-level** recovery entrypoint (independent failure domain):
  `--restore` (deterministic LKG restore, host tools only), `--auto` (agent if wired, else restore),
  `--agent` (pre-primed Claude Code for a novel failure), `--print`, `--dry-run`.
- `cortex-oob-recover.service` — oneshot, **manual/escalation-only** (NOT timer-driven, NOT ordered
  after `paperclip.service` — it must run when live is down). The train auto-fires `--auto` when its
  own auto-rollback fails to restore green.

```sh
# Install (one-time, on the controller host):
sudo ln -sf /home/ubuntu/projects/cortex-beta/scripts/systemd/cortex-oob-recover.service /etc/systemd/system/cortex-oob-recover.service
sudo mkdir -p /var/lib/cortex-release && sudo chown ubuntu:ubuntu /var/lib/cortex-release
sudo touch /var/log/cortex-oob-recover.log && sudo chown ubuntu:ubuntu /var/log/cortex-oob-recover.log
sudo systemctl daemon-reload
# On a failed update whose auto-rollback did not restore green:
sudo systemctl start cortex-oob-recover.service     # or: scripts/cortex-oob-recover.sh --restore
# Optional — wire a pre-primed recovery agent for novel failures:
sudo systemctl edit cortex-oob-recover.service      # add CORTEX_OOB_AGENT_CMD=/usr/local/bin/cortex-oob-agent
```

> **Why host-level, never a heartbeat.** If the live orchestrator is down, an agent hosted *on it*
> can't recover it. The handoff lives outside the live tree + DB, and the entrypoint reads only that
> artifact + host tools (`git` / `systemctl` / `db:backup` / `curl`) — it never calls back into the
> instance it is recovering. All actions are audit-logged to `/var/log/cortex-oob-recover.log`.
