# Pipelines Tutorial: Release to Published Content

This walkthrough is the CLI/API version of the 12-step release-to-content worked example. It uses three linked pipelines:

- `release-coverage`: one release case answers "is this release covered?"
- `feature-content`: one feature case per approved feature rolls up content coverage.
- `content-production`: one content-piece case moves through drafting, assets, assembly, final review, publishing, and a terminal result.

The walkthrough intentionally labels conventions separately from primitives. Those conventions are future primitive candidates: if they hurt, we want to see exactly where.

## Prerequisites

Run this against a dev Paperclip instance with a board token or an agent token that can manage pipelines, routines, and issues.

```sh
export PAPERCLIP_API_URL=http://localhost:3100
export PAPERCLIP_COMPANY_ID=<company-id>
export PAPERCLIP_API_KEY=<token>

# Optional: assign routine-created drafting issues to a specific agent.
export DRAFTING_AGENT_ID=<agent-id>

export RUN_KEY="$(date +%Y%m%d%H%M%S)"
export RELEASE_PIPELINE="release-coverage-$RUN_KEY"
export FEATURE_PIPELINE="feature-content-$RUN_KEY"
export CONTENT_PIPELINE="content-production-$RUN_KEY"
```

## Step 1: Setup The Three Pipelines

Create Release Coverage. It is thin on purpose: the release case stays in `intake` until its feature children are terminal, then `autoAdvanceOnChildrenTerminal` moves it to `covered`.

```sh
cat > /tmp/release-stages.json <<'JSON'
[
  {
    "key": "intake",
    "name": "Intake",
    "kind": "open",
    "position": 100,
    "config": { "autoAdvanceOnChildrenTerminal": "covered" }
  },
  { "key": "covered", "name": "Covered", "kind": "done", "position": 900 },
  { "key": "cancelled", "name": "Cancelled", "kind": "cancelled", "position": 1000 }
]
JSON

paperclipai pipelines create \
  -C "$PAPERCLIP_COMPANY_ID" \
  --key "$RELEASE_PIPELINE" \
  --name "Release Coverage $RUN_KEY" \
  --stages-file /tmp/release-stages.json
```

Create Feature Content. The review stage lets the human approve features into production or drop them from this release.

```sh
cat > /tmp/feature-stages.json <<'JSON'
[
  { "key": "suggesting", "name": "Suggesting", "kind": "open", "position": 100 },
  {
    "key": "suggestion_review",
    "name": "Suggestion Review",
    "kind": "review",
    "position": 200,
    "config": {
      "approveToStageKey": "producing",
      "rejectToStageKey": "cancelled",
      "requestChangesToStageKey": "suggesting",
      "requireRejectReason": true,
      "reviewerKind": "human"
    }
  },
  {
    "key": "producing",
    "name": "Producing",
    "kind": "working",
    "position": 300,
    "config": { "autoAdvanceOnChildrenTerminal": "covered" }
  },
  { "key": "covered", "name": "Covered", "kind": "done", "position": 900 },
  { "key": "cancelled", "name": "Cancelled", "kind": "cancelled", "position": 1000 }
]
JSON

paperclipai pipelines create \
  -C "$PAPERCLIP_COMPANY_ID" \
  --key "$FEATURE_PIPELINE" \
  --name "Feature Content $RUN_KEY" \
  --stages-file /tmp/feature-stages.json
```

Create Content Production. `Assets` and `Assembly` are `working` stages, not review stages. `Final Review` is the review stage and has all three exits: approve, request changes, and drop.

```sh
cat > /tmp/content-stages.json <<'JSON'
[
  {
    "key": "drafting",
    "name": "Drafting",
    "kind": "working",
    "position": 100,
    "config": { "autonomy": "suggest" }
  },
  {
    "key": "assets",
    "name": "Assets",
    "kind": "working",
    "position": 200
  },
  {
    "key": "assembly",
    "name": "Assembly",
    "kind": "working",
    "position": 300,
    "config": { "autoAdvanceOnChildrenTerminal": "final_review" }
  },
  {
    "key": "final_review",
    "name": "Final Review",
    "kind": "review",
    "position": 400,
    "config": {
      "approveToStageKey": "publishing",
      "rejectToStageKey": "dropped",
      "requestChangesToStageKey": "drafting",
      "requireRejectReason": true,
      "reviewerKind": "human"
    }
  },
  { "key": "publishing", "name": "Publishing", "kind": "working", "position": 500 },
  { "key": "published", "name": "Published", "kind": "done", "position": 900 },
  { "key": "dropped", "name": "Dropped", "kind": "cancelled", "position": 1000 }
]
JSON

paperclipai pipelines create \
  -C "$PAPERCLIP_COMPANY_ID" \
  --key "$CONTENT_PIPELINE" \
  --name "Content Production $RUN_KEY" \
  --stages-file /tmp/content-stages.json
```

