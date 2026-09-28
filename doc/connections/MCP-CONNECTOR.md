# Outbound MCP connector (private-network MCP servers)

Use the **Paperclip MCP connector** when agents should use an MCP server that
lives on a private network — a Kubernetes service, a homelab, an office LAN —
while Paperclip itself is internet-facing (`authenticated` + `public`).

The connector is a small process that runs **inside** the private network. It
dials **out** to Paperclip over a WebSocket and relays governed MCP calls to the
upstream MCP servers named in its own local config. Nothing is exposed, no
inbound port is opened, and Paperclip's SSRF guard for `mcp_remote`
connections stays exactly as strict as before.

```
Agent ──▶ Paperclip gateway ◀══ outbound WSS ══ Connector (private network) ──▶ local MCP server(s)
          (profiles, policies,                  (config: explicit upstream list)
           approvals, audit)
```

Tracked in paperclipai/paperclip#14280.

## When to use it

| Situation | Use |
| --- | --- |
| MCP server has a public HTTPS address | [Generic remote MCP](./GENERIC-REMOTE-MCP.md) (`mcp_remote`) |
| MCP server is only reachable on a private network and Paperclip is `authenticated/public` | **This connector** (`transport: "connector"`) |
| Paperclip runs `local_trusted` or `authenticated/private` on the same network | `mcp_remote` works directly; the connector is optional |
| MCP server is a local stdio command | [Local trusted deployment](../MCP-ACCESS-GOVERNANCE.md#local-trusted-deployment); stdio through the connector is a planned follow-up |

Do **not** hand-write a workspace `.mcp.json` for private MCP servers: that
path bypasses profiles, policies, approvals and the audit log.

## Setup

### 1. Create a connector in Paperclip

**Apps → Advanced → Connectors → Create connector.** Paperclip shows a one-time
enrollment token and a ready-to-copy environment block. The token:

- is bound to this company,
- works exactly once,
- expires after one hour,
- is stored only as a SHA-256 hash and is never shown again.

API equivalent (board, requires `tools:manage_connections`):

```sh
curl -X POST "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/mcp-connectors" \
  -H 'content-type: application/json' -d '{"name":"Homelab cluster"}'
# → { connector, enrollmentToken, enrollmentExpiresAt }
```

### 2. Run the connector next to the MCP servers

The connector is `packages/mcp-connector` (`paperclip-mcp-connector`). It needs
Node.js 24 and only the `ws` runtime dependency; a container image recipe is in
`packages/mcp-connector/Dockerfile`.

Configuration comes from a JSON file and/or environment variables (environment
wins):

| Variable | Config file key | Meaning |
| --- | --- | --- |
| `PAPERCLIP_URL` | `paperclipUrl` | Paperclip public URL (same as `PAPERCLIP_PUBLIC_URL`). |
| `PAPERCLIP_MCP_CONNECTOR_ENROLLMENT_TOKEN` | `enrollmentToken` | One-time token, used only on first start. |
| `PAPERCLIP_MCP_CONNECTOR_CREDENTIALS_FILE` | `credentialsFile` | Where the long-lived credential is stored (mode `0600`). Put it on a persistent volume. |
| `PAPERCLIP_MCP_CONNECTOR_UPSTREAMS` | `upstreams` | `name=url,name=url`, or a JSON object. |
| `PAPERCLIP_MCP_CONNECTOR_CONFIG` | — | Path to the JSON config file (or `--config <file>`). |

Example config file for the UniFi case from the issue:

```json
{
  "paperclipUrl": "https://paperclip.example.com",
  "credentialsFile": "/var/lib/paperclip-mcp-connector/credentials.json",
  "upstreams": {
    "unifi": {
      "url": "http://unifi-network-mcp.unifi-mcp.svc.cluster.local:3000/mcp",
      "headers": { "Authorization": "env:UNIFI_MCP_TOKEN" }
    }
  }
}
```

Header values of the form `env:NAME` are read from the connector's environment,
so upstream secrets need not be written into the file. Upstream names are
lowercase `[a-z0-9_-]`, at most 63 characters.

Kubernetes sketch:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: paperclip-mcp-connector, namespace: unifi-mcp }
spec:
  replicas: 1
  selector: { matchLabels: { app: paperclip-mcp-connector } }
  template:
    metadata: { labels: { app: paperclip-mcp-connector } }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 10001, fsGroup: 10001 }
      containers:
        - name: connector
          image: <your registry>/paperclip-mcp-connector:0.1.0
          env:
            - { name: PAPERCLIP_URL, value: "https://paperclip.example.com" }
            - { name: PAPERCLIP_MCP_CONNECTOR_UPSTREAMS, value: "unifi=http://unifi-network-mcp.unifi-mcp.svc.cluster.local:3000/mcp" }
            - { name: PAPERCLIP_MCP_CONNECTOR_CREDENTIALS_FILE, value: /data/credentials.json }
            - name: PAPERCLIP_MCP_CONNECTOR_ENROLLMENT_TOKEN
              valueFrom: { secretKeyRef: { name: paperclip-mcp-connector, key: enrollment-token, optional: true } }
          volumeMounts: [{ name: data, mountPath: /data }]
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: paperclip-mcp-connector }
```

On first start the connector exchanges the token for a long-lived credential,
writes it to `credentialsFile` with mode `0600`, and connects. Later restarts
reuse the stored credential and ignore the token. Commands:

```sh
paperclip-mcp-connector            # enroll if needed, then relay (default)
paperclip-mcp-connector enroll     # enroll and exit
paperclip-mcp-connector rotate     # replace the stored credential and exit
```

Run **one** process per connector credential. A second process with the same
credential replaces the first session.

### 3. Add a connection through the connector

Once the connector shows **online** with its upstream names, use **Add
connection** on that connector row, pick the upstream, and name the connection.
Paperclip runs a health check and catalog refresh over the connector, then
activates the connection. Review its actions and agent access under **Apps**
like any other connection; it is labelled **Unverified server**.

API equivalent:

```sh
curl -X POST "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/connections" \
  -H 'content-type: application/json' \
  -d '{"name":"UniFi (read-only)","transport":"connector","config":{"connectorId":"<id>","upstream":"unifi"}}'
