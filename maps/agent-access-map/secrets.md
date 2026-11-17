# Secrets, personal credentials, and proposals — agent access

Product map: [Secrets, personal credentials, and proposals](../feature-map/secrets.md).

Feature ID: `secrets`.

The agent **Secrets** page shows inline environment variables alongside company
and user secret references. Inline values stay redacted on configuration reads.
This presentation uses the existing agent configuration APIs and permissions;
it does not grant another agent access to those values.

Source revision: `3bbc2104b65caf9f7763938a01260a5673e12f7a`.

Review depth and executed proof are separate. The operation records enumerate the named behavior and access boundaries. Their evidence states describe the reviewed sources; run results and environment limits belong in the PR or verification artifacts. A listed API or source test does not establish a live authorized journey. Follow the [map contract](../README.md).

- UI: `/company/settings/secrets` ([ui/src/App.tsx:187](../../ui/src/App.tsx)), company/personal Secrets, My secrets, Vaults, Proposals tabs in [ui/src/pages/Secrets.tsx:657](../../ui/src/pages/Secrets.tsx); `?secret=<id>`/`?definition=<id>` opens inspectable detail sheets (`Secrets.tsx:673`). Hidden tabs are presentation only: APIs stay live. Relevant UI sources: `ui/src/pages/secrets/{MyUserSecretsTab,SetMyUserSecretDialog,ProposalsTab,ImportFromVaultDialog}.tsx`; agent env/API-access editing in [ui/src/components/AgentConfigForm.tsx:536](../../ui/src/components/AgentConfigForm.tsx) and [ui/src/lib/secret-delivery.ts](../../ui/src/lib/secret-delivery.ts).
- All board route operations require board identity and company/resource access, plus ordinary viewer-write protection. Company secret CRUD and vault administration use their own board checks. Definition administration and direct secret-proposal resolution require definition-admin authority; binding-proposal resolution instead checks target agent_config:update authority. The binding dependency cascade has a separate enforcement gap recorded under approve. Source [secret routes](../../server/src/routes/secrets.ts) and each handler. There is no board endpoint that returns arbitrary stored plaintext values.
- Native production agent path is admitted `search_api`/`call_api` over the exact REST operation, not the declared `read_secret_value`/`list_secret_metadata` scenario names. Production authority does not bind those two dedicated scenario actions ([server/src/services/native-runtime/paperclip-runner-tool-authority.ts:124,501,616,641](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts); catalog [runner-api-catalog.ts:43-123](../../server/src/services/native-runtime/runner-api-catalog.ts)). Native fallback needs rollout admission, running authorized bound agent/task/run, current assignment/execution and budget/company/privacy authority. GETs are available in Ask/Plan; POST/DELETE secret operations are not, including POST value retrieval even though its business meaning is reading. Skill-test may appear in catalog allowedModes but secret authorization denies its JWT scope. Actual run scope survives restart/task mode edits. See [runner-api-client.ts:50-61](../../server/src/services/native-runtime/runner-api-client.ts), [runner-api-catalog.ts:117-123](../../server/src/services/native-runtime/runner-api-catalog.ts), [paperclip-runner-tool-authority.ts:1190-1230,2440-2485](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts).
- Legacy shell/REST uses actual bearer actor and signed JWT run context, not merely an X-Paperclip-Run-Id. `secrets` CLI wraps company/vault operations; it has no personal-secret/proposal/value command family. Direct REST remains necessary for those. CLI installation/working shell must be separately established for a given runtime; do not assume remote/native CLI presence.
- Public personal-assistant MCP is a bounded named capability catalog, not arbitrary native call_api: no secret/vault/proposal operation is exposed in `server/src/services/public-mcp/{capabilities,expanded-capabilities}.ts`. An assistant can request human action through a task/comment, but no secret-specific administrative delegation was found.
- `secrets:read`/`secrets:propose` use the shared access evaluator. Standard same-company agent visibility is default-allowed, but effective low trust, task_bridge and skill_test scopes deny these actions ([authorization.ts:1313,1492,1563,2451](../../server/src/services/authorization.ts)). A recorded responsible/authorizing user adds the current user ceiling; responsible-user intersection has an operator shadow-mode setting, so record mode instead of claiming unconditional enforcement ([authorization.ts:2650-2795](../../server/src/services/authorization.ts)). Run JWT source/claims, header mismatch, responsible identity and canceled-write fencing: [middleware/auth.ts:395-480](../../server/src/middleware/auth.ts), [agent-run-cancellation.ts:6](../../server/src/agent-run-cancellation.ts).
- Redaction/persistence: run value reads register dynamic secret redaction before returning and fail closed if registration cannot persist. Activity/access manifests contain IDs, versions, paths and outcomes, not values. Native credential value replies stay inline, capped at 10 MiB, with encrypted mutation receipts; they are not plaintext saved API-result assets. Histories omit bodies. Same native call ID replays the stored encrypted result without rereading/side effects. Source [runner-api-sensitive-response.ts:1](../../server/src/services/native-runtime/runner-api-sensitive-response.ts), [runner-api-client.ts](../../server/src/services/native-runtime/runner-api-client.ts), [paperclip-runner-tool-authority.ts](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts) API receipt path, [runner-api-log-redaction.ts](../../server/src/services/native-runtime/runner-api-log-redaction.ts), [run-secret-redaction.ts](../../server/src/services/run-secret-redaction.ts). A fresh call is necessary to prove current revocation/rotation; replay intentionally returns the original receipt.
- Important precision: proposals require a verified run JWT and a matching existing run, but **the direct proposal service does not independently require run.status=running** ([secret-proposals.ts:42-53](../../server/src/services/secret-proposals.ts)). Native fallback does require a running authorized binding; value-list/read service explicitly requires running. Do not turn the broader prose “active run” into a claim that every legacy proposal handler has a live-status check. Cancellation still fences non-GET REST writes in auth middleware.

## `company-secrets`

Capability ID: `secrets/company-secrets`.

Review: `operation-reviewed`.

Discover safe company metadata; administer, rotate, inspect, delete and bind company secret references. Direct administration stays board-restricted; catalog and governed proposals are separate agent paths.

### `catalog`

API: `present` — `GET /api/companies/{companyId}/secrets/catalog`.

