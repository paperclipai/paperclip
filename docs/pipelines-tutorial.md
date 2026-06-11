# Pipelines Tutorial: Release to Content

This walkthrough uses only the Paperclip CLI to run the release-to-content casework flow:

- one release case fans out into 10 content suggestion cases
- a review inbox approves 7, rejects 2 with reasons, and edits then approves 1
- approved cases fire a drafting routine on stage entry
- a human accepts an agent transition suggestion
- a blocker prevents premature publishing until the upstream case is done
- the release rollup reports a complete done/cancelled split
- event history shows provenance for the case

## Prerequisites

Run this against a dev Paperclip instance with a board token or an agent token that can manage pipelines and routines.

```sh
export PAPERCLIP_API_URL=http://localhost:3100
export PAPERCLIP_COMPANY_ID=<company-id>
export PAPERCLIP_API_KEY=<token>

# Optional: assign the drafting routine to an existing agent.
export DRAFTING_AGENT_ID=<agent-id>
```

Use a unique suffix so the tutorial can be rerun without pipeline key collisions:

```sh
export RUN_KEY="$(date +%Y%m%d%H%M%S)"
export RELEASES_PIPELINE="releases-$RUN_KEY"
export CONTENT_PIPELINE="content-$RUN_KEY"
```

## Create The Drafting Routine

```sh
cat > /tmp/drafting-routine.json <<JSON
{
  "title": "Draft approved content",
  "description": "Use the embedded Pipeline Case Context to draft the approved content case, then transition the case when the draft is ready.",
  "priority": "medium",
  "status": "active",
  "concurrencyPolicy": "always_enqueue",
  "catchUpPolicy": "skip_missed"
  ${DRAFTING_AGENT_ID:+, "assigneeAgentId": "$DRAFTING_AGENT_ID"}
}
JSON

export DRAFTING_ROUTINE_PAYLOAD="$(jq -c . /tmp/drafting-routine.json)"
export DRAFTING_ROUTINE_ID="$(
  paperclipai routine create \
    -C "$PAPERCLIP_COMPANY_ID" \
    --payload-json "$DRAFTING_ROUTINE_PAYLOAD" \
    --json | jq -r '.id'
)"
```

## Create Pipelines

```sh
cat > /tmp/releases-stages.json <<'JSON'
[
  { "key": "released", "name": "Released", "kind": "open", "position": 100 },
  { "key": "complete", "name": "Complete", "kind": "done", "position": 900 },
  { "key": "cancelled", "name": "Cancelled", "kind": "cancelled", "position": 1000 }
]
JSON

paperclipai pipelines create \
  -C "$PAPERCLIP_COMPANY_ID" \
  --key "$RELEASES_PIPELINE" \
  --name "Releases $RUN_KEY" \
  --stages-file /tmp/releases-stages.json
```

```sh
cat > /tmp/content-stages.json <<'JSON'
[
  {
    "key": "review",
    "name": "Human review",
    "kind": "review",
    "position": 100,
    "config": {
      "approveToStageKey": "drafting",
      "rejectToStageKey": "cancelled",
      "requireRejectReason": true,
      "reviewerKind": "human"
    }
  },
  { "key": "drafting", "name": "Drafting", "kind": "working", "position": 200 },
  { "key": "ready", "name": "Ready to publish", "kind": "working", "position": 300 },
  { "key": "published", "name": "Published", "kind": "done", "position": 900 },
  { "key": "cancelled", "name": "Cancelled", "kind": "cancelled", "position": 1000 }
]
JSON

paperclipai pipelines create \
  -C "$PAPERCLIP_COMPANY_ID" \
  --key "$CONTENT_PIPELINE" \
  --name "Content $RUN_KEY" \
  --stages-file /tmp/content-stages.json
```

Configure transitions, guidance, and the drafting automation:

