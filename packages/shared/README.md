# @paperclipai/shared

## Server Route Export Contract

Server routes import shared validators and route contracts from the `@paperclipai/shared` package root. When adding a validator used by `server/src/routes/**`, export it from both `packages/shared/src/validators/index.ts` and `packages/shared/src/index.ts`.

The server smoke test at `server/src/__tests__/shared-root-route-imports.test.ts` checks this contract so a missing root export fails before a service restart reaches route module startup.
