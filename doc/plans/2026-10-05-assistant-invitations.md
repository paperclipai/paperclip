# Invite an assistant to Paperclip with one message

Date: 2026-10-05

## Outcome

From Butter → Connections → Assistant Connection (MCP), copy a message or URL,
paste it into an assistant, approve the identified client in Paperclip, and use
the organization's tools as the consenting human. Sharing an invitation grants
no access. Keep the existing experimental setting and simplified consent UI.

## Delivery

1. Shared, version-aware setup instructions, public HTML/Markdown setup page,
   invitation metadata, primary Copy invitation / secondary Copy link actions,
   and manual setup disclosure. Organization hints never confer authority.
2. Browser OAuth: CIMD alongside DCR, guarded bounded metadata retrieval,
   issuer identification, accurate resource scopes, existing PKCE and opaque
   revocable tokens.
3. Device OAuth: separate hashed pending codes, ten-minute expiry, five-second
   polling, shared throttling, atomic redemption, existing consent/grants/audit.
   Add CLI device login and a credential-protecting stdio bridge with serialized
   refresh and exact resource binding. No client-credentials or agent identity.
4. Tenant Cloud routing for setup/device endpoints, preserving host and identity
   boundaries. The central broker retains its existing advertised grants.
5. Stories, protocol/security tests, cold-start paid Product E2E cases (Mini,
   Haiku, then Sonnet), actual client checks, required repository checks, PRs,
   Butter deployment, and a real screenshot walkthrough including OpenCode.

## Acceptance

- Cold start: no Paperclip tools/configuration initially; the invitation starts
  setup and consent; verify the resulting account/company before work.
- Existing configuration, unavailable host setup, denied/expired consent,
  later-conversation reconnect, and required client restart are represented.
- Verify company/role isolation, disabled feature, CIMD SSRF and redirect
  rejection, audience binding, code replay, concurrent polling and refresh,
  token expiry/revocation, and absence of secrets from copied text and evidence.
- Browser connectors use host settings where required; do not promise automatic
  installation from chat. Device support uses a compatible client/CLI bridge.
- Retain eval failures, costs, model IDs, revisions, and independent state
  assertions. Verify real clients separately from model API evals.

## Progress

- Implementation started from PR #14933's isolated worktree at 07f638c1b.
- Existing browser OAuth, scoped grants, canonical endpoint, and Connections
  entry point are present. No new invitation authority or agent identity needed.
- Implemented invitation-first setup, public HTML/Markdown instructions, CIMD,
  issuer responses, device authorization/consent, protected CLI credentials and
  the stdio bridge. Added production-component Storybook device states.
- Added five cold-start cases to the explicit Product E2E public-mcp suite,
  including independent grant/configuration checks and calibrated negative cases.
- Typecheck, production build and UI token gates passed. Focused authentication,
  metadata and invitation UI checks: 65 passed. CLI credential checks: 7 passed.
  Eval catalog/model/grader checks: 118 passed. Full-suite verification is in
  progress; a large-file Git streaming test timed out outside this change.
- Mini passed all five invitation cases. Haiku and Sonnet qualification remains
  in progress; retain failed infrastructure attempts and paid billing evidence.
- Cloud routing PR: https://github.com/paperclipai/paperclip-cloud/pull/672.
  Cloud typecheck, 2,242 tests and fake-provider smoke passed; rebased focused
  gateway checks passed 218 tests. Staging routing deployment has been requested.
- Remaining: real client qualification, final paid results, PR checks/review,
  Butter application deployment and the complete screenshot gallery. Butter's
  persistent human grant has not been approved; do not claim a live Butter MCP
  read or delegation before that consent occurs.

### Review and real-client findings (October 5)

