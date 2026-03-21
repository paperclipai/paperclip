# Pelergy Trial Security

Last reviewed: 2026-03-21
Scope: trial deployment and operations for the Pelergy trial on Paperclip V1.

## Current Vulnerabilities

| ID | Vulnerability | Current Exposure | Trial Mitigation |
| --- | --- | --- | --- |
| PT-SEC-001 | `local_trusted` mode has implicit board access with no login gate. | Any local user/process on the host can operate as board in this mode. | Use `authenticated/private` mode for trial environments. Disable `local_trusted` outside single-user localhost development. |
| PT-SEC-002 | Single-operator board model has no granular human RBAC in V1. | If board credentials/session are compromised, attacker gets broad control. | Restrict trial board access to a single designated operator account, short session TTL, and network-level allowlist (VPN/Tailscale). |
| PT-SEC-003 | Agent adapters can execute external commands or callbacks. | Misconfigured adapter settings may allow unsafe command execution or data egress. | Allow only reviewed adapter configs for trial companies. Require approval for adapter-config changes and keep activity log monitoring enabled. |
| PT-SEC-004 | Secret-management defaults rely on local key material in local installs. | Compromise of host and key file can expose encrypted local secrets. | Store trial secret master key outside repo, apply strict file permissions, rotate key on environment rebuild, and avoid inline secret values. |
| PT-SEC-005 | Public internet exposure increases attack surface for auth and API misuse. | Higher risk of unauthorized probing, brute force, and abuse in public mode. | Keep trial in `authenticated/private` mode, enforce private-network ingress only, and do not expose unaudited endpoints publicly. |

## Trial Mitigation Plan

1. Run trial instances only in `authenticated/private` deployment mode.
2. Enforce private network ingress (for example, Tailscale) and deny direct public ingress.
3. Limit board access to named operators and review access weekly.
4. Require approval workflow for high-risk actions (hiring, strategy, adapter config changes).
5. Turn on strict secret handling (`PAPERCLIP_SECRETS_STRICT_MODE=true`) and ban inline sensitive env values.
6. Review activity logs daily for mutating actions in trial companies.
7. Re-assess this register weekly during trial; append new findings with date.

## Residual Risk

The Pelergy trial accepts residual risk tied to V1 product limits (single-board model, reduced RBAC granularity) and mitigates operationally with private deployment, tight operator access, approval gates, and active monitoring.
