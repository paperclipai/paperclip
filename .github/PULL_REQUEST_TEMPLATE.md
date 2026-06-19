## Thinking Path

<!--
  Required. Trace your reasoning from the top of the project down to this
  specific change. Start with what Paperclip is, then narrow through the
  subsystem, the problem, and why this PR exists. Use blockquote style.
  Aim for 5–8 steps. See CONTRIBUTING.md for full examples.
-->

> - Paperclip is the open source app people use to manage AI agents for work
> - [Which subsystem or capability is involved]
> - [What problem or gap exists]
> - [Why it needs to be addressed]
> - This pull request ...
> - The benefit is ...

## Linked Issues or Issue Description

<!--
  Required. Pick ONE of the following two paths:

  (A) Issue exists — tag each linked issue with `Fixes: #123`, `Closes #123`,
      or `Refs #123`. Include duplicates and closely related issues too.

  Only reference PUBLIC GitHub issues/PRs here. Do NOT paste internal,
  instance-local Paperclip references — ticket ids like PAPA-123 / PAP-224,
  /PAP/issues/... or agent://... links, or localhost/tailnet URLs. Other
  contributors cannot open them. See CONTRIBUTING.md → "No Internal Issue
  References".

  (B) No issue exists — describe the underlying problem here, following the
      relevant issue template so reviewers get the same fields:
        • Bug:     .github/ISSUE_TEMPLATE/bug_report.yml
        • Feature: .github/ISSUE_TEMPLATE/feature_request.yml
        • Adapter: .github/ISSUE_TEMPLATE/adapter_request.yml

  See CONTRIBUTING.md → "Link Issues or Describe Them In-PR".
-->

-

## What Changed

<!-- Bullet list of concrete changes. One bullet per logical unit. -->

-

## Verification

<!--
  How can a reviewer confirm this works? Include test commands, manual
  steps, or both. For UI changes, include before/after screenshots.
-->

-

## Risks

<!--
  What could go wrong? Mention migration safety, breaking changes,
  behavioral shifts, or "Low risk" if genuinely minor.
-->

-

> For core feature work, check [`ROADMAP.md`](ROADMAP.md) first and discuss it in `#dev` before opening the PR. Feature PRs that overlap with planned core work may need to be redirected — check the roadmap first. See `CONTRIBUTING.md`.

## Model Used

<!--
  Required. Specify which AI model was used to produce or assist with
  this change. Be as descriptive as possible — include:
    • Provider and model name (e.g., Claude, GPT, Gemini, Codex)
    • Exact model ID or version (e.g., claude-opus-4-6, gpt-4-turbo-2024-04-09)
    • Context window size if relevant (e.g., 1M context)
    • Reasoning/thinking mode if applicable (e.g., extended thinking, chain-of-thought)
    • Any other relevant capability details (e.g., tool use, code execution)
  If no AI model was used, write "None — human-authored".
-->

-

## Checklist

- [ ] I have included a thinking path that traces from project context to this change
- [ ] I have specified the model used (with version and capability details)
- [ ] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [ ] I have searched GitHub for duplicate or related PRs and linked them above
- [ ] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [ ] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [ ] I have run tests locally and they pass
- [ ] I have added or updated tests where applicable
- [ ] If this change affects the UI, I have included before/after screenshots
- [ ] I have updated relevant documentation to reflect my changes
- [ ] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [ ] I will address all Greptile and reviewer comments before requesting merge