Agent access: `available` through permitted same-company legacy REST or admitted native GET call_api. No dedicated secrets CLI catalog command.

Policy: board_or_agent, company access and `secrets:read`. Returns only `{id,name,key,status}` for nondeleted company-scope secrets; user/instance scopes and values/material are excluded. Board full metadata listing below is a different route.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [routes/secrets.ts:585](../../server/src/routes/secrets.ts); [services/secrets.ts:3793](../../server/src/services/secrets.ts).

Verification: `not-run` — compare exact projected fields; deny unauthenticated/other-company/low-trust/task-bridge/skill-test contexts and responsible-user ceiling; create user/instance controls and confirm absent. Test source [__tests__/secrets-routes.test.ts:1066-1135](../../server/src/__tests__/secrets-routes.test.ts), [agent-secrets-routes.test.ts:270](../../server/src/__tests__/agent-secrets-routes.test.ts).

Gaps: no live/native catalog evidence from this wave; do not label whole company secret management agent-available.

### `list-metadata-and-audit`

API: `present` — `GET /api/companies/{companyId}/secrets`; `GET /api/secrets/{id}/usage`; `GET /api/secrets/{id}/access-events`.

Agent access: `restricted`, board API/CLI `secrets list -C`, `secrets usage <id>`, `secrets access-events <id>`; native agent call_api remains board-denied.

Policy: company-scope only; user/instance IDs are hidden. Cross-company usage/audit returns same 404 shape as missing ID. List returns metadata/reference counts, usage resolves consumer labels, access events are value-free. No generic GET secret-value API.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [routes/secrets.ts:594,1076,1091](../../server/src/routes/secrets.ts); [services/secrets.ts:3793-3851](../../server/src/services/secrets.ts); [cli/src/commands/client/secrets.ts:372,506,521](../../cli/src/commands/client/secrets.ts).

Verification: `not-run` — known binding reference/count and success/failure event persist/reload; value absent; other-company/user/instance ID and agent denied. Tests [secrets-routes.test.ts:904-1010](../../server/src/__tests__/secrets-routes.test.ts), [secrets-service.test.ts:1489,1530](../../server/src/__tests__/secrets-service.test.ts).

Gaps: board-only inspection has no agent-specific delegation beyond requesting human action.

### `create-managed-or-link-reference`

API: `present` — `POST /api/companies/{companyId}/secrets`.

Agent access: `restricted`; board API/CLI `secrets create -C ... --name ... --value-env <env-name>` or `secrets link -C ... --name ... --provider ... --external-ref ...`. Agent alternative is proposed secret creation, not direct write.

Policy: same company, same-provider selectable vault, valid unique path/name/key. Managed values require value and prohibit externalRef; external_reference requires supported provider/ref and stores provider reference metadata without fetching plaintext. Defaults use configured provider; GCP/Vault placeholders are not operational providers. New remote writes reserve/persist provider material with cleanup on DB failure; do not describe failed remote create as necessarily having no external effect.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [routes/secrets.ts:887](../../server/src/routes/secrets.ts); [services/secrets.ts:2176-2395](../../server/src/services/secrets.ts); [cli/.../secrets.ts:415,443](../../cli/src/commands/client/secrets.ts).

Verification: `not-run` — create managed dummy and link known test reference; reload metadata and bind/use separately. Assert duplicate/cross-company provider/mode/coming-soon failures, sanitized errors, ciphertext rather than plaintext at rest. Inspect provider cleanup and retained cleanup handle after failure. Tests [secrets-service.test.ts:2627,2923,2943,3007-3135](../../server/src/__tests__/secrets-service.test.ts); [secrets-routes.test.ts:158,171](../../server/src/__tests__/secrets-routes.test.ts); [aws-secrets-manager-provider.test.ts:33,340](../../server/src/__tests__/aws-secrets-manager-provider.test.ts). Retry: create has no application idempotency key; repeated REST creation should conflict by name/key, not promise replay. Inspect state after uncertain outcomes; native same-call receipts provide their own replay.

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `edit-lifecycle`

API: `present` — `PATCH /api/secrets/{id}`.

Agent access: `restricted`; board UI/CLI `secrets update <id> --payload-json ...`.

Policy: company-scope, nondeleted existing secret. Edit name/key/description and active/disabled/archived states; name/key uniqueness preserved. Generic PATCH cannot retarget externalRef/change external vault or reassign managed vault; managed deletion must use DELETE. External refs can be soft-deleted through PATCH (names/keys renamed), while full cleanup uses DELETE. Disabled/archived values stop resolving on fresh delivery/read. This does not erase values already issued to a process/model.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [routes/secrets.ts:1032](../../server/src/routes/secrets.ts); [services/secrets.ts:2619-2720](../../server/src/services/secrets.ts).

Verification: `not-run` — rename without breaking stable secret ID binding; disable/archive and show fresh delivery denied; reactivate and retry; reject retarget/vault/managed soft-delete, foreign/user/instance/deleted IDs; verify no value in activity. Tests [secrets-service.test.ts:3210,3968-4015,4215](../../server/src/__tests__/secrets-service.test.ts); [secrets-routes.test.ts:873](../../server/src/__tests__/secrets-routes.test.ts). Retry: repeated same metadata patch is state-setting; do not repeat a value rotation under this operation.

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `rotate-and-reference-version`

API: `present` — `POST /api/secrets/{id}/rotate`.

Agent access: `restricted`; board API/CLI `secrets rotate <id> --value-env ...` (CLI value wrapper is narrower than API ref/vault options).

Policy: active company secret. Managed mode requires new value; rotation creates a new latest version, marks old as previous, and can migrate managed vault through this route. Latest versus explicitly pinned consumer version matters: previous is not automatically revoked. For external_reference, API can rotate reference/version, or write new value through a provider that supports it; value-write cannot also retarget/pin providerVersionRef. External value updates are actual provider writes (AWS AWSCURRENT), not just local metadata.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [routes/secrets.ts:992](../../server/src/routes/secrets.ts); [services/secrets.ts:2397-2615](../../server/src/services/secrets.ts); [secrets/aws-secrets-manager-provider.ts:1120+](../../server/src/secrets/aws-secrets-manager-provider.ts).