Show `enforceTransitions` on one pipeline. The release case can only auto-cover or cancel.

```sh
cat > /tmp/release-transitions.json <<'JSON'
{
  "enforceTransitions": true,
  "transitions": [
    { "fromStageKey": "intake", "toStageKey": "covered", "label": "all features terminal" },
    { "fromStageKey": "intake", "toStageKey": "cancelled", "label": "cancel release coverage" }
  ]
}
JSON

paperclipai pipelines set-transitions \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$RELEASE_PIPELINE" \
  --file /tmp/release-transitions.json
```

Add guidance and a drafting routine. The guidance document carries the rubric.

```sh
cat > /tmp/content-guidance.md <<'MD'
# Content Production guidance

Final Review has three exits:

- approve to Publishing when the pinned revisions are ready to ship
- request changes back to Drafting when the same work issue should continue
- drop to Dropped when the content should not ship

Convention: asset cases store `briefedFromVersion` in `fields` so assembly review can compare a pinned brief against the current upstream case `version`.
MD

paperclipai pipelines guidance put \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CONTENT_PIPELINE" \
  --file /tmp/content-guidance.md
```

```sh
cat > /tmp/drafting-routine.json <<JSON
{
  "title": "Draft content production case",
  "description": "Template convention: draft the content case from the Pipeline Case Context, keep typed work references in case fields, and suggest Drafting -> Assets when ready.",
  "priority": "medium",
  "status": "active",
  "concurrencyPolicy": "always_enqueue",
  "catchUpPolicy": "skip_missed"
  ${DRAFTING_AGENT_ID:+, "assigneeAgentId": "$DRAFTING_AGENT_ID"}
}
JSON

export DRAFTING_ROUTINE_ID="$(
  paperclipai routine create \
    -C "$PAPERCLIP_COMPANY_ID" \
    --payload-json "$(jq -c . /tmp/drafting-routine.json)" \
    --pipeline "$CONTENT_PIPELINE" \
    --json | jq -r '.id'
)"

paperclipai pipelines set-automation \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CONTENT_PIPELINE" \
  --stage drafting \
  --routine "$DRAFTING_ROUTINE_ID" \
  --note "Template-versioned with the routine prompt."
```

Routines marked with `--pipeline` are treated as pipeline automation helpers. They are still configurable from `/routines`, but the default routines view groups them under "Pipeline automation" so they do not crowd out hand-managed recurring work during setup.

**Convention:** v1 "templates" version with the routine prompt plus the batch file below, not with the pipeline. The pipeline `guidance` document carries the durable rubric. This is the accepted divergence from the long-term template-on-pipeline shape.

## Step 2: Trigger, Intake, And Gate

A real system would start with a release-cut routine. Today, the routine fires on a timer or API trigger and creates an intake issue. On that issue, the agent writes a proposal document and asks the board for a checkbox confirmation.

The accepted checkbox selection is represented here by the batch files. That batch file plus the routine prompt is the v1 template convention.

Create the release root:

```sh
export RELEASE_CASE_ID="$(
  paperclipai pipelines ingest \
    -C "$PAPERCLIP_COMPANY_ID" \
    "$RELEASE_PIPELINE" \
    --case-key "release-$RUN_KEY" \
    --stage intake \
    --title "Release $RUN_KEY: Pipeline primitives" \
    --summary "Rollup root for release content coverage." \
    --fields-json '{"release":"v0.pipeline-tutorial","templateVersionConvention":"routine-prompt"}' \
    --json | jq -r '.case.id'
)"
```

Create two feature cases parented to the release. One is approved, one is dropped.

```sh
jq -n --arg parent "$RELEASE_CASE_ID" '{
  items: [
    {
      caseKey: "feature-pipelines-ui",
      title: "Feature: Pipelines UI",
      summary: "Worth a content package.",
      parentCaseId: $parent,
      stageKey: "suggestion_review",
      fields: { releaseTag: "v0.pipeline-tutorial", source: "release-notes" }
    },
    {
      caseKey: "feature-routine-webhooks",
      title: "Feature: Routine webhooks",
      summary: "Rejected by the gate for this release.",
      parentCaseId: $parent,
      stageKey: "suggestion_review",
      fields: { releaseTag: "v0.pipeline-tutorial", source: "release-notes" }
    }
  ]
}' > /tmp/feature-cases.json

paperclipai pipelines ingest-batch \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$FEATURE_PIPELINE" \
  --file /tmp/feature-cases.json \
  --json | tee /tmp/feature-cases-result.json
```

