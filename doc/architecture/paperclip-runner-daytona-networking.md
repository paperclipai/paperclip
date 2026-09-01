# Paperclip Runner in Daytona sandboxes

## Intended topology

Paperclip creates the run and a short-lived, one-use runner bootstrap ticket. The Daytona sandbox starts only `paperclip-runnerd`; runnerd then starts the configured provider (Codex initially). Runnerd listens on a fixed sandbox-local port and Paperclip connects through Daytona's authenticated preview WebSocket ingress. The provider never receives a Paperclip API credential or Daytona preview credential.

```text
Paperclip control plane
       |
       | outbound WSS + X-Daytona-Preview-Token
       v
Daytona preview proxy -> paperclip-runnerd:43127 -> Codex app-server
```

The PRP identity binds company, issue, agent, run, environment lease, runner instance, normalized session, artifact version, artifact digest, and catalog digest. After the one-use ticket challenge succeeds, runnerd receives a renewable connection lease. Revocation, expiry, replay cursors, and the durable outbox continue to work across transient network loss and sandbox/provider restarts.

## Network policy

- Allow Paperclip to make outbound TCP 443 connections to the configured Daytona preview origin. The Paperclip host does not need public ingress.
- Allow the sandbox provider's private preview proxy to reach runnerd on TCP 43127. Do not expose the port with a public sandbox or signed URL.
- Allow the sandbox outbound access only to destinations explicitly required by the provider runtime.
- Use Daytona's `wss://` preview URL with normal certificate and hostname validation. The preview token is sent only as the `X-Daytona-Preview-Token` header by Paperclip.
- Runnerd rejects public plaintext `ws://` destinations. Public dial targets require `wss://` with hostname validation and either the platform trust store or an explicitly staged private CA bundle.
- Listener mode binds only `0.0.0.0:43127`, accepts only the run-specific `/api/runner/v1/connect/:runId` path, and rejects WebSocket extension negotiation. PRP authentication and application-layer secure frames remain mandatory above the preview-proxy hop.
- Do not put the bootstrap ticket in argv, files, provider environment, logs, or model context. Inject it into runnerd's initial environment/secret channel; runnerd already removes it from its environment immediately.
- Runnerd is the only process allowed to reach PRP. The provider communicates with runnerd over inherited pipes.

## Lifecycle

1. Paperclip allocates the Daytona environment and persists its environment lease.
2. Paperclip creates a runner ticket with a very short expiry and binds it to the run, environment lease, runner digest/version, and allowed catalog digest.
3. The sandbox startup command launches the pinned runnerd artifact in listener mode on `0.0.0.0:43127` and the run-specific PRP path. The ticket is supplied separately as secret environment material.
4. Paperclip acquires an authenticated Daytona preview endpoint and dials runnerd. After PRP authentication, Paperclip sends `run.prepare`; only then may runnerd start Codex and advertise the run-authorized tools.
5. Suspend/drain/revoke commands stop new turns and durably flush terminal events. Paperclip revokes the lease before destroying or recycling the sandbox.
6. A recovered sandbox reuses its durable runner state and an unexpired connection lease; it must not mint a second provider session when a resumable one exists.

## Deployment-mode boundary

Daytona always selects provider ingress for `paperclip_runner`; it does not fall
back to direct outbound WSS or a legacy callback bridge. Same-host native runs
keep loopback `ws://`, and other remote providers may use direct outbound
`wss://` only when an operator explicitly configures a reachable Paperclip
runner URL. Legacy adapters retain their existing transport paths.
