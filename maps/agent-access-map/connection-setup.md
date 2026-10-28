# Connection setup — agent access

Product map: [connection-setup](../feature-map/connection-setup.md).

Feature ID: `connection-setup`.

Delegated native entries inherit the [native admission and work-mode limits](README.md#native-rest-transport).

Review date: 2026-10-26. Source base: `a1f77821b9cd5c9c846fdf7a0fa5cc620ad2b6bb`; implementation: [#17737](https://github.com/paperclipai/paperclip/pull/17737).

Connection operations reviewed in this working tree. The inventory was reconciled
against production UI clients, REST registrations and service entry points; it is
a review checklist, not a runtime registry. [Authorization and evidence contract](../../doc/plans/2026-10-13-connection-api-parity.md).
Fixture evidence is separate from live provider qualification and from empirical
LLM success. Source-only entries have a reviewed agent path or an explicit boundary,
but do not claim an individually executed HTTP test.

Prompt Injection Prevention reuses shared OpenRouter API-key setup directly from
Settings → Connections. It adds no Apps provider or transport. Credential ownership
and audience rules are the existing connection rules; saving a connection alone
does not activate the service. See [service configuration](../../doc/prompt-injection-prevention.md).

1Password adds a service-account catalog method. Agents request access through
the existing connection tools and invoke its reviewed item actions through the
run-scoped gateway. The service-account token stays in the selected user/company
vault; vault boundaries are enforced by 1Password. Authorized API setup uses the shared connection-management policy; credential entry remains a human step when needed.
Evidence and limits: [1Password connector](../../doc/connections/1PASSWORD.md).

## `catalog`

Capability ID: `connection-setup/catalog`.

Review: `operation-reviewed`.

### `get-companies-tools-gallery`

API: `present` — `GET /api/companies/{companyId}/tools/gallery`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-tools-apps-preflight`

API: `present` — `GET /api/companies/{companyId}/tools/apps/{galleryKey}/preflight`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-tools-examples`

API: `present` — `GET /api/companies/{companyId}/tools/examples`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-tools-examples-install`

API: `present` — `POST /api/companies/{companyId}/tools/examples/{id}/install`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-tools-examples-smoke`

API: `present` — `POST /api/companies/{companyId}/tools/examples/{id}/smoke`; JSON REST.
Agent access: `operator-only` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-companies-tools-stdio-templates`

API: `present` — `GET /api/companies/{companyId}/tools/stdio-templates`; JSON REST.
Agent access: `operator-only` — a board user reads host command templates. Agents select approved provider templates through the catalog.
Policy: board actor and `tools:admin`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-companies-tools-stdio-templates`

API: `present` — `POST /api/companies/{companyId}/tools/stdio-templates`; JSON REST.
Agent access: `operator-only` — a board user creates host command templates; agents select approved templates through the catalog.
Policy: Board actor, company access, and `tools:admin`. Connection-management grants do not authorize host command template administration.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-companies-tools-stdio-templates-disable`

API: `present` — `POST /api/companies/{companyId}/tools/stdio-templates/{templateId}/disable`; JSON REST.
Agent access: `operator-only` — a board user disables host command templates; agents select approved templates through the catalog.
Policy: Board actor, company access, and `tools:admin`. Connection-management grants do not authorize host command template administration.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-companies-tools-mcp-import-json`

API: `present` — `POST /api/companies/{companyId}/tools/mcp/import-json`; JSON REST.
Agent access: `operator-only` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Board actor and company access. This operation previews parsed MCP configuration; it does not execute host commands or require the host-template `tools:admin` grant.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-runtime-tools-connections-search`

API: `present` — `POST /runtime-tools/connections/search`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/connection-intents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.
## `identity-and-access`

Capability ID: `connection-setup/identity-and-access`.

Review: `operation-reviewed`.

### `post-companies-tools-apps-connect`

API: `present` — `POST /api/companies/{companyId}/tools/apps/connect`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-tools-connections`

API: `present` — `POST /api/companies/{companyId}/tools/connections`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.
## `credentials`

Capability ID: `connection-setup/credentials`.

Review: `operation-reviewed`.

### `post-agents-me-connections-start-authorization`

API: `present` — `POST /api/agents/me/connections/{connectionId}/start-authorization`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: `tools:manage_connections`, an active run, and the server-derived responsible user matching the authorization subject; shared scope/trust/user checks apply. Human authentication remains a handoff, with the actual agent retained for audit. JSON authorization initiation is explicitly REST-callable.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-agents-me-connections-token`

API: `present` — `POST /api/agents/me/connections/{connectionId}/token`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-tools-connections-start-authorization`

API: `present` — `POST /api/companies/{companyId}/tools/connections/{connectionId}/start-authorization`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-tools-oauth-start`

API: `present` — `POST /api/tools/oauth/{connectionId}/start`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user. Returns the saved setup without issuing agent-bound OAuth state; the human browser initiates provider consent.
Evidence: `verified` — [authenticated integration fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed through production authentication and database persistence, including saved Google service choices addressed to the responsible user. [Service-picker tests](../../ui/src/features/connections/GoogleWorkspaceServices.test.tsx) cover restoring only that user's request and retaining newer consent.
Verification: `passed` — deterministic local fixture; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-runtime-tools-github-credentials`

API: `present` — `POST /runtime-tools/github/credentials`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/connection-intents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.
## `handoff`

Capability ID: `connection-setup/handoff`.

Review: `operation-reviewed`.

### `get-tools-oauth-cloud-connector-enrollment`

API: `present` — `GET /api/tools/oauth/cloud-connector/enrollment`; JSON REST.
Agent access: `operator-only` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Board actor (`assertBoard`) for instance enrollment status; agents cannot read this operator surface.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-tools-oauth-cloud-connector-enrollment`

API: `present` — `POST /api/tools/oauth/cloud-connector/enrollment`; JSON REST.
Agent access: `operator-only` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Instance administrator (`assertInstanceAdmin`) and access to the requested company. The saved enrollment binds the initiating human principal and return destination.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-tools-oauth-cloud-connector-enrollment-callback`

API: `present` — `GET /api/tools/oauth/cloud-connector/enrollment-callback`; browser return — HTML completion page or HTTP 303 redirect.
Agent access: `operator-only` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Instance administrator (`assertInstanceAdmin`), access to the saved company, and the same initiating principal. The saved enrollment ID, approval code, state, and expiry must validate before completion.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-tools-oauth-cloud-connector-callback`

API: `present` — `GET /api/tools/oauth/cloud-connector/callback`; browser/provider/MCP protocol.
Agent access: `restricted` — browser authentication return.
Policy: Provider state/signature or gateway-token verification, company and resource binding; browser returns require the configuring human. Agent-issued durable gateway tokens retain both issuer and responsible-user authority.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-tools-oauth-paperclip-id-callback`

API: `present` — `GET /api/tools/oauth/paperclip-id/callback`; browser/provider/MCP protocol.
Agent access: `restricted` — browser authentication return.
Policy: Provider state/signature or gateway-token verification, company and resource binding; browser returns require the configuring human. Agent-issued durable gateway tokens retain both issuer and responsible-user authority.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-tools-vercel-connect-callback`

API: `present` — `GET /api/tools/vercel-connect/callback`; browser/provider/MCP protocol.
Agent access: `restricted` — browser authentication return.
Policy: Saved, unexpired Vercel OAuth state binds the company and connection to the addressed human or initiating actor/session. State is consumed once; expired, replayed and wrong-user returns fail. Personal grants require current active non-viewer company membership and retain the human creator. See [state validation](../../server/src/services/tool-access/oauth/state.ts) and [Vercel callback](../../server/src/services/tool-access/oauth/vercel-callback.ts).
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — return as the addressed human, inspect the saved personal grant and creator, then reject wrong-user, expired, replayed and revoked-membership callbacks. This callback has source review, without live Vercel qualification.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-tools-oauth-callback`

API: `present` — `GET /api/tools/oauth/callback`; browser/provider/MCP protocol.
Agent access: `restricted` — browser authentication return.
Policy: Provider state/signature or gateway-token verification, company and resource binding; browser returns require the configuring human. Agent-issued durable gateway tokens retain both issuer and responsible-user authority.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `get-mcp-runtime-tools`

API: `present` — `GET /mcp/runtime-tools`; browser/provider/MCP protocol.
Agent access: `restricted` — GET always returns HTTP 405 with `Allow: POST`. Use the corresponding POST MCP operation.
Policy: GET streaming is unsupported; this is a transport boundary independent of principal permissions. POST still requires the documented MCP authentication and resource policy.
Evidence: `source-only` — [route](../../server/src/routes/connection-intents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — source-reviewed fixed 405 handler. A protocol check should assert status 405 and `Allow: POST`; use POST to exercise authenticated MCP calls.
Gaps: No GET event stream is implemented. This entry does not advertise a usable GET client connection.

### `post-mcp-runtime-tools`

API: `present` — `POST /mcp/runtime-tools`; browser/provider/MCP protocol.
Agent access: `available` — existing authenticated MCP/provider protocol; not callable as JSON REST.
Policy: Provider state/signature or gateway-token verification, company and resource binding; browser returns require the configuring human. Agent-issued durable gateway tokens retain both issuer and responsible-user authority.
Evidence: `source-only` — [route](../../server/src/routes/connection-intents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-connection-intents-setup-options`

API: `present` — `GET /api/connection-intents/{interactionId}/setup-options`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/connection-intents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-connection-intents-phase`

API: `present` — `POST /api/connection-intents/{interactionId}/phase`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/connection-intents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.

### `post-connection-intents-complete`

API: `present` — `POST /api/connection-intents/{interactionId}/complete`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/connection-intents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.
## `draft-recovery`

Capability ID: `connection-setup/draft-recovery`.

Review: `operation-reviewed`.

### `post-companies-tools-apps-finalize-oauth-access`

API: `present` — `POST /api/companies/{companyId}/tools/apps/{connectionId}/finalize-oauth-access`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-tools-apps-finish`

API: `present` — `POST /api/companies/{companyId}/tools/apps/{connectionId}/finish`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections` and `tools:manage_profiles`; current and requested audience/target authority, including nested `access`, all agents, and retained bindings.
Evidence: `verified` — [assembled-server integration](../../server/src/__tests__/connection-management.integration.test.ts), actual bearer/session authentication, persisted PostgreSQL state, and deterministic local MCP/provider fixtures.
Verification: `passed` — 25-scenario fixture suite on a fresh isolated PostgreSQL database, including scoped denial, approved continuation, revocation, cancellation and replay. No live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-tool-connections-reconnect`

API: `present` — `POST /api/tool-connections/{connectionId}/reconnect`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.
## `task-request`

Capability ID: `connection-setup/task-request`.

Review: `operation-reviewed`.

### `post-runtime-tools-connections-request`

API: `present` — `POST /runtime-tools/connections/request`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/connection-intents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-connection-intents-decline`

API: `present` — `POST /api/connection-intents/{interactionId}/decline`; JSON REST.
Agent access: `restricted` — existing human setup or approval surface; agent can identify the saved setup and inspect the result.
Policy: Human consent, identity confirmation, action approval, or trusted-host administration. This endpoint does not delegate human identity or self-approval to an agent.
Evidence: `source-only` — [route](../../server/src/routes/connection-intents.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: Agent invocation is denied by the stated policy. The authorized human or operator must perform this step; this entry does not claim delegated execution.
## `channel-setup`

Capability ID: `connection-setup/channel-setup`.

Review: `operation-reviewed`.

### `post-companies-chat-endpoints`

API: `present` — `POST /api/companies/{companyId}/chat-endpoints`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/chat-channels.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.
## `failure`

Capability ID: `connection-setup/failure`.

Review: `operation-reviewed`.

### `post-tool-connections-health-check`

API: `present` — `POST /api/tool-connections/{connectionId}/health-check`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.