Verification: `not-run` — bind one latest and one explicit version; rotate, reload latestVersion, verify new/latest and prior pinned behavior using harmless equality proof only; reject inactive/foreign/user/instance/provider mismatch. Controlled persistence failure must leave original current state or explicit cleanup evidence; external AWSCURRENT rollback is separate. Tests [secrets-service.test.ts:3135,3170,3239,3596-3734](../../server/src/__tests__/secrets-service.test.ts); [aws-secrets-manager-provider.test.ts:389,486](../../server/src/__tests__/aws-secrets-manager-provider.test.ts). Retry: repeated fresh rotation increments versions; the public rotation schema has no general idempotency token or compare-and-swap field. Inspect metadata/provider state before retrying an uncertain response. Verify ordinary native agent denial; encrypted native replay applies to permitted value retrieval below.

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `delete-and-cleanup`

API: `present` — `DELETE /api/secrets/{id}`.

Agent access: `restricted`; board UI/CLI `secrets delete <id> --yes --confirm <same-id>`.

Policy: company scope only; marks deleted/renames before provider cleanup, then removes DB rows. Retry can continue cleanup from soft-deleted state; after complete deletion returns missing. AWS provider deletes only Paperclip-managed remote material; deleting an external reference does not delete the externally owned AWS secret. Removing a disabled-vault local reference need not contact the unavailable vault. Instance/user values use separate paths.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [routes/secrets.ts:1106](../../server/src/routes/secrets.ts); [services/secrets.ts:3379-3455](../../server/src/services/secrets.ts); [secrets/aws-secrets-manager-provider.ts:1313-1360](../../server/src/secrets/aws-secrets-manager-provider.ts).

Verification: `not-run` — remove disposable managed+external references; old catalog/binding/fresh read unavailable; external provider resource remains for linked reference; provider failure leaves nonresolvable cleanup state, retry succeeds without restoring authority. Tests [secrets-routes.test.ts:1010](../../server/src/__tests__/secrets-routes.test.ts), [secrets-service.test.ts:4032-4171](../../server/src/__tests__/secrets-service.test.ts), [aws-secrets-manager-provider.test.ts:917](../../server/src/__tests__/aws-secrets-manager-provider.test.ts).

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `bind-unbind-and-migrate`

API: `present` — ordinary target configuration API, concrete agent path `PATCH /api/agents/{id}` with adapterConfig env secret_ref or top-level `access.<ALIAS>` ref. Project/routine/environment consumer bindings follow their own configuration APIs and policy; do not invent a universal secret-binding CRUD route. `secrets declarations -C ...` uses `POST /api/companies/{companyId}/exports/preview` for portability declarations (not live value grants).

Agent access: `partial`—direct config edit only where actual `agent_config:update`/target policy permits; creating/changing another agent credential is not implied by catalog read. Binding proposal is explicit self/report human approval route. CLI `secrets migrate-inline-env -C ...` dry-run; `--apply` creates/rotates secrets then PATCHes agents under board authority.

Policy: same-company reference and target, target config grants, env path versus access alias validation, no instance/user secret_id treated as company ref; user_secret_ref declaration separately. API-access top-level aliases are only for agent target. Low-trust allowed binding IDs and class-3 static-lease allowlist must remain enforced. Unbinding is removing config ref plus persisted binding sync; aliases dropped by Secret access editor need replacement config semantics. Migration is a multi-request workflow, not atomic.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [routes/agents.ts:1774,5262-5490](../../server/src/routes/agents.ts); [services/secrets.ts:4720-5184](../../server/src/services/secrets.ts); [AgentConfigForm.tsx:536](../../ui/src/components/AgentConfigForm.tsx); [cli/.../secrets.ts:283-365](../../cli/src/commands/client/secrets.ts); [ui/src/lib/secret-delivery.ts](../../ui/src/lib/secret-delivery.ts).

Verification: `not-run` — bind env-only, API-only, both, unbind, reload config+usage and verify fresh delivery changes; alias rename and unrelated binding survive; cross-company/unknown/deleted refs denied before deleting existing bindings. Dry-run migration must not write; apply removes inline values and uses secret refs; failure/retry inspect partial state. Tests [agents-service-secret-bindings.test.ts](../../server/src/__tests__/agents-service-secret-bindings.test.ts), [secrets-service.test.ts:293,489,1450,1607,1647,2555](../../server/src/__tests__/secrets-service.test.ts), [cli/src/__tests__/secrets.test.ts](../../cli/src/__tests__/secrets.test.ts).

Gaps: full policy of every non-agent binding target is outside this secrets-only source wave; link existing owning feature maps rather than mark all targets qualified.

## `user-secrets`

Capability ID: `secrets/user-secrets`.

Review: `operation-reviewed`.

Separate company-admin definitions and aggregate coverage from each authenticated person’s private value lifecycle; runtime resolves only the captured responsible user’s value.

### `definitions-list-create-edit-disable-delete`

API: `present` — `GET|POST /api/companies/{companyId}/user-secret-definitions`; `PATCH|DELETE /api/companies/{companyId}/user-secret-definitions/{definitionId}`.

Agent access: `restricted`—company owner/admin (or existing local implicit/instance admin) with company access; no ordinary agent/native/CLI secret command for personal definitions. Direct user API/browser is real path.

Policy: definition != personal value. Definition owns key/name/provider/mode/guidance; company uniqueness/provider/vault checks. Disabling blocks required resolution. Definition deletion (DELETE or PATCH deleted) removes all owners' values/provider material then tombstones/renames definition; a required dangling declaration gives actionable definition/field/consumer error without value. Optional missing declarations resolve to absent.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [routes/secrets.ts:68,602-720](../../server/src/routes/secrets.ts); [services/secrets.ts:3456,3853-3974](../../server/src/services/secrets.ts).

Verification: `not-run` — admin creates, edits/disable/reactivate, then deletes disposable definition after two users set different dummy values; ensure owners/values gone and required stale ref fails clearly; member/agent/foreign denied, implicit board attribution system-safe. Tests [secrets-routes.test.ts:219-306](../../server/src/__tests__/secrets-routes.test.ts); [secrets-service.test.ts:2163-2313](../../server/src/__tests__/secrets-service.test.ts); [secrets-service-dangling-user-secret.test.ts](../../server/src/__tests__/secrets-service-dangling-user-secret.test.ts). Retry: duplicate key ->409, mutation/reload verifies persistence; deletion may have provider partial cleanup so inspect/retry rather than claim transaction across vault writes.

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `coverage`