```sh
feature_case_id() {
  jq -r --arg key "$1" '.[] | select(.case.caseKey == $key) | .case.id' /tmp/feature-cases-result.json
}

export FEATURE_MAIN="$(feature_case_id feature-pipelines-ui)"
export FEATURE_DROP="$(feature_case_id feature-routine-webhooks)"

jq -n --arg main "$FEATURE_MAIN" --arg drop "$FEATURE_DROP" '{
  items: [
    { caseId: $main, decision: "approve", expectedVersion: 1 },
    { caseId: $drop, decision: "reject", reason: "Fold webhooks into the broader launch post.", expectedVersion: 1 }
  ]
}' > /tmp/feature-review.json

paperclipai pipelines review-bulk \
  -C "$PAPERCLIP_COMPANY_ID" \
  --file /tmp/feature-review.json
```

Create content cases under the approved feature. `launch-tweet` declares `blockedByCaseKeys: ["blog-post"]`; the CLI resolves that key to the blog case in the same batch.

```sh
jq -n --arg parent "$FEATURE_MAIN" '{
  items: [
    {
      caseKey: "blog-post",
      title: "Launch blog post",
      summary: "Draft the release narrative.",
      parentCaseId: $parent,
      stageKey: "drafting",
      fields: {
        contentType: "blog",
        typedWorkRefs: { draftPath: "workspaces/release/blog.md" },
        briefedFromVersion: null
      }
    },
    {
      caseKey: "changelog-entry",
      title: "Product changelog",
      summary: "Compact changelog entry.",
      parentCaseId: $parent,
      stageKey: "drafting",
      fields: {
        contentType: "changelog",
        typedWorkRefs: { draftPath: "workspaces/release/changelog.md" },
        briefedFromVersion: null
      }
    },
    {
      caseKey: "launch-tweet",
      title: "Launch tweet",
      summary: "Tweet after the blog is approved.",
      parentCaseId: $parent,
      stageKey: "drafting",
      blockedByCaseKeys: ["blog-post"],
      fields: {
        contentType: "social",
        typedWorkRefs: { draftPath: "workspaces/release/tweet.md" },
        briefedFromVersion: 1
      }
    }
  ]
}' > /tmp/content-cases.json

paperclipai pipelines ingest-batch \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CONTENT_PIPELINE" \
  --file /tmp/content-cases.json \
  --json | tee /tmp/content-cases-result.json
```

**Convention:** `typedWorkRefs` and `briefedFromVersion` are ordinary case `fields`, not new primitives. They document how this case type points at work and how downstream asset briefs pin an upstream version.

## Step 3: Readiness Suggestion

The drafting agent should not silently move the case. It suggests `Drafting -> Assets` with a rationale, and the human accepts it.

```sh
content_case_id() {
  jq -r --arg key "$1" '.[] | select(.case.caseKey == $key) | .case.id' /tmp/content-cases-result.json
}

export BLOG_CASE="$(content_case_id blog-post)"
export CHANGELOG_CASE="$(content_case_id changelog-entry)"
export TWEET_CASE="$(content_case_id launch-tweet)"

export SUGGESTION_ID="$(
  paperclipai pipelines case suggest \
    -C "$PAPERCLIP_COMPANY_ID" \
    "$BLOG_CASE" \
    --to assets \
    --rationale "Draft is stable enough to brief asset work." \
    --confidence 0.9 \
    --json | jq -r '.suggestion.id'
)"

paperclipai pipelines case resolve-suggestion \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$BLOG_CASE" \
  --suggestion "$SUGGESTION_ID" \
  --accept \
  --expected-version 1
```

## Step 4: Parallel Editing And Drift

The draft can still change while dependent work exists. A material update to the upstream case posts a drift comment on dependent linked work issues.

