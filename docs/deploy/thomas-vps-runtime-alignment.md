# Thomas VPS runtime alignment

Paperclip's durable HLT deployment model has three separate pieces. Keep them distinct before changing services or branches.

## Current intended shape

- **Paperclip app:** the operator-facing control plane. The hosted production-style deployment is Render, from `TheThomais/paperclip:master`, with `/api/health` as the health check.
- **Thomas bridge:** the durable Hermes execution bridge on the VPS. It runs as `thomas-hermes-bridge.service` on `127.0.0.1:9119` and can be routed through the Hostinger/Traefik hostname.
- **Thomas VPS local repo:** `/srv/repos/paperclip` is the source checkout used for branches, validation, and PRs. A local Paperclip dev server is optional and should not be assumed to be running.

## Guardrails

- Do not treat a missing local `127.0.0.1:3100`/`3101` Paperclip server as a production outage by itself.
- Do not stop or delete Hostinger/Hermes containers just because the bridge is served by a systemd service.
- Do not push directly to `master`; use an `agent/*` branch and PR.
- Before changing runtime wiring, prove which component is failing: Render Paperclip, VPS bridge, local dev service, Postgres, or Hostinger/Traefik route.

## Runtime doctor

Run this from the repo root:

```bash
pnpm doctor:runtime
```

The doctor is read-only and best-effort. It reports:

- local git branch, origin, and drift from `origin/master`
- GitHub repo/default branch and open PR count
- registered Paperclip dev services
- relevant Docker containers
- `thomas-hermes-bridge.service` status
- Render/local Paperclip health endpoints
- expected deployment contract from `render.yaml`

Some checks require local tools or permissions (`gh`, Docker, `systemctl`, and network access). If those are missing, the doctor should say `unknown`, `skipped`, or `not-ready` rather than mutate the host.

Use the output as a first-pass readback before starting or restarting services.

## Interpreting common results

- **Render health is OK, local ports are refused:** Paperclip is hosted and the VPS checkout is idle. That can be healthy.
- **Thomas bridge is active but Hostinger container looks parked:** this can be healthy. The bridge implementation is the systemd service; some Hostinger-image containers are parked future assets.
- **Open PRs exist:** finish or classify them before creating another branch touching the same runtime surface.
- **Git drift from `origin/master`:** fetch/merge/rebase in a worktree before validating or opening a PR.
