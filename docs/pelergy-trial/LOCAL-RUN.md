# Pelergy Trial Local Run

Last reviewed: 2026-03-21
Scope: one-click local run for Pelergy trial operators.

## One-Click Start

Run the trial in `authenticated/private` mode with strict secret handling:

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true pnpm paperclipai run --tailscale-auth
```

What this command does:

1. Runs onboarding automatically if local Paperclip config is missing.
2. Runs doctor checks with repair before startup.
3. Starts the server in authenticated private-network mode.

## Verify The Instance

After startup, verify the API is healthy:

```sh
curl http://localhost:3100/api/health
```

Optional quick check:

```sh
curl http://localhost:3100/api/companies
```

## Trial Notes

1. Keep this mode private-network only for trial operations.
2. Do not run Pelergy trial environments in `local_trusted` mode.
