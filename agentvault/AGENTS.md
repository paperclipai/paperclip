# Repository Guidelines

## Project Structure & Module Organization
- `src/`: core TypeScript library (packaging, deployment, security, monitoring, wallet, ICP tooling).
- `cli/`: CLI entry points and command handlers (`cli/commands/*.ts`).
- `canister/`: Motoko canister code and Candid interfaces.
- `tests/`: Vitest suite (unit, integration, CLI, deployment, packaging).
- `examples/`: sample agent projects and configs.
- `docs/`, `AI_DOCS/`: product and design docs.
- `dist/`, `dist-cli/`: build outputs (generated, do not edit).
- Root configs: `dfx.json`, `icp.yaml`, `tsconfig.json`, `eslint.config.js`.

## Build, Test, and Development Commands
- `npm run dev`: run the local dev entry with `tsx` watch.
- `npm run build`: compile TypeScript to `dist/`.
- `npm run start`: run the built app from `dist/`.
- `npm run test`: run Vitest in CI mode.
- `npm run test:watch`: run Vitest in watch mode.
- `npm run typecheck`: TypeScript typecheck without emit.
- `npm run lint` / `npm run lint:fix`: lint and auto-fix with ESLint.

## Coding Style & Naming Conventions
- TypeScript, ESM (`module`/`moduleResolution: NodeNext`), ES2022 target.
- 2-space indentation; keep exports explicit.
- Use `camelCase` for variables/functions, `PascalCase` for types/classes.
- Unused args should be prefixed with `_` (ESLint allows this).
- Keep CLI command files in `cli/commands/` named with kebab-case (e.g., `wallet-import.ts`).

## Testing Guidelines
- Framework: Vitest.
- Test files live under `tests/` and end with `*.test.ts`.
- Group by domain: `tests/cli/`, `tests/deployment/`, `tests/icp/`, `tests/unit/`.
- Prefer small, isolated tests for helpers and broader integration tests for CLI flows.

## Commit & Pull Request Guidelines
- Commit messages in this repo are plain, sentence-case descriptions (no strict prefix).
- Keep the first line concise; add details in the body if needed.
- PRs should include: summary of changes, relevant test output, and linked issues.
- Add screenshots only when UX or CLI output changes are user-facing.

## Security & Configuration Tips
- Do not commit secrets; keep keys and seed phrases out of git.
- Use `dfx` for local canister work and keep `dfx.json` in sync with canister changes.
