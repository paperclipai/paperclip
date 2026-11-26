# Test audit R9: owner-level duplicate consolidation

Base: `77408fa6c3d7c916d7160760eae2144aaa0f8fe7` (#16072). This batch removes nine registered tests and 79 net test lines. It changes no production code. No CI timing claim was measured.

| Retired proof | Keeper and preserved contract | Owner mutation caught by keeper |
| --- | --- | --- |
| CLI ZIP: separate binary blob and invalid UTF-8 fallback cases | Archive round-trip keeps blob bytes and invalid UTF-8 note bytes exact; valid UTF-8 blob input is covered there too. | Bypass blob storage or decode invalid UTF-8 lossily; exact round-trip fails. |
| Daytona: first execute creates a session before the second reuses it | Persistent-shell case checks one created session, a `paperclip-` id, and the same session id for both commands. | Break the id prefix or session-store hit; the keeper fails. |
| Shared account handle: plain `acct-42` acceptance | Whitespace-rejection case retains the exact accepted input and checks it is not trimmed. | Return null for the accepted identifier; the keeper fails. |
| Loopback bind: bare `pnpm dev` rewrite | Loopback-preset case retains the same bare command and checks the rewritten command plus preset behavior. | Stop rewriting the bare command; the keeper fails. |
| Native runner: generic remote-runner acceptance | Remote Dot capability case retains generic-remote acceptance alongside the Dot-specific rejection and acceptance controls. | Require Dot capability for generic remote runners; the keeper fails. |
| Auth route: null Sentry DSN in an unset configuration | Full persisted-user session response already checks `sentryDsn: null` and `sentryEnvironment: null`. | Return an empty string for the DSN; full response equality fails. |
| Discord registration: successful registration before runtime enablement | The 503 refresh case first proves successful registration, capabilities, callback, persisted receipt, token exclusion, and idempotent reconciliation. | Persist the bot token in the receipt; the migrated token-exclusion assertion fails. |
| Slack OAuth: organization grant over-grant provenance | The no-scope refresh case first checks the original database grant before refresh, then retains the post-refresh warning. | Omit OAuth provenance when creating the initial organization grant; the pre-refresh database assertion fails. |

Each mutation was tested against the intended retained assertion. Production owners were restored byte-for-byte after controls. Complete owner candidates passed before restoration. The modified files were then replayed on this exact base in two runs: six owners passed 1,001 tests; after building the local plugin SDK dependency, the two server owners passed 1,691 tests. The final combined total is 2,692 passing tests across all eight changed owners. `git diff --check` passes.

The reductions consolidate proof at an existing owner and keep the distinct boundary controls. They do not claim a specific CI-time reduction; the focused suites still exercise their retained inputs and assertions.
