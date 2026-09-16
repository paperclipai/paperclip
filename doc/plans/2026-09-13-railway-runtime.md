# Railway direct operations and container runtime review

Date: 2026-09-13. Scope: local preview authorized by the operator, without push.
Updated: 2026-09-16 for source-deployment security review.

The hosted connector alone cannot provide governed direct logs and shell. The
chosen runtime is a first-party fixed-operation bridge inside the existing MCP
gateway. It reuses OAuth resolution, agent/company/run/grant isolation, policy,
argument snapshots and auditing. It has no separate HTTP service, plugin,
database schema or arbitrary GraphQL/CLI interface.

The bridge verifies whether Railway accepts the actual grant credential for the
GraphQL API. Failed qualification disables direct capabilities. It never assumes
that OAuth tokens for one resource are valid for another or silently substitutes
ambient credentials. All mutations use fixed queries and check target membership.
Source deployment is blocked: a separate repository check can race the deployment
mutation. It requires an atomic provider repository/revision binding before it
can be enabled. Redeploy, restart and rollback target existing deployments.

Container commands run a fixed system OpenSSH client with isolated temporary
state, a dedicated vault-backed grant key, verified host trust and explicit
container-instance membership. Enrollment is manual: hosted OAuth does not
advertise SSH-key management scope, and provider-side key deletion can require
2FA. Paperclip does not borrow a developer's CLI login or SSH directory.

Independent read-only security review accepted this architecture for local
preview, subject to tests and live qualification. It required permanent blocks
for opaque hosted agent/staged-deployment actions, reconnect quarantine, key
preservation and teardown, no stale API execution, remote command confirmation,
and explicit disclosure that shell can perform arbitrary internal mutations.
These are narrow Railway rules; active actions otherwise retain Allowed defaults.

Live runtime acceptance remains separate from fixture success. An authorized
disposable provider target, account consent, registered public SSH key and trusted
host key are still required. Detailed setup, risk matrix and release gates are in
[RAILWAY.md](../connections/RAILWAY.md).