```sh
export TWEET_WORK_ISSUE="$(
  paperclipai issue create \
    -C "$PAPERCLIP_COMPANY_ID" \
    --title "Work issue for launch tweet $RUN_KEY" \
    --description "Receives drift comments from the upstream blog case." \
    --status todo \
    --priority low \
    --json | jq -r '.id'
)"

curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  --data "$(jq -cn --arg issueId "$TWEET_WORK_ISSUE" '{ issueId: $issueId, role: "work" }')" \
  "$PAPERCLIP_API_URL/api/cases/$TWEET_CASE/issue-links" >/dev/null

paperclipai pipelines case edit \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$BLOG_CASE" \
  --expected-version 2 \
  --summary "Draft changed while dependent tweet work was already briefed." \
  --fields-json '{"contentType":"blog","typedWorkRefs":{"draftPath":"workspaces/release/blog.md"},"briefedFromVersion":null,"materialChange":"new-positioning"}'
```

If a worker tries to patch with the stale version, the API returns `409` with `code=version_conflict`, the current version, and the current stage. Recovery is to re-read the case and retry against the current version.

```sh
paperclipai pipelines case edit \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$BLOG_CASE" \
  --expected-version 2 \
  --title "Stale edit"

# Recovery:
paperclipai pipelines case get -C "$PAPERCLIP_COMPANY_ID" "$BLOG_CASE" --json
```

## Step 5: Assets

The Assets automation creates asset cases under the feature. In v1 the tutorial uses an explicit batch file; in the product, this is the stage-template convention.

```sh
export BLOG_VERSION="$(paperclipai pipelines case get -C "$PAPERCLIP_COMPANY_ID" "$BLOG_CASE" --json | jq -r '.case.version')"

jq -n --arg parent "$FEATURE_MAIN" --argjson briefVersion "$BLOG_VERSION" '{
  items: [
    {
      caseKey: "blog-hero-image",
      title: "Hero image",
      parentCaseId: $parent,
      stageKey: "assets",
      fields: { assetType: "image", briefedFromVersion: $briefVersion }
    },
    {
      caseKey: "blog-social-card",
      title: "Social card",
      parentCaseId: $parent,
      stageKey: "assets",
      fields: { assetType: "image", briefedFromVersion: $briefVersion }
    }
  ]
}' > /tmp/asset-cases.json

paperclipai pipelines ingest-batch \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CONTENT_PIPELINE" \
  --file /tmp/asset-cases.json \
  --json | tee /tmp/asset-cases-result.json
```

```sh
asset_case_id() {
  jq -r --arg key "$1" '.[] | select(.case.caseKey == $key) | .case.id' /tmp/asset-cases-result.json
}

export HERO_CASE="$(asset_case_id blog-hero-image)"
export CARD_CASE="$(asset_case_id blog-social-card)"

paperclipai pipelines case transition -C "$PAPERCLIP_COMPANY_ID" "$HERO_CASE" --to published --expected-version 1 --reason "Hero image done."
paperclipai pipelines case transition -C "$PAPERCLIP_COMPANY_ID" "$CARD_CASE" --to dropped --expected-version 1 --reason "Social card not needed."
```

When both asset cases are terminal, move the blog case to `assembly`.

```sh
export BLOG_ASSETS_VERSION="$(paperclipai pipelines case get -C "$PAPERCLIP_COMPANY_ID" "$BLOG_CASE" --json | jq -r '.case.version')"

paperclipai pipelines case transition \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$BLOG_CASE" \
  --to assembly \
  --expected-version "$BLOG_ASSETS_VERSION" \
  --reason "Assets complete; assemble the package."
```

## Step 6: Assembly And Auto-Advance To Final Review

Assembly is also a `working` stage. This is the `autoAdvanceOnChildrenTerminal` gate: create a package child case, complete it, and the blog case auto-advances into `final_review`.

```sh
jq -n --arg parent "$BLOG_CASE" '{
  items: [
    {
      caseKey: "blog-assembly-package",
      title: "Assembled blog package",
      parentCaseId: $parent,
      stageKey: "assembly",
      fields: { packageType: "blog", assembledFrom: ["blog-hero-image", "blog-social-card"] }
    }
  ]
}' > /tmp/assembly-cases.json

paperclipai pipelines ingest-batch \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CONTENT_PIPELINE" \
  --file /tmp/assembly-cases.json \
  --json | tee /tmp/assembly-cases-result.json

export ASSEMBLY_CASE="$(jq -r '.[0].case.id' /tmp/assembly-cases-result.json)"
paperclipai pipelines case transition -C "$PAPERCLIP_COMPANY_ID" "$ASSEMBLY_CASE" --to published --expected-version 1 --reason "Assembly complete."
```

## Step 7: Blocker Guard

The tweet is blocked by the blog case through `blockedByCaseKeys`. This transition fails with `409 code=blocked` until the blog reaches a `done` terminal stage.

