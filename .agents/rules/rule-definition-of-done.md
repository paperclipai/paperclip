# Rule: Definition of Done

A task is not complete until it satisfies all project standards and has been verified in a consistent manner.

- **Activation**: `Model Decision` (whenever finalizing a task)

## Checklist

1.  **Architecture**: Follows all workspace rules (company scope, contract sync, etc.).
2.  **Code Quality**: Passes `pnpm lint` and `pnpm -r typecheck`.
3.  **Documentation**: `AGENTS.md` and related docs are updated if necessary.
4.  **Verification**: Manual verification notes and commands are included in the walkthrough.
5.  **Audit**: Activity logs for mutations are verified.
6.  **Secret Check**: No plain-text secrets were introduced.
7.  **Hand-off**: A clear `walkthrough.md` is provided to the user.
