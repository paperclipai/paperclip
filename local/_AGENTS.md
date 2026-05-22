# AGENTS-local.md

Local overrides and security requirements for the LinkCast environment.

## Orchestration & API Tooling

To ensure consistent secret resolution and prevent sensitive data leakage, always use the provided wrapper scripts instead of raw commands:

- **Orchestration**: Use `./paperclip-control.sh` (alias `pcc`) for all lifecycle actions (start, stop, logs, etc.). It ensures 1Password secrets are whitelisted and injected into the container environment without host-level leakage.
- **API Interaction**: Use `./paperclip-api.sh` (alias `pca`) for all curl-based API calls. It handles 1Password resolution and uses temporary configuration files to prevent API keys from appearing in the system process list (`ps`).

Refer to `doc/experimental/2026-05-04-paperclip-control-security-critique.md` for the full security rationale.