```sh
cat > /tmp/content-transitions.json <<'JSON'
{
  "transitions": [
    { "fromStageKey": "review", "toStageKey": "drafting", "label": "approve" },
    { "fromStageKey": "review", "toStageKey": "cancelled", "label": "reject" },
    { "fromStageKey": "drafting", "toStageKey": "ready", "label": "draft ready" },
    { "fromStageKey": "drafting", "toStageKey": "published", "label": "publish directly" },
    { "fromStageKey": "drafting", "toStageKey": "cancelled", "label": "cancel" },
    { "fromStageKey": "ready", "toStageKey": "published", "label": "publish" }
  ]
}
JSON

paperclipai pipelines set-transitions \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CONTENT_PIPELINE" \
  --file /tmp/content-transitions.json

cat > /tmp/content-guidance.md <<'MD'
# Content pipeline guidance

Approve content suggestions that can teach users what changed and reject suggestions
that are too narrow, duplicative, or disconnected from the release.
MD

paperclipai pipelines guidance put \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CONTENT_PIPELINE" \
  --file /tmp/content-guidance.md

paperclipai pipelines set-automation \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CONTENT_PIPELINE" \
  --stage drafting \
  --routine "$DRAFTING_ROUTINE_ID"
```

## Ingest The Release And Suggestions

```sh
export RELEASE_CASE_ID="$(
  paperclipai pipelines ingest \
    -C "$PAPERCLIP_COMPANY_ID" \
    "$RELEASES_PIPELINE" \
    --case-key "release-$RUN_KEY" \
    --title "Release $RUN_KEY: Pipeline primitive" \
    --summary "A release case that fans out into content suggestions." \
    --fields-json '{"release":"v0.pipeline-tutorial"}' \
    --json | jq -r '.case.id'
)"
```

Create the 10 parented suggestion cases. This batch file is included verbatim; only `$RELEASE_CASE_ID` is substituted by the shell.

```sh
jq -n --arg parent "$RELEASE_CASE_ID" '{
  items: [
    { caseKey: "suggestion-01", title: "Launch blog post", summary: "Explain the release end to end.", fields: { channel: "blog" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-02", title: "Product changelog", summary: "Concise changelog entry.", fields: { channel: "docs" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-03", title: "Launch tweet", summary: "Short tweet after the blog is ready.", fields: { channel: "x" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-04", title: "Customer email", summary: "Email announcement.", fields: { channel: "email" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-05", title: "LinkedIn post", summary: "Professional network announcement.", fields: { channel: "linkedin" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-06", title: "Discord update", summary: "Community update.", fields: { channel: "discord" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-07", title: "Release notes", summary: "Detailed release notes.", fields: { channel: "release_notes" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-08", title: "Overly niche post", summary: "Reject: too niche.", fields: { channel: "blog" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-09", title: "Duplicate tweet", summary: "Reject: duplicate.", fields: { channel: "x" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-10", title: "Short-form video", summary: "Needs edit before approval.", fields: { channel: "video" }, parentCaseId: $parent, stageKey: "review" }
  ]
}' > /tmp/content-suggestions.json

paperclipai pipelines ingest-batch \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CONTENT_PIPELINE" \
  --file /tmp/content-suggestions.json \
  --json | tee /tmp/content-suggestions-result.json
```

## Review The Inbox

```sh
paperclipai pipelines review-inbox \
  -C "$PAPERCLIP_COMPANY_ID" \
  --pipeline "$CONTENT_PIPELINE"
```

Approve seven and reject two in bulk:

```sh
case_id() {
  jq -r --arg key "$1" '.[] | select(.case.caseKey == $key) | .case.id' /tmp/content-suggestions-result.json
}

export CASE_01="$(case_id suggestion-01)"
export CASE_02="$(case_id suggestion-02)"
export CASE_03="$(case_id suggestion-03)"
export CASE_04="$(case_id suggestion-04)"
export CASE_05="$(case_id suggestion-05)"
export CASE_06="$(case_id suggestion-06)"
export CASE_07="$(case_id suggestion-07)"
export CASE_08="$(case_id suggestion-08)"
export CASE_09="$(case_id suggestion-09)"
export CASE_10="$(case_id suggestion-10)"

jq -n \
  --arg c1 "$CASE_01" --arg c2 "$CASE_02" --arg c3 "$CASE_03" --arg c4 "$CASE_04" --arg c5 "$CASE_05" \
  --arg c6 "$CASE_06" --arg c7 "$CASE_07" --arg c8 "$CASE_08" --arg c9 "$CASE_09" '{
  items: [
    { caseId: $c1, decision: "approve", expectedVersion: 1 },
    { caseId: $c2, decision: "approve", expectedVersion: 1 },
    { caseId: $c3, decision: "approve", expectedVersion: 1 },
    { caseId: $c4, decision: "approve", expectedVersion: 1 },
    { caseId: $c5, decision: "approve", expectedVersion: 1 },
    { caseId: $c6, decision: "approve", expectedVersion: 1 },
    { caseId: $c7, decision: "approve", expectedVersion: 1 },
    { caseId: $c8, decision: "reject", reason: "Too niche for this launch.", expectedVersion: 1 },
    { caseId: $c9, decision: "reject", reason: "Duplicates the launch tweet.", expectedVersion: 1 }
  ]
}' > /tmp/review-decisions.json

paperclipai pipelines review-bulk \
  -C "$PAPERCLIP_COMPANY_ID" \
  --file /tmp/review-decisions.json
```