API: `present` — `GET /api/companies/{companyId}/user-secret-definitions/{definitionId}/coverage`.

Agent access: `restricted` to same definition-admin authority.

Policy: aggregate configured/inactive/missing counts across active human members; no values or arbitrary owner's credential read. Does not make every member's personal secret visible in company catalog.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [routes/secrets.ts:720](../../server/src/routes/secrets.ts); [services/secrets.ts:3975-4010](../../server/src/services/secrets.ts).

Verification: `not-run` — two active members, one configured then disabled; counts change after reload; inactive/nonmember values do not count; nonadmin/agent/foreign denied. No dedicated live proof in review.

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `owner-values-list-create`

API: `present` — `GET|POST /api/companies/{companyId}/me/user-secrets`.

Agent access: `restricted`—concrete authenticated board user only, company access; local implicit board with no userId fails `User identity required`. No ordinary agent impersonation or ownerId parameter allowed.

Policy: list pairs eligible definitions with current user's metadata or missing value. One value per definition+owner, active definition required, managed/external mode guards; provider config belongs to company. Value stored in user scope with derived unique key; no plaintext readback. User B cannot inspect/edit A by guessing ID; legacy company-secret endpoints hide user-scoped IDs.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [routes/secrets.ts:86,727-773](../../server/src/routes/secrets.ts); [services/secrets.ts:1068-1095,2985-3160,4011-4037](../../server/src/services/secrets.ts).

Verification: `not-run` — A/B set distinct values, switch sessions and see only own state; duplicate value 409 including race; absent user/company/definition/inactive mode denied; metadata never returns value. Tests [secrets-routes.test.ts:306-383](../../server/src/__tests__/secrets-routes.test.ts); [secrets-service.test.ts:1783,2023,2061,2119](../../server/src/__tests__/secrets-service.test.ts); owner-scoped tests concern runtime mediation, not proof of this browser session flow.

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `owner-values-edit-rotate-disable-delete`

API: `present` — `PATCH|DELETE /api/companies/{companyId}/me/user-secrets/{secretId}`; `POST .../{secretId}/rotate`.

Agent access: `restricted` to owner board user, company scoped; even definition-admin/instance-admin status is not an alternate owner's value API.

Policy: owner/scope/company lookup returns 404 on another owner's ID. PATCH nonnull value/ref/version/vault fields goes through rotation; status-only PATCH sets state; nullable value patches are not rotation. DELETE or PATCH deleted removes owner value/provider material. Explicit rotate rejects empty payload, uses same mode/version/provider guards. Definitions remain intact when an owner removes a value.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [routes/secrets.ts:774-886](../../server/src/routes/secrets.ts); [services/secrets.ts:1086,4054-4119](../../server/src/services/secrets.ts).

Verification: `not-run` — rotate increments latest, disable fresh runtime resolution, reactivate, remove only A value and keep definition/B value. Try B's value and company API mutation route ->404; confirm no value in success/error/activity. Tests [secrets-routes.test.ts:356-383](../../server/src/__tests__/secrets-routes.test.ts); [secrets-service.test.ts:2313](../../server/src/__tests__/secrets-service.test.ts); shared mode/provider tests as company rotation. Retry: fresh rotation is version-creating, no idempotency claim. Inspect current version on uncertain result; repeated completed DELETE missing is expected.

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

## `proposals`

Capability ID: `secrets/proposals`.

Review: `operation-reviewed`.

Run-JWT agents propose new secrets or self/report bindings, inspect and withdraw permitted requests; authorized humans resolve them and the server expires them with durable redaction and linked-card state.

Shared boundary: request creation/list/withdraw uses `/agents/me`, verified agent_jwt with company/agent/run, not long-lived agent_key; task_bridge and skill_test denied; `secrets:propose` effective trust/responsible-user policy. [Secret routes](../../server/src/routes/secrets.ts). Proposal service [secret-proposals.ts](../../server/src/services/secret-proposals.ts). Direct service checks matching run existence, not independently running status (native adds its binding check). Responses strip ciphertext; agent view also strips fingerprint/length; board metadata may include fingerprint/length. 20 pending per agent + 20 creations/minute, value <=64 KiB, expiry 14 days, default page 100, maximum 200. Do not claim direct POST idempotency: it can create duplicate requests on retry; native same-call receipt replay is the dedup layer.

### `propose-secret`

API: `present` — `POST /api/agents/me/secret-proposals` kind=secret.

Agent access: `available` via eligible run JWT REST/admitted native standard call_api; no dedicated CLI or admitted secret-specific production tool.

Policy: Apply the capability boundary above. name valid slash path, normalized key, nonempty justification/value; encrypted local pending ciphertext, value registered for run redaction, quota checked; no direct active company secret created before approval. Origin task inferred by execution/checkout run binding, can be null.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. See the route/service and test references in this operation and the shared source/surface contract. Cited controls were inspected, not executed.

Verification: `not-run` — pending proposal exists with origin agent/run/task, catalog lacks active secret, neither response/list/history/activity nor run logs disclose dummy; quota/oversize/untrusted/forged header/agent_key/scope denied. Failed redaction registration fails closed. Source [secret-proposals.ts:316](../../server/src/services/secret-proposals.ts); tests [secret-proposals-routes.test.ts:338,860](../../server/src/__tests__/secret-proposals-routes.test.ts); native actual-route [runner-api.integration.test.ts:449](../../server/src/services/native-runtime/runner-api.integration.test.ts).

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `propose-binding`

API: `present` — POST /api/agents/me/secret-proposals with kind=binding.

Agent access: `partial` — eligible run JWT REST/native; human governance remains intact.

Policy: Apply the capability boundary above. exactly one `secretId`, own `sourceConfigPath`, or pending same-company `secretProposalId`; `configPath` env.KEY or access.ALIAS. Target only self or downstream reports, source path owned by proposer. Direct secretId only company scope; own existing user-secret source declaration may be forwarded as a user_secret_ref preserving each future responsible user's personal value semantics. Store proposal-time organization snapshot and recheck current graph at approval. Quota and justification guard; creates linked binding confirmation interaction when origin task exists.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. See the route/service and test references in this operation and the shared source/surface contract. Cited controls were inspected, not executed.

