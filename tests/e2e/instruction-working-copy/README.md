# Instruction working-copy acceptance

Run a disposable server with an instruction-capable fixture around the real
process adapter. The capability override exists only in this launcher. The child
reads and edits its registered private copy and completes a task through the
run-scoped API. No provider calls are made.

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/e2e/instruction-working-copy/launch.ts
```

Use its printed ready URL:

```sh
INSTRUCTION_COPY_TEST_URL=http://127.0.0.1:3100 \
pnpm exec playwright test --config tests/e2e/instruction-working-copy/playwright.config.ts
```

The browser checks completed tasks across two turns, exact saved bytes through
the agent-file API, the next process's restored contents, each run's save receipt,
and private-copy cleanup. The fixture refuses non-loopback servers and requires
its dedicated company. Screenshots and failure traces are in
`test-results/instruction-working-copy`. Stop the launcher with Ctrl-C; its
isolated data remains available for inspection.
