---
name: pr-report
description: >
  Review a pull request or contribution deeply, explain it tutorial-style for a
  maintainer, and produce a polished report artifact such as HTML or Markdown.
  Use when asked to analyze a PR, explain a contributor's design decisions,
  compare it with similar systems, or prepare a merge recommendation.
---

# PR Report Skill

Produce a maintainer-grade review of a PR, branch, or large contribution.

Default posture:

- understand the change before judging it
- explain the system as built, not just the diff
- separate architectural problems from product-scope objections
- make a concrete recommendation, not a vague impression

## When to Use

Use this skill when the user asks for things like:

- "review this PR deeply"
- "explain this contribution to me"
- "make me a report or webpage for this PR"
- "compare this design to similar systems"
- "should I merge this?"

## Outputs

Common outputs:

- standalone HTML report in `tmp/reports/...`
- Markdown report in `report/` or another requested folder
- short maintainer summary in chat

If the user asks for a webpage, build a polished standalone HTML artifact with
clear sections and readable visual hierarchy.

Resources bundled with this skill:

- `references/style-guide.md` for visual direction and report presentation rules
- `assets/html-report-starter.html` for a reusable standalone HTML/CSS starter

## Workflow

### 1. Acquire and frame the target

Work from local code when possible, not just the GitHub PR page.

Gather:

- target branch or worktree
- diff size and changed subsystems
- relevant repo docs, specs, and invariants
- contributor intent if it is documented in PR text or design docs

Start by answering: what is this change *trying* to become?

### 2. Build a mental model of the system

Do not stop at file-by-file notes. Reconstruct the design:

- what new runtime or contract exists
- which layers changed: db, shared types, server, UI, CLI, docs
- lifecycle: install, startup, execution, UI, failure, disablement
- trust boundary: what code runs where, under what authority

For large contributions, include a tutorial-style section that teaches the
system from first principles.

### 3. Review like a maintainer

Findings come first. Order by severity.

Prioritize:

- behavioral regressions
- trust or security gaps
- misleading abstractions
- lifecycle and operational risks
- coupling that will be hard to unwind
- missing tests or unverifiable claims

Always cite concrete file references when possible.

### 4. Distinguish the objection type

Be explicit about whether a concern is:

- product direction
- architecture
- implementation quality
- rollout strategy
- documentation honesty

Do not hide an architectural objection inside a scope objection.

### 5. Compare to external precedents when needed

If the contribution introduces a framework or platform concept, compare it to
similar open-source systems.

When comparing:

- prefer official docs or source
- focus on extension boundaries, context passing, trust model, and UI ownership
- extract lessons, not just similarities

Good comparison questions:

- Who owns lifecycle?
- Who owns UI composition?
- Is context explicit or ambient?
- Are plugins trusted code or sandboxed code?
- Are extension points named and typed?

### 6. Make the recommendation actionable

Do not stop at "merge" or "do not merge."

Choose one:

- merge as-is
- merge after specific redesign
- salvage specific pieces
- keep as design research

If rejecting or narrowing, say what should be kept.

Useful recommendation buckets:

- keep the protocol/type model
- redesign the UI boundary
- narrow the initial surface area
- defer third-party execution
- ship a host-owned extension-point model first

### 7. Build the artifact

Suggested report structure:

1. Executive summary
2. What the PR actually adds
3. Tutorial: how the system works
4. Strengths
5. Main findings
6. Comparisons
7. Recommendation

For HTML reports:

- use intentional typography and color
- make navigation easy for long reports
- favor strong section headings and small reference labels
- avoid generic dashboard styling

Before building from scratch, read `references/style-guide.md`.
If a fast polished starter is helpful, begin from `assets/html-report-starter.html`
and replace the placeholder content with the actual report.

### 8. Verify before handoff

Check:

- artifact path exists
- findings still match the actual code
- any requested forbidden strings are absent from generated output
- if tests were not run, say so explicitly

## Review Heuristics

### Plugin and platform work

Watch closely for:

- docs claiming sandboxing while runtime executes trusted host processes
- module-global state used to smuggle React context
- hidden dependence on render order
- plugins reaching into host internals instead of using explicit APIs
- "capabilities" that are really policy labels on top of fully trusted code

### Good signs

- typed contracts shared across layers
- explicit extension points
- host-owned lifecycle
- honest trust model
- narrow first rollout with room to grow

## Final Response

In chat, summarize:

- where the report is
- your overall call
- the top one or two reasons
- whether verification or tests were skipped

Keep the chat summary shorter than the report itself.