Edit and approve the tenth item:

```sh
paperclipai pipelines case review \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CASE_10" \
  --approve \
  --expected-version 1 \
  --title "Edited short-form video" \
  --fields-json '{"channel":"video","edited":true}'
```

Approved cases enter `drafting`, which fires the configured routine and links automation issues. Inspect one:

```sh
paperclipai pipelines case get \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CASE_01"
```

## Accept An Agent Suggestion

```sh
export SUGGESTION_ID="$(
  paperclipai pipelines case suggest \
    -C "$PAPERCLIP_COMPANY_ID" \
    "$CASE_01" \
    --to ready \
    --rationale "Draft is complete enough to publish." \
    --confidence 0.9 \
    --json | jq -r '.suggestion.id'
)"

paperclipai pipelines case resolve-suggestion \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CASE_01" \
  --suggestion "$SUGGESTION_ID" \
  --accept \
  --expected-version 2

paperclipai pipelines case transition \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CASE_01" \
  --to published \
  --expected-version 3 \
  --reason "Suggestion accepted and content published."
```

## Demonstrate Blockers And The 409 Guard

The tweet waits for the blog post:

```sh
paperclipai pipelines case block \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CASE_03" \
  --by "$CASE_02"

# This fails with code=blocked and prints a recovery hint.
paperclipai pipelines case transition \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CASE_03" \
  --to published \
  --expected-version 2 \
  --reason "Try before blog is published."
```

Resolve the blocker and publish the tweet:

```sh
paperclipai pipelines case transition \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CASE_02" \
  --to published \
  --expected-version 2 \
  --reason "Blog published; unblocks tweet."

paperclipai pipelines case transition \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CASE_03" \
  --to published \
  --expected-version 2 \
  --reason "Blocker resolved."
```

## Complete The Rollup

Cancel one approved case, publish the rest, then inspect the release rollup:

```sh
paperclipai pipelines case transition -C "$PAPERCLIP_COMPANY_ID" "$CASE_04" --to cancelled --expected-version 2 --reason "Cancelled after review."
paperclipai pipelines case transition -C "$PAPERCLIP_COMPANY_ID" "$CASE_05" --to published --expected-version 2 --reason "Published."
paperclipai pipelines case transition -C "$PAPERCLIP_COMPANY_ID" "$CASE_06" --to published --expected-version 2 --reason "Published."
paperclipai pipelines case transition -C "$PAPERCLIP_COMPANY_ID" "$CASE_07" --to published --expected-version 2 --reason "Published."
paperclipai pipelines case transition -C "$PAPERCLIP_COMPANY_ID" "$CASE_10" --to published --expected-version 3 --reason "Edited and published."

paperclipai pipelines case rollup \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$RELEASE_CASE_ID" \
  --json
```

Expected rollup:

```json
{
  "total": 10,
  "done": 7,
  "cancelled": 3,
  "open": 0,
  "complete": true
}
```

## Dump Provenance

```sh
paperclipai pipelines case events \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CASE_01" \
  --json
```

Every event includes an actor field. Human actions record a user actor, agent actions require a run id, and system actions record `system`. For this case, look for `ingested`, `review_decided`, `transition_suggested`, `suggestion_resolved`, and `transitioned`.

## Scripted Smoke

The same flow is available as a smoke script:

```sh
PAPERCLIP_API_URL=http://localhost:3100 \
PAPERCLIP_COMPANY_ID=<company-id> \
PAPERCLIP_API_KEY=<token> \
pnpm smoke:pipelines-tutorial
```

The smoke assigns the drafting routine to `DRAFTING_AGENT_ID` when set. If it is not set, it uses `PAPERCLIP_AGENT_ID` when present, otherwise the first non-terminated company agent returned by the CLI, so the routine automation can create linked drafting issues.
