# Expand Paperclip’s assistant MCP tools

## Outcome
Outside assistants manage work and configuration as the connected person through the existing experimental MCP endpoint. Human attribution, company isolation, revocation, approval gates, native execution ownership and scheduling remain authoritative.

## Implementation plan
- Add task update, finish and block tools; document writes and revisions; attachment upload/download links; deliverable registration/update; agent configuration and instructions; project creation/update/repositories; skill metadata/files; and explicitly registered API search/call.
- Reuse domain routes and validation. Reject task transitions that bypass execution review. Documents and instruction/skill files use revision checks. Binary replacement creates a new attachment and updates the deliverable reference.
- Keep paperclip:configure for agent/project/skill configuration internally. Per the subsequent user revision, one write-access checkbox approves both requested mutation scopes (checked by default for eligible roles). Existing grants do not gain authority. Exclude credentials, arbitrary commands, permission policies, agent creation, public skill sharing, approval decisions and runner lifecycle operations.
- Extend internal dispatch to PATCH/PUT, empty responses and sanitized errors. Share retry identity between named tools and generic API calls; report uncertain outcomes. API registry is default-deny, company-bound, with explicit fields and scopes; no arbitrary destination, credentials or actor overrides.
- Keep the central directory broker restricted to its existing ten tools on both discovery and invocation; expanded tools and generic API access are for direct connections.
- paperclip_get_upload_url creates a ten-minute file-specific transfer. Sending bytes saves the attachment and returns its ID automatically; there is no completion call. Retries recover the same attachment, conflicting bytes fail. paperclip_get_download_url returns a ten-minute URL for one authorized attachment.
- Hash transfer credentials, exclude them from logs and persistent mutation results, recheck live authority, enforce file ownership/content constraints and existing deployment size limits (10 MB default), and safely clean abandoned storage. No arbitrary remote source URLs or server-local paths.
- Narrow Cloud tenant transfer routing preserves host validation, header stripping and standby protection. Ordinary REST endpoints do not accept MCP tokens.

## Verification and delivery
- Fresh core and Cloud worktrees. Preserve the existing experimental setting.
- Cover company/role/scope restrictions, configure consent, feature off, revocation/expiry, human audit, idempotency and named/generic parity.
- Cover dependency cycles, reassignment, finish/block, native contention and approval bypass rejection; document/instruction/skill revision conflicts.
- Binary hash round trips, automatic creation, lost responses, duplicate/conflicting/partial/oversized uploads, expired/revoked/cross-company links.
- Preserve runner/OAuth/broker/Cloud regressions. Extend existing public-mcp paid Product E2E workflows for each new capability, failures and later-conversation retrieval. Start GPT-5.4 Mini and Claude Haiku, then Sonnet; retain failures, costs, fingerprints and independent durable assertions.
- Verify real OpenCode, Codex and Claude Code separately; Storybook configuration consent; local test drive and Butter staging walkthrough.
- Full repository checks, token gates, documentation, evidence and green reviewed PRs. Merging is a separate action.

## Execution record
- Core: codex/expanded-assistant-mcp in the managed expanded-assistant-mcp worktree.
- Cloud: codex/expanded-assistant-mcp in /private/tmp/paperclip-cloud-expanded-mcp.
- Core PR: https://github.com/paperclipai/paperclip/pull/15380; Cloud PR: https://github.com/paperclipai/paperclip-cloud/pull/678. Neither is merged by this task.
- Implementation includes 37 direct tools, configuration consent, durable transfer tickets, Cloud routing and the ten-tool directory boundary.
- Paid qualification: all eight expanded cases passed on Mini, Haiku and Sonnet (24/24). Source and suite fingerprints, failures, costs and limitations are preserved in the [verification record](2026-10-06-expanded-assistant-mcp-verification.md).
- Actual local Codex, Claude Code and OpenCode clients completed reads and mutations; OpenCode's file round trip matched by SHA-256. Configuration consent has interactive Storybook coverage.
- Review fixes cover pending native retries, model-specific reasoning configuration and legacy instruction revision safety. Butter staging and final CI are separate delivery gates tracked in the PR verification sections.

## Consent revision
- User requested one checkbox: **Write all of your Paperclip data**. It controls requested work and configuration scopes together in browser and device consent; there is no separate configuration checkbox. Viewer restrictions and already-issued grant scopes remain unchanged.
