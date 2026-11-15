# Paperclip Google Workspace implementation and approval handoff

Prepared November 15, 2026. Repository-safe engineering and operations handoff. No credentials are included.

This is the repository companion to the [private operator handoff](https://chatgpt.com/space/page_bfa08d7ab3308191955df1bfa5c5bb42). Account-specific identifiers, review correspondence, recordings, and raw evidence stay in that private handoff and its evidence library. Placeholder environment values below are not executable configuration.

**The goal is a working, production-supported Google Workspace integration with explicit Google data-access approval—not just merged code or a successful Gmail demo.** The selected-service UI is implemented and has bounded staging proof. The remaining work is to qualify the separate Google QA client, finish service and permission tests, provide safe reviewer access, satisfy data-handling and security requirements, record the required demonstration, and operate the verification case through an explicit decision.

The intended successor is an engineer working with a Cloud operator, a Google project owner, and a security/privacy owner. The roles below are proposed responsibilities, not new assignments or grants. Section 1 establishes the current baseline; section 2 defines the remaining implementation and testing; section 3 describes the approval operation; section 4 defines release, ownership, and where to resume.

## 1 The feature works in part but the review package is not ready

### The product contract is one Workspace connection with selected services

Paperclip should offer one Google Workspace integration with three groups: Gmail; combined Drive, Docs, Sheets, and Slides; and Calendar. All three groups default checked and read & write. Each permission dropdown sits between its service name and toggle. Google Chat, Contacts, and Directory are outside this feature and must stay out of its UI, requested grants, tools, documentation, and new submission materials.

The user's deliberate selection must determine the OAuth request, effective grant, available tools, and actual execution. Cancellation, retry, refresh, reconnect, partial consent, and existing connections must preserve truthful state without creating duplicate connections or silently increasing access. Checked defaults are not an authorization to expand an existing Google grant.

Success includes both the application and its operation: a reviewer can log in, connect an eligible Google account through the separate QA project, run real model-backed tasks, see correct Google results, and reproduce the submitted demonstration. Production must use the approved configuration and satisfy applicable provider and security obligations. OAuth verification, Workspace MCP eligibility, a staging deployment, and any Marketplace listing are separate matters; a Marketplace listing is not established as part of this task.

### The last runtime evidence is October 31 and must be refreshed

The evidence library has no later runtime checkpoint. The public checkout remained clean at `82d13d4d698a5579378b5d506cb7a1f9cb64b5c8` when inspected November 15. Do not assume the live stack still serves the October revision.

| Area | Established result | Remaining qualification |
| --- | --- | --- |
| Service selector | Three groups, all on/read & write, correct dropdown placement; legacy drafts without choices require deliberate selection. | Recheck on the current reviewer build, including removed-service request and tool exposure. |
| Interrupted setup | Gmail-only read survived real Google Cancel, Try again, leaving setup, catalog reload, and Finish setup on the same draft. | Complete actual QA-client authorization and partial-consent/reconnect cases. |
| Real task execution | A native Runner task retrieved the full synthetic email; all six paragraphs persisted and matched native Gmail. | Other submitted service functions, controlled writes, fresh-reviewer task, and actual denied invocations. |
| Delivery | The setup-persistence repair in [Core PR 18048](https://github.com/paperclipai/paperclip/pull/18048) merged October 31. Test 02 subsequently served Core `59da15066acd2077b1161b06217acfbd11f8da04`, distribution `cloud-41167244342-1`. | Fresh serving identity, then qualification of any intervening relevant changes. |
| Google review | November 15 reread of the case and targeted email search still found October 7 as the latest incoming case message. | Current Verification Center state, exact approved scopes, security-assessment status, and final decision. |

Source readiness was accepted using canonical CI and changed-path local evidence. The attempted local whole-suite command was interrupted/incomplete, not passed. The October walkthrough crossed an automatic staging rollout: critical Google feature files matched, but Runner code changed. It is not proof of an uninterrupted single-runtime journey.

The screenshot journeys also have explicit gaps: the main final frame captured the wrong tab, and the Gmail supplement withheld private-list and transition frames. Safe matching message frames support the Gmail comparison. Neither report is a complete reviewer video. Preserve these limitations; do not relabel old reports as clean end-to-end acceptance.

### Google has already explained why the case is stalled

The [verification conversation](https://chatgpt.com/space/page_bfa08d7ab3308191955df1bfa5c5bb42) contains a September 30 revised submission and an October 7 correction from Google. The reviewers could not authorize their account because the production OAuth project had reached its unverified 100-user cap. The video also failed to show sufficient end-to-end `gmail.readonly` functionality.

The correction requests a separate Google Cloud test project set to **In Production**, a test deployment actually using that project, working reviewer credentials and navigation, and a new video showing the full received-email body in Paperclip followed by the exact same email in native Gmail. Consent permissions must be expanded and readable, and requested scopes must match the Console submission. The older response and videos describe separate connectors and removed services; they must not be reused as current instructions.

Branding was verified and data access was under review at the last authenticated Console checkpoint. Neither silence nor branding approval proves current data-access approval. The Console was not reauthenticated for this handoff.

## 2 Finish the deployed integration and prove its permission boundaries

### Verify the actual OAuth identity before changing configuration

The agreed engineering QA target is Google test 02, whose URL is recorded in the [private operator handoff](https://chatgpt.com/space/page_bfa08d7ab3308191955df1bfa5c5bb42). Changing the reviewer destination is a separate decision; do not silently substitute another stack for its acceptance tests.

| Identity | Known configuration and significance |
| --- | --- |
| Production project | `PRODUCTION_PROJECT_ID`, project number `PRODUCTION_PROJECT_NUMBER`; this is the verification case. |
| Managed staging client | `MANAGED_STAGING_OAUTH_CLIENT_ID`; it belongs to the production project, despite being called staging. |
| Separate QA project | `SEPARATE_QA_PROJECT_ID`, project number `SEPARATE_QA_PROJECT_NUMBER`. External/In Production and zero of 100 users were observed October 28, not reverified now. |
| Separate QA client | `SEPARATE_QA_OAUTH_CLIENT_ID`; agentic was observed enabled October 28. |
| Test 02 direct callback | Callback shape: `https://REVIEWER_HOST/api/tools/oauth/callback`; use the agreed host from the private handoff. Exact current Console registration remains unverified. |

The successful observed managed flow used the managed staging client, not the separate QA client. Therefore it does not close Google's separate-project requirement. Earlier QA setup had a localhost callback; preserve legitimate local development entries rather than blindly replacing them. Inspect the real authorization request, callback, saved credential metadata, and subsequent tool operation before deciding a configuration change is necessary.

The last Console access stopped at a human passkey challenge. Use the Google project owner's normal authentication, without borrowing sessions or extracting tokens. Check the [QA clients](https://console.cloud.google.com/auth/clients) and [production Verification Center](https://console.cloud.google.com/auth/verification). A failed Console login does not itself prove that the OAuth client is misconfigured. A current branding preflight must also confirm the public homepage, privacy-policy link on the app domain and consent screen, verified authorized-domain ownership, consistent app identity, and staffed support/developer contacts.

### Freeze one exact scope contract across code and Console

The October served-source matrix requests **8 scopes for all read-only, 9 for all read & write, and 14 across all selectable modes**. Counts alone do not establish Console alignment. The legacy broker `workspace.all` profile contains 21 scopes and is not the current selector's request inventory.

All suffixes below have the prefix `https://www.googleapis.com/auth/`.

| Group | Read only | Read & write |
| --- | --- | --- |
| Gmail | `gmail.readonly` | `gmail.readonly`, `gmail.compose` |
| Drive, Docs, Sheets, Slides | `drive.readonly`, `documents.readonly`, `spreadsheets.readonly`, `presentations.readonly` | `drive.readonly`, `drive.file`, `documents`, `spreadsheets`, `presentations` |
| Calendar | `calendar.calendarlist.readonly`, `calendar.events.readonly`, `calendar.events.freebusy` | `calendar.calendarlist.readonly`, `calendar.events` |

**Paperclip's exposed Gmail write action is draft creation; Google's grant is broader.** Google classifies `gmail.readonly` and `gmail.compose` as restricted, and `gmail.compose` permits managing drafts and sending. Do not claim that OAuth itself prevents sending. Explain the app's closed action allowlist and why composition permission is needed, while testing that unimplemented sending is unavailable. [Google Gmail scope definitions](https://developers.google.com/workspace/gmail/api/auth/scopes)

For each exact scope, record: selector mode, authorization client, Google sensitivity category, user-visible feature, narrower-scope justification, actual test result, video chapter, and Console declaration/approval status. `drive.file` does not eliminate the review implications of also requesting `drive.readonly`. Reconcile removed services across current code, broker behavior, declarations, justifications, help text, and videos. Do not indiscriminately remove shared legacy configuration used by other integrations. [Drive scope guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

The source matrix covers 36 action admission rules; it is not proof that all actions were discovered or executed. Direct Core added no identity scopes in that audit; broker-added sign-in scopes remain a separate check. Recompute the matrix if the serving source changes.

### Complete live acceptance rather than collecting another happy path

Use controlled fixtures and the real UI, OAuth transport, and Runner. Record the serving revision, project/client, actor, selected services, effective grants, exact tool and fixture, observed outcome, and evidence for each case. Expected content belongs in the fixture, not pasted into the task as the answer.

| Test group | Required proof |
| --- | --- |
| First use and recovery | Natural Apps/Connectors entry, defaults, deliberate selection, Cancel, retry, reload, persistence, no duplicate active connection. |
| Consent boundaries | Gmail-only, combined file group, Calendar, read-only versus write, and actual partial consent. Requested, granted, and available capabilities must agree. |
| Useful reads | Complete synthetic email body, controlled Drive discovery/content, Docs content, Sheet values, Slides content, Calendar selection/events/free-busy as supported. |
| Controlled writes | Unsent Gmail draft and approved synthetic file/document/sheet/slides/calendar changes; show the resulting state in native Google. No real email send is needed for the implemented draft action. |
| Lifecycle | Reconnect, expiry/refresh through actual operation, revoked or reduced access, actionable recovery, and no reuse of superseded broader permission. A next-day read alone does not prove refresh occurred. |
| Negative execution and isolation | Unselected and read-only-incompatible actions, cross-company/user access, and fresh-reviewer-owned task/model access. Confirm no provider side effect where access should be denied. |

Keep admission layers distinct. Tool omission proves non-exposure; `tool_not_found` proves a catalog boundary; a principal-policy refusal proves that actor lacks authority. None automatically proves Google-scope rejection. The test wrapper may return HTTP 200 with an error such as `oauth_insufficient_scope`; inspect the semantic result, not just the status code.

The latest [native permission probe SOC-10](https://chatgpt.com/space/page_bfa08d7ab3308191955df1bfa5c5bb42) called `GET /api/agents/me` and found only `tasks:assign`. It stopped before an unselected-action call. **Zero such calls were made; actual scope denial remains unverified.** The normal assigned Gmail tool worked without this separate management/test permission.

The user authorized a temporary grant limited to this connection's test-call and result endpoints, but it was never applied. The deployed ordinary controls could not edit it; human-member permission writes reject agent members, and no advanced permission editor was installed. Administrator sign-in alone does not supply that editor. Resolve this through a supported, reviewed administration path or an appropriately qualified test actor/transport. Do not fabricate a pass by promoting Dotta B, replacing all grants, using SQL, or minting/extracting a gateway token. A permission-administration product change is separate from a Google scope change. Recheck the current deployed surface before assuming October's limitation still exists.

## 3 Operate Google approval as a dedicated delivery workstream

### Establish safe reviewer access before inviting anyone

Test 02 contains Dotta's organization-shared Gmail grant. At the last check, stock Operator could manage connections, while Viewer could not complete the intended connect-and-run journey. No suitable isolated reviewer role was established. Do not invite an external reviewer into that state.

The recommendation awaiting a destination decision is a clean reviewer instance with a dedicated test identity, synthetic Google data, and explicitly permitted model access. Keep engineering QA on Test 02 unless redirected. If Test 02 is selected for reviewers instead, prove isolation across connections, tasks, stored tool results, run history, artifacts, and model bindings; disconnecting or archiving alone is not erasure or access-isolation proof.

Validate a fresh reviewer session from login through consent and a reviewer-authored model-backed task. Do not reuse Dotta's task or assume Dotta's personal model default will resolve for another user. Use an eligible reviewer Google account or an agreed dedicated test account; Paperclip app-login credentials are not Google credentials. Make login/navigation usable without phone, payment, or unrelated authentication blockers, while retaining security for operator accounts. Send actual credentials only through the authorized review channel, never this handoff or public footage. Google's [in-app testing guidance](https://support.google.com/cloud/answer/13807382?hl=en) supports reviewer allowlisting or authorized local test credentials and the separate-project path.

### Audit data handling and provider eligibility alongside functional tests

The data path to review is: Google services → managed broker or direct OAuth → Core/tool transport → Runner/model provider → task, run, and artifact storage, with support, audit, and diagnostic projections considered separately. Identify actual recipients, access controls, retention, deletion, and subprocessors at each step.

The privacy/security owner should reconcile that inventory with user-facing disclosures, consent, privacy policy, model-provider terms and settings, deletion/help instructions, and token protection. Audit persistent task/run content rather than treating OAuth disconnection as data deletion. Confirm the user understands the agent behavior and sharing being authorized. General model training and unrelated secondary use must not be implied or permitted by an ordinary task prompt. Include prompt-injection defenses for untrusted Google content and document what they protect. The selector alone does not establish these controls. [Google Workspace data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) Require prominent in-product data-use disclosure immediately before affirmative consent, not a privacy-policy-only notice, and publish the required Limited Use compliance statement.

Restricted-scope security assessment is a separate release dependency. Google's guidance calls for assessment when restricted data is accessible through third-party servers. Given Paperclip's server/model path, assign a security owner to confirm applicability, the Google-designated assessor route, required assessment boundary and deliverables, or a documented exception. No project-specific CASA request, completed assessment, or exception is established here. Budget and schedule the work rather than interpreting no assessment email as exemption. [Restricted-scope verification and assessment](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) Where applicable, track the assessor's Letter of Assessment approval date and assign renewal ownership at least every 12 months.

**Check every MCP OAuth client's agentic classification now.** The [October 12 notice](https://chatgpt.com/space/page_bfa08d7ab3308191955df1bfa5c5bb42), reread November 15, says non-agentic clients lose Workspace MCP access from November 11 and the setting becomes permanent November 12. Those dates have passed. QA was observed agentic in October; current production and staging-client status is not established. If an affected client missed the cutoff, the notice directs a new agentic client rather than toggling the old one. Plan client/callback/secret migration, reauthorization, and review reconciliation deliberately; do not change global production credentials as a diagnostic experiment.

Also recheck current Workspace MCP availability, account/admin eligibility, and applicable preview terms before public launch. Historical preview enrollment is not public-production permission. Google's own reviewer applicability was an open clarification, not a proven extra reviewer-enrollment requirement. [MCP setup](https://developers.google.com/workspace/guides/configure-mcp-servers), [preview terms](https://developers.google.com/workspace/preview#developer_preview_program_terms)

### Record the actual submitted experience after prerequisites pass

Record a real browser session with readable browser chrome and the OAuth client ID, not a Storybook prototype, reconstructed consent screen, or fabricated address-bar overlay. Confirm capture and final playback first; earlier viewport encoding tests did not qualify browser-chrome recording. Cover every OAuth client and consent workflow included in the submission, or identify the QA substitute explicitly accepted for this case; do not assume one QA-client recording qualifies all clients.

The recording should follow this sequence:

1. Open the actual reviewer URL, show app identity, and use the supplied ordinary login/navigation.
2. Open Google Workspace, show the three service groups, and deliberately select the scope combination being demonstrated.
3. Complete the separate QA-client OAuth flow in English. Show the real client ID and app name, with all requested consent details expanded and readable.
4. Create an ordinary task that retrieves the controlled received email; show the actual tool result and complete body in Paperclip, then the exact same subject, sender, marker, and body in native Gmail.
5. Demonstrate the other submitted read/write features on synthetic fixtures, including source-account changes for write actions. The read-only and read/write flows cover different scope strings; map each submitted scope to a chapter rather than assuming one flow covers the union.
6. Explain the task-automation workflows and where data goes. Show the completed useful outcomes, then check the final video's privacy, readability, and independent playback access.

The existing synthetic fixture has marker `PAPERCLIP-QA-BODY-20261028` and subject “Paperclip Google Workspace QA — synthetic received email — 2026-10-28”. It was one authorized self-email, not authorization to expose other mail or send more messages. A new dedicated reviewer mailbox may need its own controlled fixture setup. Current Google guidance requires grant-flow and scope-function evidence; the case additionally requires the same complete received message in both apps. [Demo guidance](https://support.google.com/cloud/answer/13804565?hl=en)

### Send one coherent package and run the response loop

The submission owner should freeze one version of the following package before sending:

- Production verification project and relevant client IDs; separate QA project/client and actual reviewer URL/callback; current serving revision.
- Exact requested, declared, and approved scope sets, with feature justification, narrower-scope rationale, and demo timestamps. Explain Paperclip's selected-permission integration-platform model.
- Tested login and step-by-step navigation, required Google account eligibility and fixtures, model-backed task instructions, and secure access material delivered separately.
- Accessible replacement demo link, policy/help URLs, data-flow/security materials, and any assessment documentation actually required by the case.
- A finding-by-finding response to Google's latest email, plus evidence date, reviewer-access check, submission owner, and follow-up contact.

Reopen the production [Verification Center](https://console.cloud.google.com/auth/verification) first. Confirm whether the request remains pending, needs an update, or has closed. Reconcile the Console and the existing email thread; a requested separate QA project does not move the production approval case into that project. Replace obsolete videos/instructions explicitly, submit the required Console update once, and reply directly in the existing case with the complete corrections. Obtain action-time authority for the external submission; creating this handoff authorizes none.

Track each reviewer finding with its owner, due date, exact requested correction, test/evidence link, sent response, and resolution. Keep reviewer access, fixtures, deployment, model capacity, and video available during review. Monitor the designated developer/support inboxes and Console; report meaningful decisions or requests, not repetitive unchanged status. Branding approval is distinct from data-access approval. Avoid scope/audience churn and repeated premature resubmission; Google documents cancellation, inactivity, and frequent-request handling. [Review changes and cancellations](https://support.google.com/cloud/answer/16868008?hl=en)

## 4 Release only after approval and preserve a usable handoff

### Treat production rollout as its own controlled operation

Before production exposure, capture explicit data-access approval and its exact project/configuration/scope coverage, the applicable assessment outcome, and current MCP eligibility. Then qualify the production-bound client, broker/Core versions, callbacks, profiles, token handling, feature flags, and connection lifecycle. Approval for one configuration does not cover newly added scopes.

Historical Cloud deployment of the unified profile is not the remaining staging feature fix: Cloud PR 709 was already deployed to production October 10. The later selector/persistence feature was qualified on Test 02, not established as production-ready here. October 31 flags showed `workspace.all` enabled in staging but omitted from production. Recheck before acting; a merge alone does not enable it.

Keep `paperclipai/paperclip-cloud` harness deployment distinct from Core/tenant app delivery and a fleet rollout. The observed Cloud workflow required manual `workflow_dispatch` targeting production; master pushes deployed staging only. Use current supported release procedures, verify published source and serving health/revision, apply any approved configuration change intentionally, run an authorized bounded canary, and retain rollback steps. Do not initiate production/fleet rollout, change the pinned reviewer stack, or swap the global managed client merely because this handoff lists those future steps.

After launch, retain the approved scope/configuration snapshot, review correspondence and demo; staff owner/editor/support contacts; monitor auth, refresh, provider denial, quota and access failures with redacted diagnostics; maintain deletion and incident-response procedures; and schedule any required reassessment. Reevaluate verification when scopes, clients, branding, or material data use changes.

### Resume with dependencies instead of another open ended monitoring loop

| Order | Proposed owner | Work package and exit evidence |
| --- | --- | --- |
| 1 | Engineering and Google project owner | Refresh the case/Console, serving revision, client identity, and post-cutoff agentic status; capture a dated configuration baseline without secrets. |
| 2 | Dotta or designated operator | Resolve the reviewer destination and isolation approach. Complete provider-required human authentication; do not ask a human to perform ordinary engineering work. |
| 3 | Cloud operator and engineering | Qualify the separate QA client on the agreed environment, callback, effective grant, and fresh reviewer login/task/model path. |
| 4 | Engineering and security/privacy | Close functional/lifecycle/denial gaps and any actual disclosure, data-handling or permission-administration defects; save source and live proof separately. |
| 5 | Security owner and submission owner | Resolve assessment and provider-eligibility obligations; reconcile exact scopes, policies, claims and review materials. Start long-lead assessment work in parallel where possible. |
| 6 | QA and submission owner | Record, privacy-review, and independently play the real demo; finish the package, send the authorized correction once, and operate reviewer follow-up. |
| 7 | Release operator | Confirm explicit approval and production prerequisites, then execute the separately authorized rollout and ongoing compliance operation. |

The original completion goal was marked blocked after repeated access prerequisites, not completed. This handoff does not resume automated deployment or monitoring. The five-minute deployment monitor was canceled; the separate daily OAuth monitor was left unchanged at the last checkpoint. Verify its current scheduler state before relying on it; the handoff itself schedules nothing.

Do not rerun broad source builds merely to recover context. For a new code repair, reproduce narrowly, fix the owning layer, run the applicable repository checks and PR workflow, and verify the exact deployed target. Preserve old failures and incomplete evidence. Do not create more manifests or plans as a substitute for an actual blocked acceptance step.

### Use the existing evidence library without importing its stale conclusions

The account-specific evidence root is recorded in the private operator handoff. The filenames below refer to that private evidence library, not files bundled in this public repository.

Start with these files, in order:

1. `postmerge-delivery-status-2026-10-31.json` and `feature-acceptance-2026-10-31.json`: integrated delivery state, verified behavior, and explicit acceptance gaps.
2. `reviewer-scope-matrix-2026-10-31.json`: exact source-derived scope sets and action rules. Apply this handoff's Gmail scope-authority correction when interpreting its draft-only wording.
3. `unselected-service-probe-6rShr5/result.json`: native principal receipt, zero negative calls, and missing-editor limitation.
4. `reviewer-submission-draft-2026-10-31.json`: newest scope/probe caveats; still explicitly not ready to submit.
5. `submission/README.md`: entry to older environment readiness, scope matrix, storyboard, checklist, and unsent reply draft. Reconcile against the newer JSON and this handoff; do not send it unchanged.

The [private operator handoff](https://chatgpt.com/space/page_bfa08d7ab3308191955df1bfa5c5bb42) links the historical Gmail retrieval task SOC-9 and stopped permission probe SOC-10, and identifies their company and Gmail-only connection. Those identifiers do not grant permission to modify the fixture.

Never access, copy, or publish the quarantined unrelated-mail frame. Keep passwords, API keys, client secrets, review login codes, OAuth state/auth codes/tokens, and private mailbox content out of the handoff, evidence bundle and video. A private document link does not upload the local evidence library or grant a successor access to it; transfer only the approved safe artifacts through the appropriate task/artifact system when handing off execution.

**Completion is checkable:** the agreed feature and lifecycle pass on the actual reviewer environment; all submitted permissions have real function and boundary evidence; reviewers can independently use isolated access; security/provider requirements are satisfied; the final video and complete response are accessible; Google explicitly approves data access; and the production integration is then released and verified under that approved configuration. Until then, report the exact remaining gate rather than calling the feature approved or production-ready.
