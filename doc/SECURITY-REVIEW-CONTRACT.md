# Security Review Contract

Security review tasks need enough context for a reviewer to name concrete risks,
show evidence, and unblock shipping without re-discovering the whole change. Use
this contract whenever creating or completing a security-review task.

This contract is for review tasks. It is distinct from the Git handoff block used
when GitExpert opens or updates a pull request.

## When To Request Review

Create a security-review task before merge for changes that touch any of these
areas:

- Authentication, sessions, tokens, API keys, OAuth/OIDC, or identity providers
- Authorization, company scoping, permission grants, roles, or access control
- Secrets, encryption, signing, key storage, credential handling, or redaction
- Agent adapter execution, tool permissions, shell/database/eval inputs, or sandboxing
- Public endpoints, web security headers, CORS, CSRF, SSRF, uploads, or redirects
- Dependency or plugin loading, remote code/content ingestion, install scripts, or supply chain
- Analytics, logging, audit trails, billing events, telemetry, or any PII-bearing pipeline
- Production deployment, infrastructure, IAM, networking, or incident-response changes

If the change includes an active private advisory or unpatched production
vulnerability, do not put exploit details in the normal task thread. Use the
private advisory workflow or escalate to CTO for confidential handling.

## Review Packet

The requester must include this packet in the security-review task description
or first comment.

```md
## Security Review Packet

- Review mode: design review | code review | release gate | incident follow-up
- Requested by: <agent/user and source issue link>
- Change under review: <PR, branch, issue, design doc, or commit range>
- Security-sensitive areas: <auth/authz/secrets/agent tools/data pipeline/etc.>
- Intended behavior: <what should become possible>
- Trust boundaries: <actors, credentials, companies/tenants, external systems>
- Data handled: <secrets, PII, customer data, logs, artifacts, none>
- Abuse cases to check: <specific attacker goals or "requester unsure">
- Verification already run: <tests, manual checks, scanners, none>
- Known constraints: <deadlines, rollout plan, compatibility limits>
- Evidence pointers: <files, routes, docs, screenshots, redacted logs>
```

Minimum acceptable packets name the change under review, the security-sensitive
areas, the trust boundaries, and the data handled. If any field is unknown, write
`unknown` and explain what would be needed to answer it.

## Finding Block

SecurityEngineer must use this block for every substantive review result. If the
review finds no issues, emit one "No blocking findings" block with the same
evidence, verification, residual-risk, and follow-up fields.

```md
## Security Review Finding

- Verdict: block | approve with conditions | approve | no blocking findings
- Vulnerability class: <OWASP/API/LLM class or "none found">
- Severity: critical | high | medium | low | informational
- Exploitability: confirmed | likely | plausible | theoretical | not applicable
- Evidence: <file/line, route, request shape, design path, or negative-test result>
- Attack path: <what an attacker does and required prerequisites>
- Blast radius: <whose data/capability is exposed and whether it can pivot>
- Required fix: <specific code/design/process change, or "none">
- Tests or verification required: <regression test, manual step, scanner, none>
- Residual risk: <what remains after the fix or why risk is accepted>
- Follow-ups: <separate tickets needed, owner, or "none">
```

Keep proof-of-concept payloads redacted when they contain secrets, customer data,
or unpatched exploit details. Name the vulnerability class and the affected
surface clearly enough that the implementer can fix the class, not just one
instance.

## Completion Rules

- `block`: leave the reviewed task or PR gate unresolved and assign the fix to
  the implementer or owner with a concrete remediation spec.
- `approve with conditions`: only use when the remaining work is bounded,
  separately owned, and not needed before merge.
- `approve`: state the evidence reviewed and the verification run.
- `no blocking findings`: still state scope and residual risk so the review is
  auditable later.

Every remediation for a concrete vulnerability should include or request a
regression test that would fail before the fix.
