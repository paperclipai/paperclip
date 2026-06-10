# Development — Paperclip

## Prerequisites
- Node.js >= 20
- pnpm 9.15.4 (`corepack enable` or `npm install -g pnpm`)
- macOS (primary development platform)

## Setup
```bash
cd ~/Dev/paperclip
pnpm install
```

## Development Commands
```bash
# Start dev server (watch mode)
pnpm dev

# Start UI only
pnpm dev:ui

# Start server only
pnpm dev:server

# Run tests
pnpm test

# Type check
pnpm typecheck

# Build
pnpm build

# Database operations
pnpm db:generate   # Generate migrations
pnpm db:migrate    # Run migrations
```

## Environment Variables
Copy `.env.example` to `.env` and configure:
- `DATABASE_URL` — PostgreSQL connection
- `REDIS_URL` — Redis connection
- `ANTHROPIC_API_KEY` — Claude access
- `OPENAI_API_KEY` — OpenAI access
- `DISCORD_WEBHOOK_URL` — Alert notifications

## Testing
- Unit tests: Vitest
- E2E tests: Playwright (`pnpm test:e2e`)
- Evals: promptfoo (`pnpm evals:smoke`)

## IDE
VS Code with TypeScript, ESLint, and Prettier extensions recommended.
