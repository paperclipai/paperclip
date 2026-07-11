# Native browser integration rollout

## Outcome

Paperclip agents use `agent-browser` as the default local browser and Camoufox as an explicit anti-detection fallback. Browser actions appear live in the issue's active-run segment. Authentication state is encrypted and scoped through the existing company-secret and project-env systems.

## Architecture

- **Execution:** browser CLIs remain execution-plane tools available to local adapters.
- **Visibility:** existing heartbeat log streaming and issue transcript rendering carry each browser action; no synthetic issue comments or comment spam is created.
- **Routing:** `agent-browser` first; challenge detection then Camoufox fallback; human captcha/2FA remains a gate.
- **Secrets:** credentials and the agent-browser encryption key live in `company_secrets`. Existing secret bindings inject them into an agent or project runtime, with project env taking precedence.
- **State:** session names are non-secret scope identifiers. Encrypted agent-browser restore state lives on the persistent `/paperclip` volume. Company and project session names must never collide across companies.

## Delivery stages

1. Render agent-browser and Camoufox command calls as browser activity in live issue transcripts.
2. Bundle the browser policy skill for every supported local agent runtime.
3. Add Camoufox and its browser binary to the production image; keep versions pinned by build args.
4. Configure company secrets and project overrides through the existing Secrets and Project environment UI.
5. Verify an authenticated session survives a new heartbeat, a blocked-page signal triggers the documented fallback, and no credential value appears in logs/comments.

## Follow-up product work

The first rollout intentionally reuses existing secret and project configuration surfaces. A later UI layer can add a Browser Profiles page that composes those primitives, displays session health/last-used metadata, rotates state encryption keys, and offers board-mediated login/2FA without changing the underlying security model.

## Acceptance checks

- `agent-browser` and Camoufox are installed in the production container.
- Browser commands have a browser-specific label in live issue activity.
- `AGENT_BROWSER_ENCRYPTION_KEY` is supplied only through a secret binding.
- Two projects can use different `AGENT_BROWSER_RESTORE` values without sharing state.
- Challenge detection and fallback behavior are explained in the bundled runtime skill.
- Browser state and credentials do not appear in issue comments, command text, or persisted run logs.
