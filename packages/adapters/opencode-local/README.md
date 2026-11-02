# OpenCode local adapter

The adapter starts OpenCode in the selected execution workspace. It sets the
child process `PWD` to that workspace. On remote targets, it uses the realized
remote workspace path. It does not add a `--dir` argument, which OpenCode 2
does not accept. Explicit operator arguments remain unchanged.

This directory handling does not imply full OpenCode 2 protocol support.

Run the adapter checks from the repository root:

```sh
pnpm exec vitest run packages/adapters/opencode-local/src
pnpm --filter @paperclipai/adapter-opencode-local typecheck
```
