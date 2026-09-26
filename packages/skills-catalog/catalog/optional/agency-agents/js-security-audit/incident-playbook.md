# Compromised Dependency — Incident Response Playbook

> Reference for SKILL.md. Used when a dependency is reported compromised (e.g. Axios March 2026, Shai-Hulud).

## Step 1: Detect

```bash
# Is the affected version installed?
npm list <package> | grep -E "<compromised-version>"
grep -E "<compromised-version>" package-lock.json

# Check for known malware artifacts (example: axios attack)
ls -la /Library/Caches/com.apple.act.mond 2>/dev/null   # macOS
ls -la /tmp/ld.py 2>/dev/null                            # Linux
```

If found, treat every machine that installed in the exposure window as compromised until proven otherwise.

## Step 2: Contain

```bash
# Pin to last known-safe version
npm install <package>@<safe-version> --save-exact

# Force resolution for transitive deps
# package.json:
#   { "overrides": { "<package>": "<safe-version>" } }
# yarn:
#   { "resolutions": { "<package>": "<safe-version>" } }
# pnpm:
#   { "pnpm": { "overrides": { "<package>": "<safe-version>" } } }

# Block C2 domains (if known)
echo "0.0.0.0 <c2-domain>" | sudo tee -a /etc/hosts

# Clean reinstall
rm -rf node_modules
npm ci --ignore-scripts
npm rebuild <trusted-packages-only>
```

## Step 3: Assess

Answer these explicitly. Document the answers in the incident ticket.

- Which CI/CD runners installed the compromised version?
- Which developer machines ran `npm install` during the exposure window?
- Were any secrets, tokens, or SSH keys accessible on compromised machines?
- Did any production deploys happen during the exposure window? Roll them back if uncertain.

## Step 4: Remediate

Rotate **everything** that touched a compromised machine.

```bash
# npm tokens
npm token revoke <token-id>
npm token create --read-only

# SSH keys
ssh-keygen -R <host>
# Generate new keypair on each affected machine
```

Also rotate:
- Cloud credentials (AWS keys, GCP service accounts, Azure)
- Database passwords / connection strings
- Third-party API keys (Stripe, Twilio, OpenAI, etc.)
- Session tokens / signing secrets
- OAuth client secrets

Don't rotate "the most important ones first" — rotate all of them. Attackers prioritize what you don't.

## Step 5: Harden

- Add the package to your version-pinning policy
- Update CI rebuild allowlist documentation
- Add IOCs (C2 domains, file paths) to monitoring
- Share incident summary with the team
- File a post-mortem with timeline, blast radius, and what changed

## References

- Axios supply chain attack — [StepSecurity write-up](https://www.stepsecurity.io/blog/axios-compromised-on-npm-malicious-versions-drop-remote-access-trojan)
- Shai-Hulud / npm worm — [Snyk](https://snyk.io/articles/npm-security-best-practices-shai-hulud-attack/)
- npm Supply Chain 2026 — [Bastion](https://bastion.tech/blog/npm-supply-chain-attacks-2026-saas-security-guide)