Verification: `not-run` — self/report allowed, peer/manager/foreign/missing source/direct user secret forbidden; existing path differing binding conflicts on approval. Required dependency and source label survive reload, one source selector rule enforced; safe UI card does not contain value. Source [secret-proposals.ts:360-479,553,657](../../server/src/services/secret-proposals.ts); tests [secret-proposals-routes.test.ts:566-860,1288,1326,1489](../../server/src/__tests__/secret-proposals-routes.test.ts).

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `list-own-or-targeted`

API: `present` — `GET /api/agents/me/secret-proposals` with limit/offset.

Agent access: `partial` — same verified run JWT gate even though GET; includes own proposals or binding proposals targeting caller, not all company proposals. Native GET Ask/Plan still route JWT/trust policy governed.

Policy: Apply the capability boundary above. returns `{proposals,nextOffset}` with bounded pagination headers; value ciphertext/fingerprint/length stripped.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. See the route/service and test references in this operation and the shared source/surface contract. Cited controls were inspected, not executed.

Verification: `not-run` — owner/target versus unrelated peer list isolation; >one page, no duplicates/hidden value; invalid limits rejected. Source [routes/secrets.ts:219](../../server/src/routes/secrets.ts); [secret-proposals.ts:521](../../server/src/services/secret-proposals.ts); tests pagination [secret-proposals-routes.test.ts:860](../../server/src/__tests__/secret-proposals-routes.test.ts).

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `withdraw`

API: `present` — `DELETE /api/agents/me/secret-proposals/{id}`.

Agent access: `partial` — verified proposer JWT only, own pending same-company proposal.

Policy: Apply the capability boundary above. terminal proposal ->409, other proposer forbidden. Withdraw scrubs pending ciphertext and cascade-rejects pending binding dependents; linked card state mirrors withdrawn. Native Ask/Plan denies DELETE.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. See the route/service and test references in this operation and the shared source/surface contract. Cited controls were inspected, not executed.

Verification: `not-run` — withdraw pending secret+binding dependent; list/card reflect durable terminal state and no material; peer/foreign/second terminal transition denied. Source [routes/secrets.ts:234](../../server/src/routes/secrets.ts); [secret-proposals.ts:785](../../server/src/services/secret-proposals.ts); tests [secret-proposals-routes.test.ts:942,1455](../../server/src/__tests__/secret-proposals-routes.test.ts).

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `board-list-and-resolution-authority`

API: `present` — `GET /api/companies/{companyId}/secret-proposals` optional status/limit/offset.

Agent access: `restricted` board company read; no secret-proposal board list through public personal assistant catalog.

Policy: Apply the capability boundary above. bounded company list; calculated viewerCanApprove and block reason reflect pending status, secret-kind company-admin policy, binding target `agent_config:update` decision with `requiresChangeGrant:true`. Approval affordance is separate from permission to enumerate metadata.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. See the route/service and test references in this operation and the shared source/surface contract. Cited controls were inspected, not executed.

Verification: `not-run` — board list redacted metadata, member can inspect but cannot secret-approve, binding user without grant sees blocked reason; other company/agent denied. Source [routes/secrets.ts:165-192,240](../../server/src/routes/secrets.ts); [secret-proposal-authorization.ts](../../server/src/services/secret-proposal-authorization.ts).

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `approve`

API: `present` — `POST /api/companies/{companyId}/secret-proposals/{id}/approve`, optional cascade and overrides(name,description,providerConfigId).

Agent access: `restricted` — board. Direct secret approval requires company definition-admin authority; binding approval requires target agent config change authority. The current binding cascade does not independently enforce the dependency's secret-admin check; see Gaps below.

Policy: Apply the capability boundary above. only pending, unexpired, current self/report chain and authority rechecked after locks; chosen provider vault same company. Secret approval creates reference/material and scrubs pending ciphertext. Binding can cascade pending secret dependency with cascade=true; already approved dependency reused. Applying user source preserves user-secret declaration semantics. Existing different target config path conflicts. Approved secret retained if later binding apply fails; retry reuses it. Resolved state ->409, not repeated active secret creation. Linked card and dual secret/agent activity update; best-effort origin comment/wake failure does not turn committed approval into failure.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. See the route/service and test references in this operation and the shared source/surface contract. Cited controls were inspected, not executed.

Verification: `not-run` — approve secret then binding, both direct and cascade; selected vault persists. Wrong target grant/company/admin/mode, expired, changed org graph, duplicate resolution denied. Force binding failure after dependency commit and retry without creating second secret; assert ciphertext scrub + metadata-only audits and notification failure does not 500 committed state. Tests [secret-proposals-routes.test.ts:239,290,338,478,518,710,1168,1220,1254,1288,1489](../../server/src/__tests__/secret-proposals-routes.test.ts); sources [routes/secrets.ts:255](../../server/src/routes/secrets.ts), [secret-proposals.ts:718](../../server/src/services/secret-proposals.ts), [secret-proposal-notifications.ts](../../server/src/services/secret-proposal-notifications.ts).

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed. `approve()` cascades pending dependency via `applySecretApproval()` but only invokes assertCanResolve on the binding in loadForApproval; it does not separately call it for the secret dependency ([secret-proposals.ts:729-762](../../server/src/services/secret-proposals.ts)). Do not claim independent secret-admin recheck on a binding cascade without explicit evidence. Record this observed gap; map maintenance must not widen/fix governance implementation.

### `reject-and-expire`

API: `present` — `POST /api/companies/{companyId}/secret-proposals/{id}/reject` requires reason; no external expire endpoint (server bounded expiry sweeper).

Agent access: `partial` — reject restricted board with same kind/target resolution policy; expiration system-only.

Policy: Apply the capability boundary above. pending terminal transition, secret-kind reject also requires admin; scrub ciphertext, cascade-reject pending secret-dependent bindings, synchronize card rejection/withdrawal/expiry. At expiry approval rejects even before sweeper marks terminal. Concurrent card/proposal races serialize; no stale accepted card after resolved proposal.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. See the route/service and test references in this operation and the shared source/surface contract. Cited controls were inspected, not executed.

