# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| `main`  | ✅ Active support  |
| Older   | ❌ Not supported   |

Only the latest release on the `main` branch receives security updates.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report security vulnerabilities through GitHub's Security Advisory feature:
[https://github.com/paperclipai/paperclip/security/advisories/new](https://github.com/paperclipai/paperclip/security/advisories/new)

### What to Include

- Description of the vulnerability
- Steps to reproduce or proof of concept
- Impact assessment (what an attacker could achieve)
- Affected component(s) and version(s)
- Any suggested fix (optional)

### Response Timeline

| Severity | Initial Response | Patch Target |
| -------- | ---------------- | ------------ |
| Critical | 24 hours         | 7 days       |
| High     | 3 business days  | 14 days      |
| Medium   | 7 business days  | 30 days      |
| Low      | 14 business days | Next release |

## Security Measures

### Automated Scanning

- **Dependency scanning** — Dependabot monitors for known vulnerabilities in dependencies
- **Secret scanning** — GitHub secret scanning prevents accidental credential commits
- **Code analysis** — Static analysis runs on pull requests

### Access Control

- Branch protection requires pull request reviews before merging
- Least-privilege access model for repository collaborators
- Agent API keys are hashed at rest and scoped to individual companies

### Development Practices

- All environment secrets use `.env` files excluded from version control
- API keys use bearer token authentication with per-company isolation
- Database credentials are never committed; use environment variables

## Dependency Management

- Dependabot is configured for automated dependency updates
- Major version updates require manual review
- All dependency changes go through the standard PR review process

## License

This security policy applies to the Paperclip project, licensed under the [MIT License](LICENSE).
