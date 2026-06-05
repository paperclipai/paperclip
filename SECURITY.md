# Security Policy

## Reporting a Vulnerability

**Do NOT open a public issue for security vulnerabilities.**

Please use GitHub's private vulnerability reporting instead:

1. Go to the [Security Advisories page](https://github.com/paperclipai/paperclip/security/advisories)
2. Click **"Report a vulnerability"**
3. Provide as much detail as possible — steps to reproduce, affected components, and potential impact

Reports are private between you and the maintainers until a fix is ready. You'll be credited in the advisory if you'd like.

## What qualifies as a security issue?

- Agent privilege escalation (bypassing governance or approval gates)
- Secret leakage (API keys, tokens exposed in logs or agent output)
- Budget enforcement bypass (agents exceeding cost limits)
- Unauthorized cross-company data access (breaking tenant isolation)
- Adapter sandbox escape or arbitrary code execution

## Response timeline

- **Acknowledgment**: Within 48 hours
- **Assessment**: Within 1 week
- **Fix**: Depends on severity, but critical issues are prioritized immediately