```sh
paperclipai pipelines case transition \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$TWEET_CASE" \
  --to assets \
  --expected-version 1 \
  --reason "Try before upstream blog is published."
```

## Step 8: Final Review Approve

Approve the blog in Final Review, then publish it.

```sh
export BLOG_REVIEW_VERSION="$(paperclipai pipelines case get -C "$PAPERCLIP_COMPANY_ID" "$BLOG_CASE" --json | jq -r '.case.version')"

paperclipai pipelines case review \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$BLOG_CASE" \
  --approve \
  --expected-version "$BLOG_REVIEW_VERSION"

paperclipai pipelines case transition \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$BLOG_CASE" \
  --to published \
  --expected-version "$((BLOG_REVIEW_VERSION + 1))" \
  --reason "Approved package published."
```

## Step 9: Final Review Request Changes

The changelog demonstrates the edit loop: Final Review requests changes, the same case re-enters `drafting`, the same work references continue, and the case comes back to Final Review for approval.

```sh
paperclipai pipelines case transition -C "$PAPERCLIP_COMPANY_ID" "$CHANGELOG_CASE" --to final_review --expected-version 1 --reason "Draft ready for final review."

paperclipai pipelines case review \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CHANGELOG_CASE" \
  --request-changes \
  --reason "Tighten the framing before publishing." \
  --expected-version 2

paperclipai pipelines case edit \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CHANGELOG_CASE" \
  --expected-version 3 \
  --summary "Revised changelog entry after requested changes." \
  --fields-json '{"contentType":"changelog","typedWorkRefs":{"draftPath":"workspaces/release/changelog.md"},"changeRequestAddressed":true}'

paperclipai pipelines case transition -C "$PAPERCLIP_COMPANY_ID" "$CHANGELOG_CASE" --to final_review --expected-version 4 --reason "Revised draft ready."
paperclipai pipelines case review -C "$PAPERCLIP_COMPANY_ID" "$CHANGELOG_CASE" --approve --expected-version 5
paperclipai pipelines case transition -C "$PAPERCLIP_COMPANY_ID" "$CHANGELOG_CASE" --to published --expected-version 6 --reason "Published after request-changes loop."
```

## Step 10: Final Review Drop

Now that the blog blocker is done, the tweet can reach Final Review. The reviewer drops it, which is terminal and still counts toward rollup completion.

```sh
paperclipai pipelines case transition -C "$PAPERCLIP_COMPANY_ID" "$TWEET_CASE" --to final_review --expected-version 1 --reason "Blog blocker is now done."

paperclipai pipelines case review \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$TWEET_CASE" \
  --reject \
  --reason "Drop this tweet; blog already covers the announcement." \
  --expected-version 2
```

## Step 11: Rollup

At this point:

- content cases are `published` or `dropped`
- the approved feature case auto-advanced to `covered`
- the dropped feature case is terminal
- the release case auto-advanced to `covered`

Inspect the release rollup:

```sh
paperclipai pipelines case rollup \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$RELEASE_CASE_ID" \
  --json
```

Expected shape:

```json
{
  "total": 8,
  "done": 5,
  "cancelled": 3,
  "open": 0,
  "complete": true
}
```

## Step 12: Reflection Feed

Reflection can pull provenance from case events:

```sh
paperclipai pipelines case events \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$CHANGELOG_CASE" \
  --json
```

Look for `review_decided` events where `payload.decision` is `request_changes`, `approve`, or `reject`. Rejection and change-request reasons are the feed for improving skills, routine prompts, and pipeline guidance.

For rollup provenance:

```sh
paperclipai pipelines case events \
  -C "$PAPERCLIP_COMPANY_ID" \
  "$RELEASE_CASE_ID" \
  --json
```

Look for `children_terminal` followed by the auto `transitioned` event.

## Scripted Smoke

Run the same flow end to end:

```sh
PAPERCLIP_API_URL=http://localhost:3100 \
PAPERCLIP_COMPANY_ID=<company-id> \
PAPERCLIP_API_KEY=<token> \
pnpm smoke:pipelines-tutorial
```

The smoke asserts:

- the three pipelines are created with the expected stages
- feature review approves one feature and rejects one
- batch ingest wires `blockedByCaseKeys`
- readiness uses `suggest-transition` plus acceptance
- upstream drift posts a system comment to a linked work issue
- stale edits fail with `409 code=version_conflict`
- the Assembly child-terminal gate auto-advances the parent into Final Review
- Final Review approve, request-changes, and drop outcomes all work
- the release rollup is complete with the expected done/cancelled split
