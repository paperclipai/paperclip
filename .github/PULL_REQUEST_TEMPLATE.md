## Thinking Path

<!--
  Required. Trace your reasoning from the top of the project down to this
  specific change. Start with what Paperclip is, then narrow through the
  subsystem, the problem, and why this PR exists. Use blockquote style.
  Aim for 5–8 steps. See CONTRIBUTING.md for full examples.
-->

> - Paperclip orchestrates AI agents for zero-human companies
> - [Which subsystem or capability is involved]
> - [What problem or gap exists]
> - [Why it needs to be addressed]
> - This pull request ...
> - The benefit is ...

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

## Checklist

- [ ] I have included a thinking path that traces from project context to this change
- [ ] I have run tests locally and they pass
- [ ] I have added or updated tests where applicable
- [ ] If this change affects the UI, I have included before/after screenshots
- [ ] I have updated relevant documentation to reflect my changes
- [ ] I have considered and documented any risks above
- [ ] I have listed the impacted layers (`db/shared/server/ui`) or explicitly said the change is docs/config only
- [ ] I have checked company boundary impact where the change touches company-scoped behavior
- [ ] I have checked approval boundary impact where the change touches governed actions
- [ ] I have checked mutating action logging where the change touches mutating routes/services
- [ ] I have included a concrete rollback path for non-trivial changes
- [ ] I will address all Greptile and reviewer comments before requesting merge
