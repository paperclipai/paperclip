# Tool gateways and access profiles — agent access

Product map: [gateways-profiles](../feature-map/gateways-profiles.md).

Feature ID: `gateways-profiles`.

Delegated native entries inherit the [native admission and work-mode limits](README.md#native-rest-transport).

Review date: 2026-10-26. Source base: `a1f77821b9cd5c9c846fdf7a0fa5cc620ad2b6bb`; implementation: [#17737](https://github.com/paperclipai/paperclip/pull/17737).

Connection operations reviewed in this working tree. The inventory was reconciled
against production UI clients, REST registrations and service entry points; it is
a review checklist, not a runtime registry. [Authorization and evidence contract](../../doc/plans/2026-10-13-connection-api-parity.md).
Fixture evidence is separate from live provider qualification and from empirical
LLM success. Source-only entries have a reviewed agent path or an explicit boundary,
but do not claim an individually executed HTTP test.

## `gateway`

Capability ID: `gateways-profiles/gateway`.

Review: `operation-reviewed`.

### `get-companies-tools-gateways`

API: `present` — `GET /api/companies/{companyId}/tools/gateways`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections (responsible user: tools:admin)`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/tool-gateway.ts); [authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) inspect the saved gateway after a denied binding change.
Verification: `passed` — local assembled server and real database; gateway visibility and unchanged target assignment after profile-grant revocation. No live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-companies-tools-gateways`

API: `present` — `POST /api/companies/{companyId}/tools/gateways`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections (responsible user: tools:admin)`; bindings also require `tools:manage_profiles`. [Shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `patch-tool-gateway-gateways`

API: `present` — `PATCH /api/tool-gateway/gateways/{gatewayId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections (responsible user: tools:admin)`; setting or clearing bindings also requires `tools:manage_profiles`. [Shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/tool-gateway.ts); [authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) exercise persisted binding changes and revoked/scoped authority.
Verification: `passed` — local assembled server and real database. Clearing a binding requires retained profile authority; replacement profile/project changes require access to both saved and replacement resources. Authorized changes persist. No live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.
## `profiles`

Capability ID: `gateways-profiles/profiles`.

Review: `operation-reviewed`.

### `get-companies-tools-profiles`

API: `present` — `GET /api/companies/{companyId}/tools/profiles`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_profiles`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) exercise saved application/catalog/tool-name/risk selectors, allow-all profiles, managed empty profiles, personal-account visibility, and scoped grants through actual keys and run JWTs.
Verification: `passed` — local assembled server and real database; inaccessible profile resources are omitted from lists and denied before new-tool or effective-profile data is returned. Proposed broad entries and installed connections use the same authority checks.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-companies-tools-profiles`

API: `present` — `POST /api/companies/{companyId}/tools/profiles`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_profiles`; mutations whose entry selectors resolve connections also require `tools:manage_connections`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `get-companies-tools-profiles-effective-agents`

API: `present` — `GET /api/companies/{companyId}/tools/profiles/effective/agents/{agentId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_profiles`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) exercise saved application/catalog/tool-name/risk selectors, allow-all profiles, managed empty profiles, personal-account visibility, and scoped grants through actual keys and run JWTs.
Verification: `passed` — local assembled server and real database; inaccessible profile resources are omitted from lists and denied before new-tool or effective-profile data is returned. Proposed broad entries and installed connections use the same authority checks.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `patch-tool-profiles`

API: `present` — `PATCH /api/tool-profiles/{profileId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_profiles`; mutations whose entry selectors resolve connections also require `tools:manage_connections`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-tool-profiles-duplicate`

API: `present` — `POST /api/tool-profiles/{profileId}/duplicate`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_profiles`; mutations whose entry selectors resolve connections also require `tools:manage_connections`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `delete-tool-profiles`

API: `present` — `DELETE /api/tool-profiles/{profileId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_profiles`; mutations whose entry selectors resolve connections also require `tools:manage_connections`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-tool-profiles-entries`

API: `present` — `POST /api/tool-profiles/{profileId}/entries`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_profiles`; mutations whose entry selectors resolve connections also require `tools:manage_connections`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `patch-tool-profile-entries`

API: `present` — `PATCH /api/tool-profile-entries/{entryId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_profiles`; mutations whose entry selectors resolve connections also require `tools:manage_connections`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `delete-tool-profile-entries`

API: `present` — `DELETE /api/tool-profile-entries/{entryId}`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_profiles`; mutations whose entry selectors resolve connections also require `tools:manage_connections`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-tools-profiles-bind`

API: `present` — `POST /api/companies/{companyId}/tools/profiles/{profileId}/bind`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_profiles`; mutations whose entry selectors resolve connections also require `tools:manage_connections`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user. Resolve issue/routine/gateway targets, private parent/project access, and affected agents. Existing bindings and saved gateway profile references retain the same checks.
Evidence: `verified` — [production-authenticated integration fixture](../../server/src/__tests__/connection-management.integration.test.ts) with real database persistence and deterministic provider responses where required.
Verification: `passed` — Actual authenticated requests bind/unbind an authorized task and reject issue/routine/gateway targets outside agent configuration scope. Existing bindings and gateway profile references are rechecked on profile edits.
Gaps: Fixture evidence does not qualify live provider behavior or an empirical model success rate.

### `post-companies-tools-profiles-unbind`

API: `present` — `POST /api/companies/{companyId}/tools/profiles/{profileId}/unbind`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_profiles`; mutations whose entry selectors resolve connections also require `tools:manage_connections`. [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user. Resolve issue/routine/gateway targets, private parent/project access, and affected agents. Existing bindings and saved gateway profile references retain the same checks.
Evidence: `verified` — [production-authenticated integration fixture](../../server/src/__tests__/connection-management.integration.test.ts) with real database persistence and deterministic provider responses where required.
Verification: `passed` — Actual authenticated requests bind/unbind an authorized task and reject issue/routine/gateway targets outside agent configuration scope. Existing bindings and gateway profile references are rechecked on profile edits.
Gaps: Fixture evidence does not qualify live provider behavior or an empirical model success rate.
## `client-connect`

Capability ID: `gateways-profiles/client-connect`.

Review: `operation-reviewed`.

### `get-mcp-gateways`

API: `present` — `GET /mcp/gateways/{gatewayPublicId}`; browser/provider/MCP protocol.
Agent access: `restricted` — GET always returns HTTP 405 with `Allow: POST`. Use the corresponding POST MCP operation.
Policy: GET streaming is unsupported; this is a transport boundary independent of principal permissions. POST still requires the documented MCP authentication and resource policy.
Evidence: `source-only` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — source-reviewed fixed 405 handler. A protocol check should assert status 405 and `Allow: POST`; use POST to exercise authenticated MCP calls.
Gaps: No GET event stream is implemented. This entry does not advertise a usable GET client connection.

### `post-mcp-gateways`

API: `present` — `POST /mcp/gateways/{gatewayPublicId}`; browser/provider/MCP protocol.
Agent access: `available` — existing authenticated MCP/provider protocol; not callable as JSON REST.
Policy: Provider state/signature or gateway-token verification, company and resource binding; browser returns require the configuring human. Agent-issued durable gateway tokens retain both issuer and responsible-user authority. Issuer and target Block/Ask first/rate decisions intersect using the existing evaluator; credentials must select the same identity. Human continuation rechecks current token actions, scope, grants and both policies. Approval attribution records the issuer independently of the target; deleted tokens fail closed. Board clients and run-bound heartbeat clients retain their separate behavior.
Evidence: `verified` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — local assembled server and actual gateway-token authentication. Durable clients survive setup-run completion, honor purpose scopes, and reject revoked user/issuer authority and a cleared issuer foreign key. Thirteen actual-auth cases additionally verify issuer/target Block, governed approval, current policy/grant/token revocation and deletion, narrowed actions, independent/shared rates, credential identity and board-issued approval compatibility. No live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `get-tool-gateway-gateways-mcp`

API: `present` — `GET /api/tool-gateway/gateways/{gatewayId}/mcp`; browser/provider/MCP protocol.
Agent access: `restricted` — GET always returns HTTP 405 with `Allow: POST`. Use the corresponding POST MCP operation.
Policy: GET streaming is unsupported; this is a transport boundary independent of principal permissions. POST still requires the documented MCP authentication and resource policy.
Evidence: `source-only` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — source-reviewed fixed 405 handler. A protocol check should assert status 405 and `Allow: POST`; use POST to exercise authenticated MCP calls.
Gaps: No GET event stream is implemented. This entry does not advertise a usable GET client connection.

### `post-tool-gateway-gateways-mcp`

API: `present` — `POST /api/tool-gateway/gateways/{gatewayId}/mcp`; browser/provider/MCP protocol.
Agent access: `available` — existing authenticated MCP/provider protocol; not callable as JSON REST.
Policy: Provider state/signature or gateway-token verification, company and resource binding; browser returns require the configuring human. Agent-issued durable gateway tokens retain both issuer and responsible-user authority.
Evidence: `source-only` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-tool-gateway-tools`

API: `present` — `GET /api/tool-gateway/tools`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-tool-gateway-tools-call`

API: `present` — `POST /api/tool-gateway/tools/call`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.
## `tokens`

Capability ID: `gateways-profiles/tokens`.

Review: `operation-reviewed`.

### `post-tool-gateway-gateways-tokens`

API: `present` — `POST /api/tool-gateway/gateways/{gatewayId}/tokens`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections (responsible user: tools:admin)`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `verified` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above. [Authenticated fixtures](../../server/src/__tests__/connection-management.integration.test.ts) passed with database persistence and actual bearer/session middleware.
Verification: `passed` — deterministic provider fixtures / local assembled server; no live provider qualification.
Gaps: Provider fixtures do not qualify live provider setup or availability.

### `post-tool-gateway-gateway-tokens-revoke`

API: `present` — `POST /api/tool-gateway/gateway-tokens/{tokenId}/revoke`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_connections (responsible user: tools:admin)`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-tool-gateway-sessions`

API: `present` — `POST /api/tool-gateway/sessions`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-tool-gateway-sessions-revoke`

API: `present` — `POST /api/tool-gateway/sessions/{sessionId}/revoke`; JSON REST.
Agent access: `available` — existing REST/native runtime tool or scoped gateway client, as documented by the linked route.
Policy: Existing run-bound tool, scoped credential lease, execution policy, or assigned-email-agent checks; connection-management grants do not bypass these controls.
Evidence: `source-only` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.
## `activity`

Capability ID: `gateways-profiles/activity`.

Review: `operation-reviewed`.

### `get-companies-tools-runtime-slots`

API: `present` — `GET /api/companies/{companyId}/tools/runtime-slots`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_runtime`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-tools-runtime-slots-stop`

API: `present` — `POST /api/companies/{companyId}/tools/runtime-slots/{id}/stop`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_runtime`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-companies-tools-runtime-slots-restart`

API: `present` — `POST /api/companies/{companyId}/tools/runtime-slots/{id}/restart`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_runtime`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-tools-runtime-health`

API: `present` — `GET /api/companies/{companyId}/tools/runtime-health`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_runtime`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-companies-tools-runs-decisions`

API: `present` — `GET /api/companies/{companyId}/tools/runs/{runId}/decisions`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:view_audit`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-access.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-tool-gateway-runtime-slots`

API: `present` — `GET /api/tool-gateway/runtime-slots`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_runtime`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-tool-gateway-runtime-slots-stop`

API: `present` — `POST /api/tool-gateway/runtime-slots/{slotId}/stop`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_runtime`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `post-tool-gateway-runtime-slots-restart`

API: `present` — `POST /api/tool-gateway/runtime-slots/{slotId}/restart`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:manage_runtime`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.

### `get-tool-gateway-audit`

API: `present` — `GET /api/tool-gateway/audit`; JSON REST.
Agent access: `available` — agent REST and default native `search_api` / `call_api`.
Policy: `tools:view_audit`; [shared management policy](../../doc/plans/2026-10-13-connection-api-parity.md#authorization-contract). Resolved resources and every affected target are checked; personal ownership remains the responsible user.
Evidence: `source-only` — [route](../../server/src/routes/tool-gateway.ts); reviewed in the working tree based on the source commit above.
Verification: `not-run` — individual operation not executed in this audit; shared authorization and representative family flows are exercised by the authenticated integration suite. Follow the route schema, inspect persistence/audit, and assert owner, scope and revoked-authority denial.
Gaps: This individual operation has source review but no recorded HTTP verification. Provider availability and live setup remain unqualified.