Verification: `not-run` — reject then repeat ->409; empty reason invalid; unauthorized reviewer/peer/foreign denied; time-controlled expiry and dependency/card state; no new runtime authority from rejected/expired proposal. Source [routes/secrets.ts:284](../../server/src/routes/secrets.ts), [secret-proposals.ts:785-891](../../server/src/services/secret-proposals.ts); tests [secret-proposals-routes.test.ts:224,906,942,995,1031,1080,1120,1168,1220](../../server/src/__tests__/secret-proposals-routes.test.ts).

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

## `vault-import`

Capability ID: `secrets/vault-import`.

Review: `operation-reviewed`.

Board operators manage nonsecret provider-vault configuration and health, preview metadata, and import external references with per-row outcomes and canonical duplicate checks.

### `provider-descriptor-and-health`

API: `present` — `GET /api/companies/{companyId}/secret-providers`; `GET .../secret-providers/health`; `POST /api/secret-provider-configs/{id}/health`.

Agent access: `restricted` board API/CLI `secrets providers -C`, `secrets doctor -C`, `secrets provider-config:health <id>`.

Policy: Common board/company read/write policy (not definition-admin policy). Agent REST/native remains restricted; CLI commands are board wrappers, not delegated agent authority. AWS implementation is operational; GCP/Vault are coming-soon/draft metadata. Config schemas reject credential-bearing keys/unsafe Vault addresses: credential values do not belong in provider config JSON. AWS credentials come from supported operator deployment/runtime source. [routes/secrets.ts:361-585,921-990](../../server/src/routes/secrets.ts); provider [secrets/aws-secrets-manager-provider.ts](../../server/src/secrets/aws-secrets-manager-provider.ts).

deployment provider descriptors/health differ from selected company vault health. Selected config state readiness and provider-returned sanitized health; persisted healthCheckedAt/message/details, safe activity. A health result is not secret resolution/import proof.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. See the route/service and test references in this operation and the shared source/surface contract. Cited controls were inspected, not executed.

Verification: `not-run` — owned configured/unconfigured/disabled/coming-soon vault health; persist timestamp/reload, no raw credential/provider body; nonboard/foreign denied. Tests [secrets-routes.test.ts:133,383](../../server/src/__tests__/secrets-routes.test.ts); [secret-provider-registry.test.ts](../../server/src/__tests__/secret-provider-registry.test.ts), [aws-secrets-manager-provider.test.ts:877](../../server/src/__tests__/aws-secrets-manager-provider.test.ts).

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `vault-list-get-create-update-disable`

API: `present` — `GET|POST /api/companies/{companyId}/secret-provider-configs`; `GET|PATCH /api/secret-provider-configs/{id}`.

Agent access: `restricted` board UI/API/CLI `provider-configs`, `provider-config:create/get/update` under `paperclipai secrets`; JSON mutations use `--payload-json`, company routes `-C`.

Policy: Common board/company read/write policy (not definition-admin policy). Agent REST/native remains restricted; CLI commands are board wrappers, not delegated agent authority. AWS implementation is operational; GCP/Vault are coming-soon/draft metadata. Config schemas reject credential-bearing keys/unsafe Vault addresses: credential values do not belong in provider config JSON. AWS credentials come from supported operator deployment/runtime source. [routes/secrets.ts:361-585,921-990](../../server/src/routes/secrets.ts); provider [secrets/aws-secrets-manager-provider.ts](../../server/src/secrets/aws-secrets-manager-provider.ts).

company-scoped provider/config, status ready/warning/disabled/coming_soon, display name and nonsecret provider options. GCP/Vault cannot be promoted to ready; disabled/coming-soon cannot be default/selected for new secret runtime resolution. Disable clears default. Configuration existence does not grant remote vault credentials/access.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. See the route/service and test references in this operation and the shared source/surface contract. Cited controls were inspected, not executed.

Verification: `not-run` — create/update dummy config, reload; reject sensitive fields, unsafe address, cross-company/agent, coming-soon promotion/default; disable then fresh resolution fails visibly while reference metadata remains. Tests [secrets-routes.test.ts:383-682](../../server/src/__tests__/secrets-routes.test.ts), [secrets-service.test.ts:2923-3007](../../server/src/__tests__/secrets-service.test.ts).

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `vault-default-and-remove`

API: `present` — `POST /api/secret-provider-configs/{id}/default`; `DELETE /api/secret-provider-configs/{id}`.

Agent access: `restricted` board UI/CLI `provider-config:default/delete <id>`.

Policy: Common board/company read/write policy (not definition-admin policy). Agent REST/native remains restricted; CLI commands are board wrappers, not delegated agent authority. AWS implementation is operational; GCP/Vault are coming-soon/draft metadata. Config schemas reject credential-bearing keys/unsafe Vault addresses: credential values do not belong in provider config JSON. AWS credentials come from supported operator deployment/runtime source. [routes/secrets.ts:361-585,921-990](../../server/src/routes/secrets.ts); provider [secrets/aws-secrets-manager-provider.ts](../../server/src/secrets/aws-secrets-manager-provider.ts).

only ready/warning default, one default per company+provider, transaction rechecks status. Removal removes local provider config, logs remoteDeleted:false; it does not delete remote provider data. Distinguish disabled metadata from removed config and inspect referencing secrets afterward rather than claiming migration.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. See the route/service and test references in this operation and the shared source/surface contract. Cited controls were inspected, not executed.

Verification: `not-run` — two vaults switch default/reload, wrong company/status denied, remove disposable config and verify provider secret survives, reconcile remaining references/health. Tests [secrets-service.test.ts:2691,2713,2728](../../server/src/__tests__/secrets-service.test.ts), [secrets-routes.test.ts:682](../../server/src/__tests__/secrets-routes.test.ts).

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `discover-config-and-preview-import`

API: `present` — `POST /api/companies/{companyId}/secret-provider-configs/discovery/preview` (draft config); `POST .../secrets/remote-import/preview` (saved providerConfigId).

Agent access: `restricted` board UI/CLI `provider-config:discovery-preview`, `remote-import:preview -C --payload-json ...`.

