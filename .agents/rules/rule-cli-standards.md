# Rule: CLI Standards

Paperclip CLI commands (via `paperclipai` or `pnpm paperclipai`) must be consistent, idempotent, and respect standard flags and profiles.

- **Activation**: `Always On`

## Guidelines

- **Consistent Flags**: Use `--company-id`, `--project-id`, and `--issue-id` consistently across all entity-related commands.
- **Context Profiles**: Commands should honor the current context set via `paperclipai context set`.
- **Idempotency**: Setup and configuration commands (like `onboard` or `doctor`) should be safe to run multiple times.
- **Human-Readable Output**: Default output should be clean and readable; include a `--json` flag for machine-level integration.
- **Standard Exit Codes**: Use `0` for success and non-zero for specific error categories (e.g., config error, auth error, execution error).
