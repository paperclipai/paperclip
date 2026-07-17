# AI Factory policy contract

The effective order is:

1. Non-bypassable server invariants.
2. Explicit issue execution contract.
3. Company AI Factory policy.
4. Agent and domain skills.

Company policy may choose role selectors, permitted direct-lane parallelism, production authority, and bounded recovery timing. In policy version 1 the canonical lifecycle anchors and their order are fixed so every evidence gate has an earlier producer; one typed request creates one default lane. It cannot permit grandchildren, generated prose as control state, mutation during an explicit hold, mutable evidence history, or repeated recovery for unchanged evidence.

The editable overlay lives at `company/{companyId}/ai-factory-policy` and extends the immutable `paperclipai/paperclip/paperclip-ai-factory` base. Paperclip snapshots the selected policy key, version, and content hash when execution starts.

Stage types:

- `work`: produce or revise the candidate.
- `verification`: test independently against the contract.
- `review`: make a technical judgment from evidence.
- `deployment`: execute and verify an authorized release operation.
- `approval`: record an authority decision; do not fabricate it.

`optionalWhen: production` means include the stage only when the execution contract requires production delivery. `optionalWhen: non_production` means include it only for work that stops before production.

Role values are selectors matched against active company agents. Version 1 requires this ordered lifecycle: `contract`, `implementation`, independent `independent_qa`, `technical_acceptance`, production-only `deployment`, independent production-only `live_qa`, and production-only `final_acceptance`. Custom stages may be added without reordering or changing those anchors.

The server-owned gates are part of that lifecycle: implementation requires candidate-bound implementation evidence plus provider-verified CI from the project's configured GitHub workflow. That CI identity is board-pinned to the repository, workflow ID, top-level workflow path and Git blob SHA, and an exact `push` or `pull_request` event; dispatch/call events are not accepted. The top-level blob attestation is not transitive to local reusable workflows, composite actions, scripts, or tests, so those dependencies require protected external workflow/ruleset controls until separately attested. Technical acceptance requires Paperclip's typed accepted decision; deployment requires provider-verified production evidence; live QA requires that exact deployment plus smoke evidence; and final acceptance requires Paperclip's typed business-acceptance decision bound to the exact verified production target.

If `requireBoardApprovalForIrreversibleActions` is true, entering `deployment` requires an accepted `request_confirmation` resolved by a board user. Its custom target key must be `ai-factory-production-deployment`, its `revisionId` must equal the canonical candidate SHA, and its capability preflight reason must be `irreversible_action` or `policy_approval`.
