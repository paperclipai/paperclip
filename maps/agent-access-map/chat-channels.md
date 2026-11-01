# External chat and email conversations — agent access

Product map: [chat-channels](../feature-map/chat-channels.md).

Feature ID: `chat-channels`.

Delegated native entries inherit the [native admission and work-mode limits](README.md#native-rest-transport).

Review date: 2026-10-26. Source base: `a1f77821b9cd5c9c846fdf7a0fa5cc620ad2b6bb`; implementation: [#17737](https://github.com/paperclipai/paperclip/pull/17737).

Connection operations reviewed in this working tree. The inventory was reconciled
against production UI clients, REST registrations and service entry points; it is
a review checklist, not a runtime registry. [Authorization and evidence contract](../../doc/plans/2026-10-13-connection-api-parity.md).
Fixture evidence is separate from live provider qualification and from empirical
LLM success. Source-only entries have a reviewed agent path or an explicit boundary,
but do not claim an individually executed HTTP test.

## `providers`

Capability ID: `chat-channels/providers`.

Review: `operation-reviewed`.

### `get-companies-chat-endpoints`

API: `present` — `GET /api/companies/{companyId}/chat-endpoints`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-chat-endpoints`

API: `present` — `POST /api/companies/{companyId}/chat-endpoints`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `get-chat-endpoints`

API: `present` — `GET /api/chat-endpoints/{endpointId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `get-companies-chat-slack-setup-options`

API: `present` — `GET /api/companies/{companyId}/chat-slack/setup-options`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-chat-endpoints-slack-managed-authorize`

API: `present` — `POST /api/chat-endpoints/{endpointId}/slack/managed/authorize`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api` return a saved `requiredUserAction` handoff. The responsible user must open that setup, bind their browser session, and consent to Slack access. An agent call does not start provider consent.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Current agent and responsible-user authority bound the request. The addressed human starts the existing session-bound Slack authorization flow; callback state and subject checks remain enforced.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-chat-endpoints-slack-managed-provision`

API: `present` — `POST /api/chat-endpoints/{endpointId}/slack/managed/provision`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `delete-companies-chat-slack-manager-grants`

API: `present` — `DELETE /api/companies/{companyId}/chat-slack/manager-grants/{grantId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-chat-slack-managed-oauth-callback`

API: `present` — `GET /api/chat-slack/managed/oauth/callback`; browser/provider/MCP protocol.
Agent access: `restricted` — browser authentication return.
Policy: Provider state/signature or gateway-token verification, company and resource binding; browser returns require the configuring human. Agent-issued durable gateway tokens retain both issuer and responsible-user authority.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-chat-endpoints-slack-registration`

API: `present` — `POST /api/chat-endpoints/{endpointId}/slack/registration`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-chat-endpoints-slack-install`

API: `present` — `POST /api/chat-endpoints/{endpointId}/slack/install`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api` return a saved `requiredUserAction` handoff. The responsible user must open that setup, bind their browser session, and consent to the Slack installation. An agent call does not start installation consent.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Current agent and responsible-user authority bound the request. Only the addressed human starts session-bound installation; callback state and subject checks remain enforced.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-chat-slack-oauth-callback`

API: `present` — `GET /api/chat-slack/oauth/callback`; browser/provider/MCP protocol.
Agent access: `restricted` — browser authentication return.
Policy: Provider state/signature or gateway-token verification, company and resource binding; browser returns require the configuring human. Agent-issued durable gateway tokens retain both issuer and responsible-user authority.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-chat-endpoints-github-configuration`

API: `present` — `GET /api/chat-endpoints/{endpointId}/github/configuration`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `put-chat-endpoints-github-configuration`

API: `present` — `PUT /api/chat-endpoints/{endpointId}/github/configuration`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-chat-endpoints-github-verify`

API: `present` — `POST /api/chat-endpoints/{endpointId}/github/verify`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `put-chat-endpoints-github-progress`

API: `present` — `PUT /api/chat-endpoints/{endpointId}/github/progress`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-chat-endpoints-github-personal-connections`

API: `present` — `GET /api/chat-endpoints/{endpointId}/github/personal-connections`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-chat-endpoints-github-people-lookup`

API: `present` — `POST /api/chat-endpoints/{endpointId}/github/people/lookup`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Provider identity: the requested endpoint's active GitHub App installation issues a metadata-only token. The lookup does not use a personal grant or fall back to anonymous access. Inactive connections and unverified installation IDs are rejected. [Service regressions](../../server/src/services/chat-github-management.test.ts) cover authentication and sanitized lookup failures with provider fixtures; they do not prove the live HTTP journey.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-chat-endpoints-github-registration`

API: `present` — `POST /api/chat-endpoints/{endpointId}/github/registration`; JSON REST.
Agent access: `available` — agent REST and admitted native `search_api` / `call_api` return the saved `requiredUserAction` for human App registration and consent.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-chat-endpoints-github-registration-restart`

API: `present` — `POST /api/chat-endpoints/{endpointId}/github/registration/restart`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `put-chat-endpoints-github-draft`

API: `present` — `PUT /api/chat-endpoints/{endpointId}/github/draft`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-chat-endpoints-github-setup`

API: `present` — `POST /api/chat-endpoints/{endpointId}/github/setup`; JSON REST.
Agent access: `available` — agent REST and admitted native `search_api` / `call_api` advance saved setup. Install and identity steps return `requiredUserAction` for the addressed human. Registration returns `state: "create"` without that handoff; use [the registration operation](#post-chat-endpoints-github-registration) to obtain the saved human setup link.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-chat-endpoints-github-app`

API: `present` — `POST /api/chat-endpoints/{endpointId}/github/app`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api` return a saved human credential-entry handoff; agents may send an empty body.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). A human session imports the App credentials and signing key. Delegated service import is rejected, and agent requests persist no caller-chosen key.
Evidence: `verified` — [route](../../server/src/routes/chat-channels.ts), [provider service](../../server/src/services/chat-channels/github/app-setup.ts), and [actual-auth fixture](../../server/src/__tests__/connection-management.integration.test.ts). Agent key/JWT handoffs leave vault refs unchanged. Fresh drafts open the saved import form without the reconnect flag; its component test submits App import with the required webhook secret. Human import persists credentials, then agent repository discovery and verification continue.
Verification: `passed` — deterministic provider fixtures, assembled server and [saved-screen tests](../../ui/src/pages/apps/chat/GitHubChatSetup.test.tsx).
Gaps: Human credential entry is intentional; no live provider qualification.

### `post-chat-endpoints-github-repositories-refresh`

API: `present` — `POST /api/chat-endpoints/{endpointId}/github/repositories/refresh`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `get-chat-endpoints-github-repositories`

API: `present` — `GET /api/chat-endpoints/{endpointId}/github/repositories`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `put-chat-endpoints-github-repositories-access`

API: `present` — `PUT /api/chat-endpoints/{endpointId}/github/repositories/access`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `patch-chat-endpoints`

API: `present` — `PATCH /api/chat-endpoints/{endpointId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-chat-endpoints-photon-inspect`

API: `present` — `POST /api/chat-endpoints/{endpointId}/photon/inspect`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-chat-endpoints-setup`

API: `present` — `POST /api/chat-endpoints/{endpointId}/setup`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`. Agent-supplied signing/webhook secrets, private keys, client secrets, and project secrets return a saved human credential-entry handoff. Authorized write-only bot-token and API-key setup remains delegated.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). The service rejects delegated verification-key entry before provider work or vault writes. Human sessions and verified provider handoffs retain credential entry; agent configuration uses the responsible user's current authority.
Evidence: `verified` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — actual key/JWT configure/reconnect requests return the addressed handoff with unchanged secret refs and vault signing value. The saved card stays pending through old health, bot-token repair, unchanged signing-key entry and retries. It completes only after a protected value change, renewed webhook verification and current authority; cancellation or user revocation still denies continuation. Credential-write revocation during provider authentication leaves refs unchanged. Complete human replacements repair disabled, deleted or unreadable old signing material, while unexpected resolver failures abort without changing refs. Different credential field sets/completion modes save separate handoffs; matching retries preserve the original baseline. Immediate and saved-intent links carry those field names and completion mode. Configured GitHub webhook/client-secret replacements use human reconnect while first-setup secret restrictions remain; the saved form submits only requested values and retains other vaulted credentials. An earlier provisioned Slack challenge survives only for the same signing fingerprint and callback URL. A human session configures Slack; an agent can repair its bot token and send a policy-governed test message. Native setup receipts are protected. No live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-chat-endpoints-setup-secret`

API: `present` — `POST /api/chat-endpoints/{endpointId}/setup-secret`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api` return the saved endpoint's `requiredUserAction` handoff. Only a human session can rotate and receive the signing secret.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Agents cannot generate or export the GitHub webhook signing secret; the service also rejects delegated generation.
Evidence: `verified` — [route](../../server/src/routes/chat-channels.ts), [provider service](../../server/src/services/chat-channels/github/setup-secret.ts), and [authenticated regression](../../server/src/__tests__/connection-management.integration.test.ts). Actual key/JWT requests return a handoff without changing credential refs; a human session can rotate and persist new refs.
Verification: `passed` — deterministic provider fixtures / local assembled server. The regression failed before the fix; all 42 assembled-server scenarios passed afterward. Rotation remains pending through old health and generation/reconnect failures. A completion marker commits with new vault refs and cleared webhook verification; restored verified health is also required. Saved links open the one-time human rotation screen.
Gaps: No live GitHub rotation qualification; plaintext signing-secret setup intentionally remains a human step.

### `get-chat-endpoints-resources`

API: `present` — `GET /api/chat-endpoints/{endpointId}/resources`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `put-chat-endpoints-resources`

API: `present` — `PUT /api/chat-endpoints/{endpointId}/resources`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-email-connections`

API: `present` — `GET /api/companies/{companyId}/email/connections`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-companies-email-connections`

API: `present` — `POST /api/companies/{companyId}/email/connections`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-companies-email-connections-inspect`

API: `present` — `POST /api/companies/{companyId}/email/connections/{connectionId}/inspect`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-email-connections-check-address`

API: `present` — `POST /api/companies/{companyId}/email/connections/{connectionId}/check-address`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-email-inboxes`

API: `present` — `GET /api/companies/{companyId}/email/inboxes`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-email-inspect`

API: `present` — `POST /api/companies/{companyId}/email/inspect`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-email-inboxes`

API: `present` — `POST /api/companies/{companyId}/email/inboxes`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-email-deliveries`

API: `present` — `GET /api/companies/{companyId}/email/deliveries/{publicationId}`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.
## `identity`

Capability ID: `chat-channels/identity`.

Review: `operation-reviewed`.

### `post-chat-endpoints-github-identity`

API: `present` — `POST /api/chat-endpoints/{endpointId}/github/identity`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-chat-endpoints-github-identity-start`

API: `present` — `POST /api/chat-endpoints/{endpointId}/github/identity/start`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — actual run-JWT handoff and human-session OAuth/confirmation routes against deterministic providers. Healthy credentials and an OAuth callback alone leave the request pending with no continuation delivery. Missing, pending, revoked, expired, wrong-user and wrong-provider-account links do not satisfy it; the addressed user's current link for this endpoint does. Current membership and management authority still apply. No live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-chat-endpoints-github-identity-confirm`

API: `present` — `POST /api/chat-endpoints/{endpointId}/github/identity/confirm`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `verified` — [actual human-session OAuth/confirmation fixture](../../server/src/__tests__/connection-management.integration.test.ts) with production session middleware and database identity persistence.
Verification: `passed` — the addressed human completes OAuth and explicitly confirms the observed GitHub identity; only then can the saved identity handoff satisfy its identity requirement. Provider responses are fixtures and do not prove live consent.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-chat-endpoints-principals`

API: `present` — `GET /api/chat-endpoints/{endpointId}/principals`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-chat-endpoints-principals-link-intent`

API: `present` — `POST /api/chat-endpoints/{endpointId}/principals/{principalId}/link-intent`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `delete-chat-endpoints-principals-link`

API: `present` — `DELETE /api/chat-endpoints/{endpointId}/principals/{principalId}/link`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-chat-identity-links-confirm`

API: `present` — `POST /api/chat-identity-links/confirm`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-chat-identity-links-request-access`

API: `present` — `POST /api/chat-identity-links/request-access`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-chat-identity-links-preview`

API: `present` — `GET /api/chat-identity-links/preview`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-api-chat-github-manifest-callback`

API: `present` — `GET /api/chat-github/manifest/callback`; browser/provider/MCP protocol.
Agent access: `restricted` — browser authentication return.
Policy: Provider state/signature or gateway-token verification, company and resource binding; browser returns require the configuring human. Agent-issued durable gateway tokens retain both issuer and responsible-user authority.
Evidence: `source-only` — [route](../../server/src/app.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-api-chat-github-cloud-callback`

API: `present` — `GET /api/chat-github/cloud/callback`; browser/provider/MCP protocol.
Agent access: `restricted` — browser authentication return.
Policy: Provider state/signature or gateway-token verification, company and resource binding; browser returns require the configuring human. Agent-issued durable gateway tokens retain both issuer and responsible-user authority.
Evidence: `source-only` — [route](../../server/src/app.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-api-chat-github-identity-callback`

API: `present` — `GET /api/chat-github/identity/callback`; browser/provider/MCP protocol.
Agent access: `restricted` — browser authentication return.
Policy: Provider state/signature or gateway-token verification, company and resource binding; browser returns require the configuring human. Agent-issued durable gateway tokens retain both issuer and responsible-user authority.
Evidence: `verified` — [route](../../server/src/app.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.
## `conversation`

Capability ID: `chat-channels/conversation`.

Review: `operation-reviewed`.

### `get-chat-endpoints-github-review-detail`

API: `present` — `GET /api/chat-endpoints/{endpointId}/github/reviews/{reviewId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user. Linked task and project visibility apply to every review row in addition to endpoint and credential visibility.
Evidence: `verified` — [production-authenticated integration fixture](../../server/src/__tests__/connection-management.integration.test.ts) with real database persistence and deterministic provider responses where required.
Verification: `passed` — Actual agent-key reads return the visible review and omit or return 404 for a review linked to an inaccessible private task. Real database persistence; no live GitHub call.
Gaps: Fixture evidence does not qualify live provider behavior or an empirical model success rate.

### `get-chat-endpoints-github-reviews`

API: `present` — `GET /api/chat-endpoints/{endpointId}/github/reviews`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user. Linked task and project visibility apply to every review row in addition to endpoint and credential visibility.
Evidence: `verified` — [production-authenticated integration fixture](../../server/src/__tests__/connection-management.integration.test.ts) with real database persistence and deterministic provider responses where required.
Verification: `passed` — Actual agent-key reads return the visible review and omit or return 404 for a review linked to an inaccessible private task. Real database persistence; no live GitHub call.
Gaps: Fixture evidence does not qualify live provider behavior or an empirical model success rate.

### `get-chat-endpoints-conversations`

API: `present` — `GET /api/chat-endpoints/{endpointId}/conversations`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user. Every conversation row is filtered by current access to its linked task, in addition to endpoint access.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — list conversations with an actual agent that can manage the endpoint but cannot read one linked private task; omit that conversation while retaining readable rows. Revoke endpoint authority and assert denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-chat-endpoints-conversations-publications`

API: `present` — `POST /api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-chat-endpoints-conversations-publications-status`

API: `present` — `GET /api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications/{publicationId}/status`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:use`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-issues-chat-binding`

API: `present` — `GET /api/issues/{issueId}/chat-binding`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`, responsible-user ceiling, task privacy, endpoint resource scope and target-agent visibility.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-api-chat-webhooks`

API: `present` — `POST /api/chat-webhooks/{publicId}/{provider}`; provider webhook ingress.
Agent access: `not-applicable` — provider-signed inbound events; agent keys and gateway tokens cannot authenticate this route.
Policy: The provider verifies the payload signature and binds the endpoint/company. The request has no agent principal.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Provider ingress has no agent invocation path. Provider signature validation remains required.

### `post-companies-email-send`

API: `present` — `POST /api/companies/{companyId}/email/send`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-email-tasks`

API: `present` — `GET /api/companies/{companyId}/email/tasks/{issueId}`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-api-chat-webhooks-agentmail`

API: `present` — `POST /api/chat-webhooks/agentmail/{publicId}`; provider webhook ingress.
Agent access: `not-applicable` — provider-signed inbound events; agent keys and gateway tokens cannot authenticate this route.
Policy: The provider verifies the payload signature and binds the endpoint/company. The request has no agent principal.
Evidence: `source-only` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Provider ingress has no agent invocation path. Provider signature validation remains required.
Monitor publication lineage uses the admitted wake and its source run's matching
`set_task_monitor` receipt, including company, task, immutable agent, requester,
and scheduled time. A source ID in context cannot grant publication. The normal
delivery worker rechecks current endpoint and sender authority. Database fixtures
exercise lineage and finalization recovery; live Slack qualification remains
separate.

Publication, provider-reply, and form-open 403/permission errors fail the rejected
operation without removing unrelated assigned channel tools. Confirmed
authentication failures still put the endpoint in attention, which blocks tool
admission and provider sends; connection enabled intent is retained. Known
resource denials and explicit revocation keep their narrower or installation-wide
stops. PostgreSQL provider fixtures verify discovery after 403 and rejection after
401, including signed installation removal after a 401; they do not establish
live GitHub credential recovery.

GitHub publication recovery (2026-10-14): assigned-agent `submit_review`, `comment`,
and `update_comment` calls reuse their run-, task-, endpoint-, and argument-bound
publication on an exact retry. Identity uses the complete durable request rather
than the shortened audit preview. A changed suffix, changed nested entry, or
missing completed publication cannot authorize another write. Exact retries read an
existing receipt; the worker owns pending provider retries. A request interrupted
during metadata or file reads before staging can repeat that preflight with the
same full request identity. The immutable assessment, unique publication and
provider lease still serialize its external write. `begin_review` exact retries
resolve the run's current review and return a typed result instead of an audit
preview. Fresh gateway policy and provider authority remain
required. The durable worker resumes transient failures after restart and stops
at its retry cap, revoked authority, or a superseded head. A pending receipt is
not task completion. Source:
[publication service](../../server/src/services/chat-github-reviews.ts) and
[gateway](../../server/src/services/tool-gateway.ts). Verification uses
PostgreSQL-backed provider fixtures; this entry does not claim live provider
qualification for the new retry path.

GitHub review formatting (2026-10-30): new bot catalogs describe `submit_review`
summary and rationale as body-only fields; generated review instructions also
explain this contract to existing bots. The publisher supplies the score heading
and footer, removing leading copied current-bot or legacy score headings from
the two text fields. Saved assessments, tool authority, and publication policy
are unchanged. The PostgreSQL-backed publication fixture checks a newly
configured bot with simulated GitHub responses; this is not live model proof.

GitHub main-response identity (2026-10-19): PR requests share a company-, App-,
repository- and PR-bound comment. Agents still supply no comment destination.
Current sender, assignee, repository and publication authority are checked before
edits, including maintenance failure notices. Leading mentions for another
recipient are filtered before task work; explicit mentions of this bot still
follow normal access checks. Provider-fixture coverage is not live GitHub proof.
Native terminal reconciliation resolves the accepted run identity through the
existing chat provenance resolver; an older run's reply cannot complete a newer
request merely because both requests share the same PR comment.
A terminal native success does not authorize missing-response publication while
its native phase or durable presentation decision remains pending. Maintenance
rechecks the same request after authoritative settlement; failures keep their
separate fallback path.
Maintenance projects the bounded server-committed native passive-wait decision
only after current request ownership. It settles a no-comment acknowledgement
without authorizing a new send or counting an old shared receipt as a current-run
reply. Existing final App/marker-owned PR content survives progress acknowledgements;
new canonical review publication remains the writer for replacement assessments.

Speko browser sessions use `POST /api/companies/{companyId}/voice-sessions`,
with GET inspection/notification and POST `/{sessionId}/end` operations below
that collection. These routes require board identity; ordinary agent credentials
cannot start a private voice session. Start and notification also require the
experimental chat-connectors gate. Signed provider callbacks use the separate
voice-webhook routes and their session capability. Evidence: `source-only` —
[voice routes](../../server/src/routes/voice-sessions.ts). No live browser answer
retrieval or telephone playback is established by the UI fixtures.

Slack's **Require at-mention** policy applies to channel messages and channel
thread replies, including queued work. DMs are exempt from mention checks;
endpoint availability, **Allow direct messages**, and sender authorization still
apply. Top-level DM replies retain their linear conversation destination. Source:
[admission](../../server/src/services/chat-channels.ts) and
[queued run policy](../../server/src/services/durable-chat-wakeup.ts). Live Slack
verification of this exemption remains separate from provider-fixture coverage.

Slack eyes acknowledge the authorized task/comment commit before attachment
preparation or scheduler acceptance. This server-owned receipt grants no agent
authority. Generation/credential fencing, durable retries and exact-source final
cleanup still apply. PostgreSQL fixtures block attachments, subscription and
wakeup independently to verify that none gates the reaction; live Slack latency
remains a separate check. See [receipt worker](../../server/src/services/chat-channels/receipt-reactions.ts).

Controller-owned receipt reactions accept the SDK's empty thread timestamp for
linear DMs. Channel IDs and source message timestamps remain validated. This
does not add an agent tool or change sender, task, or credential authorization.
The pinned SDK transport regression is covered in
[receipt tests](../../server/src/services/chat-slack-receipts.test.ts); live
acknowledgement speed needs a separate provider test.

Slack assignment and tool discovery bound concurrent endpoint preparation to
two. Every endpoint keeps the live task, company, agent and linked-user checks;
403 denials omit only that endpoint. Preparation waits for both active checks
before it returns an ordered result or propagates an error. Tool authority reads
the current bot token without resolving unrelated webhook credentials. See the
[real-database preparation controls](../../server/src/__tests__/slack-tool-preparation.test.ts)
and [batch failure controls](../../server/src/services/connectors/slack-endpoint-preparation.test.ts).
These local controls do not establish live Slack latency or provider access.

Native tool gateways use the durable run task binding for discovery and policy
checks, with legacy JSON task fields as a fallback. GitHub and Slack follow
accepted request provenance across task continuations. GitHub can retain the
originating conversation after a board follow-up from the same accepted user.
An inherited origin cannot cross a task, agent, company, or requester boundary.
Cycle checks reject invalid history without a fixed limit on valid continuations.
Endpoint settings, linked identity, tool profiles, and invocation policy still
apply on each call. The native tool contract rotates older provider sessions so
an empty retained catalog is not reused. PostgreSQL fixtures cover discovery,
review publication, Slack reads, and revocation in
[channel integration](../../server/src/__tests__/chat-channels.integration.test.ts)
and [provenance controls](../../server/src/services/chat-channels/run-origin.test.ts).
The [voice gateway fixture](../../server/src/__tests__/voice-session-store.integration.test.ts)
also verifies durable task binding for a later personal callback invocation.
Failure replies cannot replace final answers inherited from an earlier run.
These fixtures do not prove live provider delivery.

Catalog authorization projection (2026-10-17): tool discovery uses the same live
service-owned task, company, agent, requester, endpoint and credential checks as
full authority resolution. It omits the revision digest and search-action token,
which catalog descriptors do not consume. Connector assignments and governed
operations retain full revision resolution; invocation policy is still checked
by the gateway. Registry replacement and missing-service controls are in
[authority registration tests](../../server/src/services/connectors/slack-authority.test.ts).
This is a source and local-database contract; hosted latency needs live evidence.

New conversations resolve typed project/workspace defaults from their endpoint
and destination under the task-creation transaction. Defaults do not authorize
private sources: admission checks the linked user's authority and assigned agent.
An existing conversation keeps its task binding. See
[creation service](../../server/src/services/chat-channels.ts) and
[defaults contract](../../packages/shared/src/types/chat-channels.ts).

### `post-voice-sessions`

API: `present` — `POST /api/companies/{companyId}/voice-sessions`; JSON REST.
Agent access: `operator-only` — the private voice caller must be an authenticated board user (or local operator); agent bearer credentials are rejected.
Policy: Company access and the service's current caller/session/endpoint authority apply. Browser start, notification, and callback preferences also require experimental chat connectors. Private microphone access, callback preferences, and incoming-call approval remain human identity/consent steps; connection-management grants do not impersonate that caller.
Evidence: `source-only` — [voice routes](../../server/src/routes/voice-sessions.ts), reviewed in this working tree.
Verification: `not-run` — verify the board caller's own state and reject agent, wrong-user, and foreign-company calls. No live telephone or browser audio qualification is claimed.
Gaps: This is an explicit human boundary. Authorized agents configure the underlying connection through its endpoint API; the human controls private calling and incoming-call consent.

### `get-voice-session`

API: `present` — `GET /api/companies/{companyId}/voice-sessions/{sessionId}`; JSON REST.
Agent access: `operator-only` — the private voice caller must be an authenticated board user (or local operator); agent bearer credentials are rejected.
Policy: Company access and the service's current caller/session/endpoint authority apply. Browser start, notification, and callback preferences also require experimental chat connectors. Private microphone access, callback preferences, and incoming-call approval remain human identity/consent steps; connection-management grants do not impersonate that caller.
Evidence: `source-only` — [voice routes](../../server/src/routes/voice-sessions.ts), reviewed in this working tree.
Verification: `not-run` — verify the board caller's own state and reject agent, wrong-user, and foreign-company calls. No live telephone or browser audio qualification is claimed.
Gaps: This is an explicit human boundary. Authorized agents configure the underlying connection through its endpoint API; the human controls private calling and incoming-call consent.

### `get-voice-notification`

API: `present` — `GET /api/companies/{companyId}/voice-sessions/{sessionId}/notification`; JSON REST.
Agent access: `operator-only` — the private voice caller must be an authenticated board user (or local operator); agent bearer credentials are rejected.
Policy: Company access and the service's current caller/session/endpoint authority apply. Browser start, notification, and callback preferences also require experimental chat connectors. Private microphone access, callback preferences, and incoming-call approval remain human identity/consent steps; connection-management grants do not impersonate that caller.
Evidence: `source-only` — [voice routes](../../server/src/routes/voice-sessions.ts), reviewed in this working tree.
Verification: `not-run` — verify the board caller's own state and reject agent, wrong-user, and foreign-company calls. No live telephone or browser audio qualification is claimed.
Gaps: This is an explicit human boundary. Authorized agents configure the underlying connection through its endpoint API; the human controls private calling and incoming-call consent.

### `get-voice-report`

API: `present` — `GET /api/companies/{companyId}/voice-sessions/{sessionId}/report`; JSON REST.
Agent access: `operator-only` — the private voice caller must be an authenticated board user (or local operator); agent bearer credentials are rejected.
Policy: Company access and the service's current caller/session/endpoint authority apply. Browser start, notification, and callback preferences also require experimental chat connectors. Private microphone access, callback preferences, and incoming-call approval remain human identity/consent steps; connection-management grants do not impersonate that caller.
Evidence: `source-only` — [voice routes](../../server/src/routes/voice-sessions.ts), reviewed in this working tree.
Verification: `not-run` — verify the board caller's own state and reject agent, wrong-user, and foreign-company calls. No live telephone or browser audio qualification is claimed.
Gaps: This is an explicit human boundary. Authorized agents configure the underlying connection through its endpoint API; the human controls private calling and incoming-call consent.

## `attachments`

Capability ID: `chat-channels/attachments`.

Review: `operation-reviewed`.

### `get-issues-attachments`

API: `present` — `GET /api/issues/{id}/attachments`; JSON REST.
Agent access: `available` — agent REST and native `search_api` / `call_api` for the attachment list.
Policy: Current company membership and task read/privacy authority. Connection management grants do not replace task access.
Evidence: `source-only` — [asset routes](../../server/src/routes/assets.ts).
Verification: `not-run` — list attachments with actual agent authentication and deny a foreign or private task.
Gaps: This operation has source review, not current-head HTTP verification.

### `post-companies-issues-attachments`

API: `present` — `POST /api/companies/{companyId}/issues/{issueId}/attachments`; multipart upload.
Agent access: `partial` — agent REST upload; native attachment tools and `register_deliverable` use their admitted resource paths and server-owned chat delivery. JSON-only `call_api` does not upload multipart content.
Policy: Task mutation/privacy authority, company/resource bounds, storage limits, and admitted native tool scope. Server-owned delivery does not grant endpoint administration.
Evidence: `source-only` — [asset routes](../../server/src/routes/assets.ts) and [native authority](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts).
Verification: `not-run` — upload through an admitted agent path, inspect the stored task attachment and outbound delivery, and deny a foreign task.
Gaps: Multipart upload is not a JSON native API call. Live chat file delivery remains unqualified by this connection setup audit.

### `post-chat-endpoints-publications-replay`

API: `present` — `POST /api/chat-endpoints/{endpointId}/publications/{publicationId}/replay`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-chat-endpoints-publications-resolve`

API: `present` — `POST /api/chat-endpoints/{endpointId}/publications/{publicationId}/resolve`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-chat-endpoints-actions-resolve`

API: `present` — `POST /api/chat-endpoints/{endpointId}/actions/{actionId}/resolve`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-companies-email-deliveries-resolve`

API: `present` — `POST /api/companies/{companyId}/email/deliveries/{publicationId}/resolve`; JSON REST.
Agent access: `restricted` — human connection manager records the outcome of an uncertain external delivery. Agents use normal governed send/status operations.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.
## `lifecycle`

Capability ID: `chat-channels/lifecycle`.

Review: `operation-reviewed`.

### `post-chat-endpoints-slack-test-message`

API: `present` — `POST /api/chat-endpoints/{endpointId}/slack/test-message`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:use`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user. Test messages and identity-link invitations intersect caller and endpoint-agent Block/Ask first/rate policies before dispatch. Independent rate buckets apply separately, identical shared buckets consume once, and saved request receipts prevent duplicate sends.
Evidence: `verified` — [production-authenticated integration fixture](../../server/src/__tests__/connection-management.integration.test.ts) with real database persistence and deterministic provider responses where required.
Verification: `passed` — actual agent-key/run-JWT requests cover caller Block/Ask first/rate rules, target Block/rate rules and one shared quota for both linked-account test messages and identity invitations. Denied requests make no additional provider send, caller audit retains the actual acting agent, and saved requests replay without another send. Provider responses are fixtures.
Gaps: Fixture evidence does not qualify live provider behavior or an empirical model success rate.

### `post-chat-endpoints-slack-resume`

API: `present` — `POST /api/chat-endpoints/{endpointId}/slack/resume`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-chat-endpoints-test`

API: `present` — `POST /api/chat-endpoints/{endpointId}/test`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-chat-endpoints-finish`

API: `present` — `POST /api/chat-endpoints/{endpointId}/finish`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-chat-endpoints-test-status`

API: `present` — `GET /api/chat-endpoints/{endpointId}/test-status`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Endpoint access remains required. The responsible human's linked external principals bound the result: only the earliest qualifying received timestamp since test start is returned, or null, with no message body. See [setup probes](../../server/src/services/chat-channels/setup-probes.ts).
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — check a permitted agent's responsible-human link, another user's received message, and no linked principal. Only the matching human's qualifying timestamp may appear; the other cases return null without content. Revoke endpoint access and assert denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-chat-endpoints-activity`

API: `present` — `GET /api/chat-endpoints/{endpointId}/activity`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:view_audit`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Current task visibility applies to every returned event. Cursors advance over bounded examined candidates, including private-only windows; private event details remain filtered.
Evidence: `verified` — [actual-JWT regression](../../server/src/__tests__/connection-management.integration.test.ts) through the assembled server and real database.
Verification: `passed` — a private-only first page retains a cursor; the next reaches three readable older events after 27 private events, including tied timestamps. The page-bounded per-task authorization regression remains green.
Gaps: Deterministic database/provider fixtures do not qualify live provider setup or availability.

### `post-chat-endpoints-deliveries-replay`

API: `present` — `POST /api/chat-endpoints/{endpointId}/deliveries/{deliveryId}/replay`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-email-inboxes-control`

API: `present` — `POST /api/email/inboxes/{endpointId}/control`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-email-inboxes-reconnect`

API: `present` — `POST /api/email/inboxes/{endpointId}/reconnect`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/email.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

GitHub review summary headings use the bot display name. Checks remain
independently scoped by GitHub App and endpoint/PR/commit identity.

After publishing a review, native agents can report `yielded` with
`response_wake` and no attention requests. Current conversation authorization
is checked again at commit. The task remains in review without a human card;
real human dependencies retain the ordinary attention-request path. A timed
wait requires a confirmed `set_task_monitor` schedule. Database coverage lives
in `external-chat-wait.integration.test.ts`; this is not live model evidence.

Inherited GitHub review waits (2026-10-26): an explicit native `response_wake`
after tree resume or same-agent continuation may retain the provider-event path
through accepted requester identity lineage and the latest processed review
publication for that task/conversation. This does not grant monitor management
or publication authority. Current task/agent/company binding, repository,
principal and endpoint checks remain effective. PostgreSQL regressions cover
quiet repeated finalization, historical publication reuse, newer unreviewed
heads and revoked access; live GitHub delivery remains separate acceptance.
Omitted/null yielded reports may use the current run's server-projected published
review wait. The same proof is rechecked at feedback, finalization and commit;
older/different-run review, pending publication and revoked connection cannot
supply it. This grants no new publication/monitor authority and leaves Done policy
unchanged; explicit malformed input is not coerced.

### `post-voice-end`

API: `present` — `POST /api/companies/{companyId}/voice-sessions/{sessionId}/end`; JSON REST.
Agent access: `operator-only` — the private voice caller must be an authenticated board user (or local operator); agent bearer credentials are rejected.
Policy: Company access and the service's current caller/session/endpoint authority apply. Browser start, notification, and callback preferences also require experimental chat connectors. Private microphone access, callback preferences, and incoming-call approval remain human identity/consent steps; connection-management grants do not impersonate that caller.
Evidence: `source-only` — [voice routes](../../server/src/routes/voice-sessions.ts), reviewed in this working tree.
Verification: `not-run` — verify the board caller's own state and reject agent, wrong-user, and foreign-company calls. No live telephone or browser audio qualification is claimed.
Gaps: This is an explicit human boundary. Authorized agents configure the underlying connection through its endpoint API; the human controls private calling and incoming-call consent.

### `get-voice-callbacks`

API: `present` — `GET /api/companies/{companyId}/voice-callbacks/{endpointId}`; JSON REST.
Agent access: `operator-only` — the private voice caller must be an authenticated board user (or local operator); agent bearer credentials are rejected.
Policy: Company access and the service's current caller/session/endpoint authority apply. Browser start, notification, and callback preferences also require experimental chat connectors. Private microphone access, callback preferences, and incoming-call approval remain human identity/consent steps; connection-management grants do not impersonate that caller.
Evidence: `source-only` — [voice routes](../../server/src/routes/voice-sessions.ts), reviewed in this working tree.
Verification: `not-run` — verify the board caller's own state and reject agent, wrong-user, and foreign-company calls. No live telephone or browser audio qualification is claimed.
Gaps: This is an explicit human boundary. Authorized agents configure the underlying connection through its endpoint API; the human controls private calling and incoming-call consent.

### `put-voice-callbacks`

API: `present` — `PUT /api/companies/{companyId}/voice-callbacks/{endpointId}`; JSON REST.
Agent access: `operator-only` — the private voice caller must be an authenticated board user (or local operator); agent bearer credentials are rejected.
Policy: Company access and the service's current caller/session/endpoint authority apply. Browser start, notification, and callback preferences also require experimental chat connectors. Private microphone access, callback preferences, and incoming-call approval remain human identity/consent steps; connection-management grants do not impersonate that caller.
Evidence: `source-only` — [voice routes](../../server/src/routes/voice-sessions.ts), reviewed in this working tree.
Verification: `not-run` — verify the board caller's own state and reject agent, wrong-user, and foreign-company calls. No live telephone or browser audio qualification is claimed.
Gaps: This is an explicit human boundary. Authorized agents configure the underlying connection through its endpoint API; the human controls private calling and incoming-call consent.

### `get-voice-phone`

API: `present` — `GET /api/companies/{companyId}/voice-phone/{endpointId}`; JSON REST.
Agent access: `operator-only` — the private voice caller must be an authenticated board user (or local operator); agent bearer credentials are rejected.
Policy: Company access and the service's current caller/session/endpoint authority apply. Browser start, notification, and callback preferences also require experimental chat connectors. Private microphone access, callback preferences, and incoming-call approval remain human identity/consent steps; connection-management grants do not impersonate that caller.
Evidence: `source-only` — [voice routes](../../server/src/routes/voice-sessions.ts), reviewed in this working tree.
Verification: `not-run` — verify the board caller's own state and reject agent, wrong-user, and foreign-company calls. No live telephone or browser audio qualification is claimed.
Gaps: This is an explicit human boundary. Authorized agents configure the underlying connection through its endpoint API; the human controls private calling and incoming-call consent.

### `put-voice-phone`

API: `present` — `PUT /api/companies/{companyId}/voice-phone/{endpointId}`; JSON REST.
Agent access: `operator-only` — the private voice caller must be an authenticated board user (or local operator); agent bearer credentials are rejected.
Policy: Company access and the service's current caller/session/endpoint authority apply. Browser start, notification, and callback preferences also require experimental chat connectors. Private microphone access, callback preferences, and incoming-call approval remain human identity/consent steps; connection-management grants do not impersonate that caller.
Evidence: `source-only` — [voice routes](../../server/src/routes/voice-sessions.ts), reviewed in this working tree.
Verification: `not-run` — verify the board caller's own state and reject agent, wrong-user, and foreign-company calls. No live telephone or browser audio qualification is claimed.
Gaps: This is an explicit human boundary. Authorized agents configure the underlying connection through its endpoint API; the human controls private calling and incoming-call consent.

### `get-voice-incoming`

API: `present` — `GET /api/companies/{companyId}/voice-phone/{endpointId}/incoming`; JSON REST.
Agent access: `operator-only` — the private voice caller must be an authenticated board user (or local operator); agent bearer credentials are rejected.
Policy: Company access and the service's current caller/session/endpoint authority apply. Browser start, notification, and callback preferences also require experimental chat connectors. Private microphone access, callback preferences, and incoming-call approval remain human identity/consent steps; connection-management grants do not impersonate that caller.
Evidence: `source-only` — [voice routes](../../server/src/routes/voice-sessions.ts), reviewed in this working tree.
Verification: `not-run` — verify the board caller's own state and reject agent, wrong-user, and foreign-company calls. No live telephone or browser audio qualification is claimed.
Gaps: This is an explicit human boundary. Authorized agents configure the underlying connection through its endpoint API; the human controls private calling and incoming-call consent.

### `post-voice-incoming-decision`

API: `present` — `POST /api/companies/{companyId}/voice-phone/{endpointId}/incoming/{callId}`; JSON REST.
Agent access: `operator-only` — the private voice caller must be an authenticated board user (or local operator); agent bearer credentials are rejected.
Policy: Company access and the service's current caller/session/endpoint authority apply. Browser start, notification, and callback preferences also require experimental chat connectors. Private microphone access, callback preferences, and incoming-call approval remain human identity/consent steps; connection-management grants do not impersonate that caller.
Evidence: `source-only` — [voice routes](../../server/src/routes/voice-sessions.ts), reviewed in this working tree.
Verification: `not-run` — verify the board caller's own state and reject agent, wrong-user, and foreign-company calls. No live telephone or browser audio qualification is claimed.
Gaps: This is an explicit human boundary. Authorized agents configure the underlying connection through its endpoint API; the human controls private calling and incoming-call consent.

### `get-voice-phone-history`

API: `present` — `GET /api/companies/{companyId}/voice-phone/{endpointId}/history`; JSON REST.
Agent access: `operator-only` — the private voice caller must be an authenticated board user (or local operator); agent bearer credentials are rejected.
Policy: Company access and the service's current caller/session/endpoint authority apply. Browser start, notification, and callback preferences also require experimental chat connectors. Private microphone access, callback preferences, and incoming-call approval remain human identity/consent steps; connection-management grants do not impersonate that caller.
Evidence: `source-only` — [voice routes](../../server/src/routes/voice-sessions.ts), reviewed in this working tree.
Verification: `not-run` — verify the board caller's own state and reject agent, wrong-user, and foreign-company calls. No live telephone or browser audio qualification is claimed.
Gaps: This is an explicit human boundary. Authorized agents configure the underlying connection through its endpoint API; the human controls private calling and incoming-call consent.

### `get-voice-history`

API: `present` — `GET /api/companies/{companyId}/voice-history/{endpointId}`; JSON REST.
Agent access: `operator-only` — the private voice caller must be an authenticated board user (or local operator); agent bearer credentials are rejected.
Policy: Company access and the service's current caller/session/endpoint authority apply. Browser start, notification, and callback preferences also require experimental chat connectors. Private microphone access, callback preferences, and incoming-call approval remain human identity/consent steps; connection-management grants do not impersonate that caller.
Evidence: `source-only` — [voice routes](../../server/src/routes/voice-sessions.ts), reviewed in this working tree.
Verification: `not-run` — verify the board caller's own state and reject agent, wrong-user, and foreign-company calls. No live telephone or browser audio qualification is claimed.
Gaps: This is an explicit human boundary. Authorized agents configure the underlying connection through its endpoint API; the human controls private calling and incoming-call consent.

## `outbound-email`

Capability ID: `chat-channels/outbound-email`.

Review: `baseline`.

API: `present` — GET /api/companies/{companyId}/email/inboxes; POST /api/companies/{companyId}/email/send for both send/reply; GET /api/companies/{companyId}/email/tasks/{issueId}; GET /api/companies/{companyId}/email/deliveries/{publicationId}. Administrative uncertain-outcome resolution uses POST /api/companies/{companyId}/email/deliveries/{publicationId}/resolve.

Agent access: `partial` — the assigned agent can use the email REST/CLI path with its actual active run and admitted email.send/email.reply policy. Board writers use their own credential authority. Availability of a CLI or scenario email tool does not establish that a native run has that tool binding or generic fallback admitted.

Policy: Agent sends require ownership of the inbox and source task, task read access, an available agent within budget, a running task run that owns execution/checkout, standard work mode, and no restricted external execution. Active endpoint, connection, credential access, and email.send/email.reply policy are rechecked. Authenticated board sends require active company membership and credential access; viewer sends additionally require instance-admin status. Local implicit authority skips the membership check. Agent reads retain task/inbox/company checks; board thread/delivery reads use the route’s company-access boundary. Delivery resolution requires board tools:manage_connections or existing elevated operator authority, not ordinary agent access.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [Email CLI](../../cli/src/commands/client/email.ts), [request schema](../../packages/shared/src/validators/email.ts), [email routes](../../server/src/routes/email.ts), and [email authority/publication](../../server/src/services/email-channels.ts).

Verification: `not-run` — Use the actual permitted writer and run to create one child/publication, confirm recipient delivery and an exact-message reply, and repeat idempotent requests without duplicate sends. Assert run/owner/mode/budget/company/credential/attachment denials and separate read access. Inspect the provider before resolving an unknown write outcome; a 202 or queued publication alone is not proof of delivery.

Gaps: Real AgentMail transport, recipient delivery, and each native tool binding still need live proof. Controlled provider receipts and inbound-reply recipes do not establish a newly initiated external email journey.

Ordinary task Retry can select newer linked-human GitHub input whose original
admission was skipped by a budget or agent-availability gate. The chat owner
revalidates its exact processed delivery, company/task/agent/principal, unchanged
comment, session generation, and admitted instruction snapshot. A separate retry
receipt preserves the original skipped receipt and older failed native result.
Current access and normal native stop/cleanup guards still govern execution;
board wake metadata alone cannot manufacture chat authority or replay old work.

Deferred chat Retry excludes independent board queues from its pinned batch.
An explicit board Retry can restore a historical mixed batch only with exact
never-started evidence, current source authority, unchanged board comments and
no prior delivery or allocation. The server records the restoration in activity;
failed runs and original skipped receipts remain history. This grants no new
agent retry capability and does not weaken execution-time source validation.

GitHub finding category contract (2026-10-31): manual and automatic review
instructions list the repository policy categories. `begin_review` returns the
assessment snapshot's `findingCategories`; later settings do not change that
snapshot. Submit an unknown category and confirm rejection before publication,
then submit a listed custom category and inspect the saved assessment and
processed publication. The channel integration fixture covers real PostgreSQL
and the service path with simulated GitHub HTTP; live model behavior remains
unverified.
