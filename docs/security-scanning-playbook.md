# Security Scanning Playbook

Paperclip uses GitHub CodeQL for source scanning and Dependabot for dependency and GitHub Actions update pull requests.

## Ownership

The CTO owns security alert triage. The assignee for the alert or remediation issue owns the code change until the fix is merged and verified. If an alert has no assignee after one business day, the CTO assigns it directly or creates a Paperclip issue for the relevant engineer.

## Alert Intake

1. Review new GitHub Security alerts every business day.
2. Confirm whether the alert affects supported Paperclip code, release artifacts, or CI/CD execution.
3. Create or update a Paperclip issue for every actionable alert. Link the GitHub alert, affected package or source path, severity, and planned remediation.
4. Close false positives only after documenting the reason in the GitHub alert or linked issue.

## Remediation SLA

| Severity | First response | Remediation target |
| --- | --- | --- |
| Critical | Same business day | 2 business days |
| High | 1 business day | 5 business days |
| Medium | 2 business days | 10 business days |
| Low | 5 business days | Next planned maintenance window |

If a fix cannot meet its target, the owner must update the Paperclip issue with the blocker, temporary mitigation, and new target date.

## Dependabot Pull Requests

Dependabot runs weekly for npm dependencies and GitHub Actions. Minor and patch updates are grouped by dependency type to reduce review noise; major updates are grouped separately so breaking-change risk is explicit.

For each Dependabot PR:

1. Review release notes and lockfile changes.
2. Run the smallest relevant local verification, then rely on required CI for broad coverage.
3. Merge low-risk patch and minor updates once checks pass.
4. Split or defer grouped updates if one dependency causes failures.

## CodeQL Alerts

CodeQL runs on pull requests, pushes to `master`, and a weekly scheduled scan. Pull request findings should be fixed before merge unless the CTO accepts the risk in writing. Default-branch findings follow the SLA table above.

When fixing a CodeQL alert:

1. Identify the vulnerable data flow or unsafe API use.
2. Add a regression test or guardrail when practical.
3. Reference the alert and verification in the pull request description.
4. Confirm the alert is closed or dismissed with rationale after the fix lands on `master`.

## Escalation

Escalate to the CTO immediately when an alert indicates exploitable remote code execution, credential exposure, authentication bypass, cross-company data access, or a compromised dependency. The CTO decides whether to pause releases, request board approval, or coordinate a private security advisory.
