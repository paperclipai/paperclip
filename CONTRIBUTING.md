# Contributing

## Setup

```sh
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
pnpm dev
```

API server starts at `http://localhost:3100`. Embedded PGlite is used automatically —
no external database needed for local dev.

## Verification

Before submitting a PR, run the full check:

```sh
pnpm -r typecheck   # no type errors
pnpm test:run       # all tests pass
pnpm build          # full build succeeds
docker build .      # Docker image builds clean
```

## Pull Request Guidelines

- Branch off `master`
- Keep commits focused; one logical change per commit
- Link to the relevant section of `doc/SPEC-implementation.md` when implementing spec behavior
- Include before/after notes or screenshots for UI or behavior changes
- Run verification above before opening the PR
- For large or impactful changes, discuss in [Discord #dev](https://discord.gg/m4HZY7xNG3) first

## Adding an Adapter

See the "Adding a New Adapter" section in [AGENTS.md](AGENTS.md) for step-by-step
instructions. Each adapter lives in `packages/adapters/<name>/` and must include a
`README.md`.

## Docker Testing

To test the full Docker stack locally:

```sh
cp .env.example .env
# Edit .env to fill in required secrets (BETTER_AUTH_SECRET, PAPERCLIP_AGENT_JWT_SECRET)
docker compose up -d --build
curl http://localhost:3100/api/health
```

See [doc/DOCKER.md](doc/DOCKER.md) for the full Docker guide.

## Questions?

Ask in [Discord #dev](https://discord.gg/m4HZY7xNG3) or open a [GitHub Discussion](https://github.com/paperclipai/paperclip/discussions).