- Actual Codex 0.153.4 CIMD login exposed its native ephemeral loopback callback requirement. Added RFC 8252 port-only matching for verified native metadata; host/path/query remain exact and token redemption binds the exact authorized callback.
- Applied source quotas and stale-client cleanup to CIMD registration in the same transaction as admitted requests. Rejected authorization requests do not retain clients.
- Replaced PID-file refresh locks with crash-released SQLite OS locks; replacement credentials are saved before the previous grant is revoked. A failed cleanup is reported without discarding the working replacement.
- Added device-code correction without leaving the consent flow.
- Initial paid invitation matrix: 15/15 passes across Mini, Haiku, and Sonnet; one earlier database startup failure remains recorded. Final source-pinned qualification follows review fixes. Actual OpenCode reused the existing disposable organization's grant and retrieved its saved report in a new conversation.

### Qualification and staging evidence

- Commit `633a4a2a2` passed every GitHub CI gate and received a 5/5 review.
  Cloud `06c283a0` likewise passed its checks/review and was deployed to staging.
- Source-pinned campaign `local-2026-10-06T02-15-50-324Z`: 14/15 passed.
  All Haiku and Sonnet cases passed. Mini’s unsupported-host response correctly
  refused setup; the text checker rejected its curly apostrophe. Preserve the
  failed attempt, normalize presentation punctuation, and run fresh qualification.
- A real Claude web connector discovered Butter and selected CIMD. Its metadata
  also advertises JWT-bearer; the previous strict enum rejected the entire
  document. Select only implemented grants and prove unsupported token grants
  remain rejected. Codex 0.153.4 and Claude Code 2.1.245 already reached local
  consent through CIMD. Their new grants await human approval.
- Butter serves public setup Markdown without cookies and returns protocol
  validation (not a tenant-session error) for anonymous device initiation.
  Existing local OpenCode retrieved a stored report in a later conversation.
  The new Butter OpenCode 1.18.17 session starts with no MCP configuration.
- Clipboard transfer is verified: making the embedded browser visible resolved
  its background clipboard mismatch. The exact copied invitation was pasted into
  the fresh OpenCode conversation. Added an explicit clipboard-fixture Storybook
  interaction; the real browser proof remains separate.
- Final narrow checks: 63 authentication/metadata tests and 120 eval calibration
  tests passed; server/UI/eval typechecks and token gates passed.
- Local full-suite limitations remain recorded: the large Git streaming test
  times out on this Mac; parallel CLI/route runs hit database hook timeouts.
  The earlier long run also loaded old modules during ongoing source edits;
  all 62 affected MCP checks passed in a fresh process. CI passed these groups.
- Live Butter delegation/result retrieval and newly authorized Codex, Claude
  Code, device CLI and browser-connector calls remain unverified until consent.
  The screenshots distinguish those boundaries from local reuse and fixtures.

### Final matrix and live authorization handoff

- Source-pinned campaign `local-2026-10-06T02-41-14-462Z` at `2992ef271`
  passed 15/15: five cases each on GPT-5.4 Mini, Claude Haiku and Sonnet.
  All CI gates and the 5/5 review passed on that source.
- The actual Butter OpenCode cold start configured MCP and reached consent.
  Its assistant shell then timed out before approval; a detached retry remained
  subject to the client's own callback deadline. Added shared setup guidance
  for immediate URL handoff, persistent authorization commands, expired-link
  recovery and a manual-terminal fallback. Rerun cold start on all three models
  for this instruction change; retain the preceding matrix as separate evidence.
- The screenshot gallery starts at Butter's dashboard and records configuration,
  pending consent and this timeout finding. New persistent grants still await
  human confirmation; do not describe the real Butter journey as complete.

- Follow-up campaign `local-2026-10-06T02-58-30-041Z` at `cda8178af`
  passed 3/3 cold starts. Review then found HTML lacked the new Markdown advice.
  A shared constant now feeds Markdown, public HTML and manual setup. Verified
  the generated Markdown remains byte-identical to the paid-evaluated version
  with and without an organization hint. Shared build, server/UI typechecks,
  token gates and 63 auth/metadata checks pass after this presentation fix.
- Butter deployment of `2992ef271` succeeded. Actual Claude web CIMD now reaches
  consent and shows Claude's identifying domain. Its grant still awaits consent.
  Anonymous setup returns no organization name; account setup and MCP tool
  initialization reject unauthenticated requests with 401.