Policy: Common board/company read/write policy (not definition-admin policy). Agent REST/native remains restricted; CLI commands are board wrappers, not delegated agent authority. AWS implementation is operational; GCP/Vault are coming-soon/draft metadata. Config schemas reject credential-bearing keys/unsafe Vault addresses: credential values do not belong in provider config JSON. AWS credentials come from supported operator deployment/runtime source. [routes/secrets.ts:361-585,921-990](../../server/src/routes/secrets.ts); provider [secrets/aws-secrets-manager-provider.ts](../../server/src/secrets/aws-secrets-manager-provider.ts).

draft discovery does not persist vault; lists/samples metadata, query/page token/page size. Saved vault must be selectable in company, provider supports listing. Preview derives names/keys, canonical references, duplicate/name/key/provider-guardrail conflicts; does not read plaintext or import/create secret. AWS Paperclip-managed namespace cannot be imported as externally owned. Activity aggregate counts; provider failures sanitized.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. See the route/service and test references in this operation and the shared source/surface contract. Cited controls were inspected, not executed.

Verification: `not-run` — preview pagination, select ready versus duplicate/conflict, change draft without persistence, company/disabled/coming-soon/provider invalid; no GetSecretValue/plaintext during listing, no secret/vault row mutation. Tests [secrets-routes.test.ts:407-524,724-811](../../server/src/__tests__/secrets-routes.test.ts), [secrets-service.test.ts:3261-3369,3478-3596,3846](../../server/src/__tests__/secrets-service.test.ts), [aws-secrets-manager-provider.test.ts:536,617,714](../../server/src/__tests__/aws-secrets-manager-provider.test.ts).

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `commit-reference-import`

API: `present` — `POST /api/companies/{companyId}/secrets/remote-import`.

Agent access: `restricted` board UI/CLI `secrets remote-import -C ... --payload-json ...`.

Policy: Common board/company read/write policy (not definition-admin policy). Agent REST/native remains restricted; CLI commands are board wrappers, not delegated agent authority. AWS implementation is operational; GCP/Vault are coming-soon/draft metadata. Config schemas reject credential-bearing keys/unsafe Vault addresses: credential values do not belong in provider config JSON. AWS credentials come from supported operator deployment/runtime source. [routes/secrets.ts:361-585,921-990](../../server/src/routes/secrets.ts); provider [secrets/aws-secrets-manager-provider.ts](../../server/src/secrets/aws-secrets-manager-provider.ts).

same selectable saved vault; selected rows validated/canonicalized again, reference versions persisted, no plaintext fetched. Import operates row-by-row with imported/skipped/error counts, not atomic all-or-nothing. Exact canonical vault/reference duplicate skipped, name/key conflict skipped, remote guardrail/provider failure row error. Soft-deleted reference can be reimported; instance-secret same name/key does not collide with company ref.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. See the route/service and test references in this operation and the shared source/surface contract. Cited controls were inspected, not executed.

Verification: `not-run` — import two owned refs with one collision; reload metadata, expected imported/skipped/error, reference-only material. Repeat and confirm no second canonical ref; cross-company/disabled vault and Paperclip-managed namespace denied at commit even if preview old; change selection between preview/commit and inspect real outcomes. Tests [secrets-service.test.ts:3734-3968](../../server/src/__tests__/secrets-service.test.ts), [secrets-routes.test.ts:811](../../server/src/__tests__/secrets-routes.test.ts), [agent-instance-secrets.test.ts:222](../../server/src/__tests__/agent-instance-secrets.test.ts); source [services/secrets.ts:4403-4608](../../server/src/services/secrets.ts).

Gaps: only controlled AWS provider tests were inspected; live AWS identity, IAM, network, data ownership and actual import/rotation/deletion remain not-run. GCP/Vault do not get a live working path because draft config exists.

## `runtime-delivery`

Capability ID: `secrets/runtime-delivery`.

Review: `operation-reviewed`.

Authorize env/config projection, responsible-user personal values, run-bound company value retrieval, and the deliberately server-only instance lifecycle boundary.

### `env-and-config-projection`

API: `present` — configure bound consumer via its own API, then normal run/test lifecycle; no public arbitrary resolve-value endpoint for board. Concrete agent config `PATCH /api/agents/{id}`; normal task execution resolves saved bindings. User-perspective account/setup validation is separately scoped.

Agent access: `available` only for admitted authorized consumer projection; fresh model code sees its allowed env/config, not all company secret inventory. Environment injection is not blanket value-read API permission.

Policy: company secret binding must match consumer type/id/configPath and allowedBindingIds (when supplied), same company, active secret/version/vault. env.KEY -> env at run start; generic schema secret field -> adapter config; access.ALIAS -> API access and not env. latest versus pinned version recorded in value-free manifest, deleted/disabled/archived/version-disabled/revoked/provider-unavailable fail. Class-3 static lease needs exact approved target/path allowlist key. Missing required bindings block setup with diagnostic fields, optional absent personal ref skips. Audit writes best-effort in resolver, so a successful secret resolution alone does not prove every event persisted.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [services/secrets.ts:1132,1353-1455,5214,5282,5441,5598](../../server/src/services/secrets.ts); [ui/src/lib/secret-delivery.ts](../../ui/src/lib/secret-delivery.ts); tests [secrets-service.test.ts:1530,1567,1607,1647,1738,2345,2442,2490,2596,2662](../../server/src/__tests__/secrets-service.test.ts).

Verification: `not-run` — env-only/API-only/both plus generic secret field on eligible adapter, compare harmless equality/length result without returning dummy, manifest IDs/version/outcome and redacted logs/errors; unbind/disable/rotate and fresh run behavior; denied consumer/path/foreign/allowlist/version. Do not claim rotation/removal retracts already projected process/model bytes.

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `responsible-user-personal-projection`

API: `present` — PATCH /api/agents/{id} declares user_secret_ref in consumer configuration. Normal run/test projection then uses the captured responsible user; there is no arbitrary-agent personal-value endpoint. Owner value changes use the /me/user-secrets operations above.

Agent access: `partial` runtime projection only; user values are excluded from GET /agents/me/secrets and POST key/value direct company access.