```

A connector connection:

- takes `{ connectorId, upstream }` and **rejects** `url`/`endpoint` keys,
- may carry header credential refs from the Paperclip vault (injected per call,
  like `mcp_remote`), or none when the connector holds the upstream credential,
- uses the same health check, catalog refresh, risk classification, quarantine,
  profiles, policies, approvals and call event log as `mcp_remote`. Only the
  byte transport differs.

Browser sign-in (OAuth discovery) is not offered for connector connections:
discovery would make Paperclip fetch provider metadata, and the upstream is not
reachable from Paperclip by design. Use header credentials.

## Security model

- **The SSRF guard is unchanged.** `mcp_remote` still refuses private and
  reserved addresses in `authenticated/public`
  (`remote_http_private_endpoint`). The connector transport never dials
  anything from the Paperclip server.
- **Not an open proxy.** Paperclip addresses an upstream only by name. The URL
  exists only in the connector's config; request frames carry no URL, host,
  port or path, and the protocol parser rejects anything that is not a plain
  upstream name. Unknown names are refused by the server (from the connector's
  published list) and again by the connector before any network activity.
  Redirects from the upstream are not followed.
- **Upstream names, not URLs, are published.** On connect the connector sends
  its version and upstream names. URLs and connector-local headers never leave
  the connector.
- **Tokens.** Enrollment tokens are single-use (atomic claim), expire after one
  hour, are company-bound, and are stored as SHA-256 hashes. Long-lived
  credentials are stored as SHA-256 hashes, compared in constant time, and can
  be rotated by the connector (`rotate`) or reset by a board admin
  (**Re-enroll**, which invalidates the credential and issues a new token).
- **Company boundary.** A connector belongs to exactly one company. The session
  is bound to that company at authentication, and **every relayed request**
  re-checks in the database that the connector exists in the connection's
  company and is not revoked, and checks the session's company again in memory.
  Response frames are matched only against requests sent on that same session.
- **Revocation.** **Revoke** closes the WebSocket immediately, fails in-flight
  calls with `connector_revoked`, and stops the connector process (it exits
  instead of reconnecting). A heartbeat re-validates the credential every
  25 seconds so a revoke handled by another replica also takes effect.
- **Secrets.** Relay errors carry fixed messages; nothing from the upstream or
  connector is echoed into health messages, activity or API errors. Activity
  entries (`tool_mcp_connector.*`) never contain token or credential material.
  Vault header values follow the rules in
  [GENERIC-REMOTE-MCP.md](./GENERIC-REMOTE-MCP.md): write-only, only header
  names visible. Response headers are reduced to an allowlist
  (`content-type`, `mcp-session-id`, `mcp-protocol-version`,
  `www-authenticate`, `retry-after`, `x-request-id`).
- **Limits.** Request bodies ≤ 1 MiB, response bodies ≤ 8 MiB (both enforced on
  both sides), WebSocket frames ≤ 8.25 MiB, 32 in-flight requests per
  connector, per-call timeouts (default 60 s, the gateway's tool timeout for
  `tools/call`, max 10 min).
- **Untrusted in both directions.** Paperclip treats relayed responses exactly
  like any remote MCP response (JSON-RPC checks, size limits, content guards in
  `tool-content-guards.ts`). The connector validates every server frame with a
  strict parser and drops transport, cookie, `Proxy-*` and `Sec-*` headers.

## Health and troubleshooting

Connector status (online/offline, version, upstream names, last seen) is shown
in **Apps → Advanced → Connectors** and returned by
`GET /api/companies/:companyId/tools/mcp-connectors`.

| Code | Health | Meaning / fix |
| --- | --- | --- |
| `connector_offline` (503) | `degraded` | No live session for this connector on this Paperclip instance. Check the connector logs and that it can reach `PAPERCLIP_URL` over HTTPS/WSS. |
| `connector_revoked` (503) | `error` | The connector was revoked. Create a new connector and move the connection to it. |
| `connector_not_found` (422) | `error` | The connection references a connector outside its company or one that was deleted. |
| `connector_upstream_unknown` (422) | `error` | The connector does not publish this upstream name. Fix the name in the connection or the connector config. |
| `connector_upstream_unreachable` (502) | `error` | The connector could not reach the upstream URL (DNS, network policy, upstream down). |
| `connector_upstream_unauthorized` (422) | `error` | The upstream answered 401/403. Add credential headers (vault ref or connector-local). |
| `connector_timeout` (504) | `error` | The upstream or connector did not answer in time. |
| `connector_response_too_large` (502) | `error` | The upstream response exceeded 8 MiB. |

Connector exit codes: `2` configuration error, `3` fatal (enrollment rejected,
credential revoked or reset — enroll again with a new token), `1` crash.
Connection drops are retried with exponential backoff and full jitter
(1 s → 60 s).

Behind an ingress, make sure WebSocket upgrades are allowed for
`/api/mcp-connectors/connect` and that idle timeouts exceed the 25-second
ping interval.

## Known limitations (Phase 1)

- **Single instance affinity.** Connector sessions live in the memory of the
  Paperclip process that accepted them. With several server replicas, a request
  handled by a replica without the session reports `connector_offline`. Run a
  single replica or pin `/api/mcp-connectors/connect` and gateway traffic to
  the same instance until cross-replica routing exists.
- **Buffered relay.** Each Streamable HTTP request is relayed as a whole: SSE
  responses are read until the matching JSON-RPC response arrives (bounded by
  size and timeout). Server-initiated requests inside that stream are delivered
  together with the response rather than live.
- **No stdio supervision yet.** Supervising approved stdio templates on the
  connector (as runtime slots) is planned as a separate change.
- **Header credentials only.** Browser sign-in is not available through the
  connector.

## Verifying

`server/src/__tests__/mcp-connector.test.ts` runs without external services: a
loopback MCP upstream, the real WebSocket endpoint and an in-process connector.
It covers enrollment (single use, expiry, `0600` credential file), health check
and catalog refresh over the connector while `mcp_remote` to the same address is
still refused, an allowed read and a policy-blocked write with call events,
unknown upstream names, `connector_offline`, revocation closing the session and
failing an in-flight call, and the company boundary.
`packages/mcp-connector/src/*.test.ts` covers config parsing, the relay (unknown
upstream, header handling, SSE early stop, size limit) and the protocol parser.
