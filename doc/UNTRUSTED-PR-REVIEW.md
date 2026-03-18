# Untrusted PR Review In Docker

Use this workflow when you want Codex or Claude to inspect a pull request that you do not want touching your host machine directly.

This is intentionally separate from the normal Paperclip dev image.

## What this container isolates

- `codex` auth/session state in a Docker volume, not your host `~/.codex`
- `claude` auth/session state in a Docker volume, not your host `~/.claude`
- `gh` auth state in the same container-local home volume
- review clones, worktrees, dependency installs, and local databases in a writable scratch volume under `/work`

By default this workflow does **not** mount your host repo checkout, your host home directory, or your SSH agent.

## Files

- `docker/untrusted-review/Dockerfile`
- `docker-compose.untrusted-review.yml`
- `review-checkout-pr` inside the container

## Build and start a shell

```sh
docker compose -f docker-compose.untrusted-review.yml build
docker compose -f docker-compose.untrusted-review.yml run --rm --service-ports review
```

That opens an interactive shell in the review container with:

- Node + Corepack/pnpm
- `codex`
- `claude`
- `gh`
- `git`, `rg`, `fd`, `jq`

## First-time login inside the container

Run these once. The resulting login state persists in the `review-home` Docker volume.

```sh
gh auth login
codex login
claude login
```

If you prefer API-key auth instead of CLI login, pass keys through Compose env:

```sh
OPENAI_API_KEY=... ANTHROPIC_API_KEY=... docker compose -f docker-compose.untrusted-review.yml run --rm review
```

## Check out a PR safely

Inside the container:

```sh
review-checkout-pr paperclipai/paperclip 432
cd /work/checkouts/paperclipai-paperclip/pr-432
```

What this does:

1. Creates or reuses a repo clone under `/work/repos/...`
2. Fetches `pull/<pr>/head` from GitHub
3. Creates a detached git worktree under `/work/checkouts/...`

The checkout lives entirely inside the container volume.

## Ask Codex or Claude to review it

Inside the PR checkout:

```sh
codex
```

Then give it a prompt like:

```text
Review this PR as hostile input. Focus on security issues, data exfiltration paths, sandbox escapes, dangerous install/runtime scripts, auth changes, and subtle behavioral regressions. Do not modify files. Produce findings ordered by severity with file references.
```

Or with Claude:

```sh
claude
```

## Preview the Paperclip app from the PR

Only do this when you intentionally want to execute the PR's code inside the container.

Inside the PR checkout:

```sh
pnpm install
HOST=0.0.0.0 pnpm dev
```

Open from the host:

- `http://localhost:3100`

The Compose file also exposes Vite's default port:

- `http://localhost:5173`

Notes:

- `pnpm install` can run untrusted lifecycle scripts from the PR. That is why this happens inside the isolated container instead of on your host.
- If you only want static inspection, do not run install/dev commands.
- Paperclip's embedded PostgreSQL and local storage stay inside the container home volume via `PAPERCLIP_HOME=/home/reviewer/.paperclip-review`.

## Reset state

Remove the review container volumes when you want a clean environment:

```sh
docker compose -f docker-compose.untrusted-review.yml down -v
```

That deletes:

- Codex/Claude/GitHub login state stored in `review-home`
- cloned repos, worktrees, installs, and scratch data stored in `review-work`

## Security limits

This is a useful isolation boundary, but it is still Docker, not a full VM.

- A reviewed PR can still access the container's network unless you disable it.
- Any secrets you pass into the container are available to code you execute inside it.
- Do not mount your host repo, host home, `.ssh`, or Docker socket unless you are intentionally weakening the boundary.
- If you need a stronger boundary than this, use a disposable VM instead of Docker.