Policy: definition active and declaration matching company/consumer/configPath, captured responsible user, exactly that user's personal value and optional/required semantics; missing responsible_user_missing/user_secret_missing/binding_missing actionable. Current identity capture should be used rather than caller-supplied user override. New execution's responsible user changes which value is used, not a copied owner's secret ID. Local pre-save adapter test has an explicit owner_scoped mediation exception: resolves only authenticated user's own values without saved declarations, rejects any allowedBindingIds array, and still requires responsible user. This exception is not general run/API bypass.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [services/secrets.ts:4212-4307,5598](../../server/src/services/secrets.ts); [routes/authz.ts:251+](../../server/src/routes/authz.ts); [routes/agents.ts:3277](../../server/src/routes/agents.ts); tests [secrets-service-user-secret-owner-scoped.test.ts](../../server/src/__tests__/secrets-service-user-secret-owner-scoped.test.ts) and [secrets-service-dangling-user-secret.test.ts](../../server/src/__tests__/secrets-service-dangling-user-secret.test.ts), [secrets-service.test.ts:1688,1783](../../server/src/__tests__/secrets-service.test.ts); [authz-secret-context.test.ts](../../server/src/__tests__/authz-secret-context.test.ts).

Verification: `not-run` — use the same saved agent configuration with separate runs capturing responsible users A and B; each gets its own harmless equality result. Missing/removed/inactive user or definition blocks a required value or skips an optional one; B must never fall back to A's value. Direct company resolver/catalog/API excludes personal values. Pre-save owner tests and persisted runtime require separate proof.

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `api-list-bound-metadata`

API: `present` — `GET /api/agents/me/secrets`.

Agent access: `available` with verified run-bound agent JWT via legacy REST or admitted native GET call_api; long-lived agent key plus fabricated run header denied, board denied.

Policy: explicit service running/company/agent/run check and `secrets:read`; low-trust/task_bridge/skill_test denied; only active company-scope bound secrets, direct agent env/access grants or IDs admitted in run secret manifest for other consumers. Returns key/name/description/delivery/projection/version plus opaque secretRef; hides internal bindingId/configPath and all values. It does not list user/instance or arbitrary unbound secret.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [routes/secrets.ts:314](../../server/src/routes/secrets.ts); [services/secrets.ts:1756](../../server/src/services/secrets.ts); tests [secrets-routes.test.ts:91](../../server/src/__tests__/secrets-routes.test.ts); [agent-secrets-routes.test.ts:122,270](../../server/src/__tests__/agent-secrets-routes.test.ts).

Verification: `not-run` — env-only/API-only/both and run-manifest project ref listed, unbound/user/instance absent; metadata exact projection; foreign peer run/ended run/non-JWT/scope/company denied; activity secret.access.listed count value-free.

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.

### `api-read-bound-value`

API: `present` — `POST /api/agents/me/secrets/{key}/value` (key is secret key from list, not access alias).

Agent access: `available` with same verified running JWT REST. Native POST call_api only admitted standard mode; Ask/Plan reject transport POST even though this reads a value. No admitted dedicated read_secret_value binding.

Policy: list eligibility rechecked then exact grant/configPath/version; direct agent target or manifest-bound other consumer; only env/access namespace, active company/version/vault. Register redaction before response; Cache-Control:no-store, response key/value/version. Value-free access and secret.value.read success/failure audits. User/instance excluded. Credential replay encryption/history omission/10MiB applies to native surface; direct REST has no native replay receipt.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. See the route/service and test references in this operation and the shared source/surface contract. Cited controls were inspected, not executed.

Verification: `not-run` — allowed caller compares dummy securely, different/unbound peer and fake/ended/mismatched JWT/header/company/mode/scope denied. Remove grant/disable/rotate then issue a fresh call to prove current authority; same native call ID replays original response without re-dispatch and without plaintext stored receipt/response assets/history. Fail redaction registration ->no value response. Tests [agent-secrets-routes.test.ts:122,230,270](../../server/src/__tests__/agent-secrets-routes.test.ts), [secrets-service.test.ts:1271,1336,1414](../../server/src/__tests__/secrets-service.test.ts); real authenticated HTTP native authority tests [services/native-runtime/runner-api.integration.test.ts:349-372](../../server/src/services/native-runtime/runner-api.integration.test.ts), [runner-api.test.ts:323-350](../../server/src/services/native-runtime/runner-api.test.ts), [runner-api-log-redaction.test.ts](../../server/src/services/native-runtime/runner-api-log-redaction.test.ts).

Gaps: fresh local source test is not actual provider/tool-model execution; native rollout and eligible target must be evidenced by coordinator.

### `server-only-instance-lifecycle`

API: `not-applicable` — trusted server lifecycle plugin callback/coordinator is the concrete existing path, not a new route or missing permission grant. `agentInstanceSecretService.apply/read` and native secret service `agentInstance`.

Agent access: `restricted`—never delivered to ordinary agent env/config/API catalog/value path. Owning installed lifecycle plugin server callback receives its scoped instance data. Agent cannot authorize itself into this owner scope.

Policy: company+owner agent+installed plugin, operation/version/phase/attempt lease owner and unexpired lease rechecked; nonnull writes only preparing/resuming. Encrypted local versions, isolated company/user names, removal/cascade on owning agent/plugin deletion; stale attempts fail. Lifecycle storage error must not be acknowledged as saved. Activity only key/action, not value.

Evidence: `source-only` — Reviewed at `3bbc2104b65caf9f7763938a01260a5673e12f7a`. [services/agent-instance-secrets.ts:10-38](../../server/src/services/agent-instance-secrets.ts); [services/secrets.ts:3494-3543](../../server/src/services/secrets.ts); tests [agent-instance-secrets.test.ts:49,107,118,134,148,174,190,206,247,266](../../server/src/__tests__/agent-instance-secrets.test.ts) (real DB/local encrypted storage/lifecycle callback controls, not hosted provider acceptance).

Verification: `not-run` — trusted lifecycle fixture save/rotate/restart/read in owner plugin only, stale version/phase/lease/company/plugin/agent denied, remove/cascade; ordinary binding/catalog/value read cannot access it; no value in logs/activity/evidence. This is a deliberate server custody restriction, not ordinary agent delivery.

Gaps: The enumerated source contract is reviewed; live verification remains not-run for the named actors, surfaces and dependencies. No broader provider/runtime qualification is claimed.
