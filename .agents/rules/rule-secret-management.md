# Rule: Secret Management

Protect sensitive credentials by ensuring they are never stored in plain text and are always handled via secure secret references or encrypted stores.

- **Activation**: `Always On`

## Guidelines

- **Redaction**: Never write plain-text secrets (API keys, tokens, passwords) to logs, board comments, or the database.
- **Secret References**: Use `company_secrets` references where possible instead of raw environment variables.
- **Encryption in Rest**: Ensure that any persistent secret material is encrypted using the master key defined in `PAPERCLIP_SECRETS_MASTER_KEY`.
- **Masking in UI**: Any secret values displayed in the Paperclip UI must be masked (e.g., `sk-••••1234`) and only revealed via explicit user action or to authorized backend processes.
- **Sanitization**: Before committing code or logs, verify that no local `.env` values or private keys have been accidentally included.
