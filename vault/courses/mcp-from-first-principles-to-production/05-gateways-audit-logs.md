---
course_slug: mcp-from-first-principles-to-production
chapter_num: 5
chapter_slug: gateways-audit-logs
title: "Gateways, audit logs, and shipping to a 1,000-user team"
status: draft-for-review
author: vardaan-koenig
agent_drafted_by: course-author
date: 2026-04-30
duration_min: 60
prerequisites_chapters: [1, 2, 3, 4]
learning_objectives:
  - "Explain the role of an MCP gateway vs. running servers directly (discovery, RBAC, rate limiting, audit)"
  - "Configure a gateway with server discovery via .well-known metadata, RBAC policies, and per-user rate limits"
  - "Produce a structured audit log stream (who called what, when, with what result) that passes a SOC 2 audit template"
  - "Describe the five most common production failure modes and their mitigations"
key_concepts:
  - MCP gateway topology
  - .well-known server discovery
  - RBAC scopes (tools:read / tools:admin)
  - structured audit logging (JSON Lines)
  - rate limiting
  - horizontal scaling without session state
  - rolling deployments
hands_on_exercise: "Deploy the Chapter 4 auth-enabled server behind a gateway (mcp-gateway OSS or Nginx+Lua), configure RBAC with tools:read / tools:admin, emit one audit log line per tool call, verify with curl"
sources:
  - https://spec.modelcontextprotocol.io/
  - https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/
---

# Gateways, audit logs, and shipping to a 1,000-user team

An **MCP gateway** is a reverse proxy specialized for the Model Context Protocol that handles server discovery, role-based access control, per-user rate limiting, and structured audit logging — sitting between MCP clients and one or more upstream MCP servers so that none of those concerns need to live inside individual server implementations. The concept was formalized in the 2026 MCP specification roadmap[^1], which identified multi-server orchestration and centralized policy enforcement as the top two production gaps teams were working around manually. By Q2 2026, at least three open-source gateway implementations existed, each taking the same approach: validate the DPoP token once at the edge, enforce RBAC scopes before forwarding, and write one JSON Lines audit entry per tool call.

> **Prerequisites**: Chapters 1–4 — specifically the DPoP-enabled server you built in [[04-oauth-dpop-auth|Chapter 4]]. You should have a running MCP server that validates DPoP-bound access tokens and returns structured `401` errors.
>
> **Time**: 60 minutes
>
> **What you'll be able to do**: By the end of this chapter, you will have deployed your Chapter 4 server behind a gateway, configured RBAC with `tools:read` and `tools:admin` scopes, produced SOC 2-compatible audit logs, and can describe the five failure modes that end production MCP deployments.

---

## Key facts

1. The MCP specification's `.well-known/mcp.json` endpoint (analogous to OAuth's `.well-known/oauth-authorization-server` from [[04-oauth-dpop-auth|Chapter 4]]) allows gateways to autodiscover server capabilities, available tools, and required auth scopes without manual configuration.[^2]
2. As of the 2026 MCP roadmap, gateway-level RBAC using OAuth scopes (`tools:read`, `tools:admin`) is the recommended pattern for multi-tenant deployments rather than embedding authorization logic inside individual servers.[^1]
3. JSON Lines (JSONL) — one JSON object per newline — is the de-facto format for MCP audit logs: it is streamable, grep-able, and directly ingestible by every major observability backend (Loki, Datadog, Splunk, CloudWatch Logs).[^2]
4. MCP servers designed for horizontal scaling must be stateless across requests: session affinity (sticky sessions) is a design smell that prevents zero-downtime rolling deployments.
5. The five most common production failure modes in MCP deployments are: token expiry mid-session, gateway single-point-of-failure, session state leaking into horizontally-scaled servers, audit log saturation, and rate-limit false positives under burst load.

---

## The contrarian premise: gateways on day one, not day 100

Most engineering teams introduce a gateway after they hit a problem — usually when security asks "who called that tool last Tuesday?" and no one has an answer. By then, the audit trail is gone, RBAC is bolted on as an afterthought, and the refactor costs a sprint.

The argument for gateway-first is economic, not architectural. Setting up `mcp-gateway` (the OSS option covered in this chapter) takes under two hours. It gives you server discovery, token validation, RBAC enforcement, and a JSON Lines audit stream from the first deployment. Compare that to the cost of retrofitting all of that after your server is in production and twenty other teams are calling it.

The [[02-json-rpc-over-stdio|wire protocol]] you learned in Chapter 2 does not change when you add a gateway. The gateway is transparent to the MCP client: it receives valid JSON-RPC frames, forwards them upstream, and returns the upstream response. The client doesn't know or care that a gateway is in the path. That transparency is what makes the gateway-first pattern possible: you can add it to an existing deployment without touching the server or client code.

---

## Gateway topology: what goes where

```
MCP Client (Claude Desktop, IDE plugin, your agent)
        │  JSON-RPC over HTTP (Streamable HTTP transport)
        ▼
┌─────────────────────────────────────────────────────┐
│                   MCP Gateway                       │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ DPoP check  │  │ RBAC policy  │  │ Audit log │  │
│  └─────────────┘  └──────────────┘  └───────────┘  │
│                   ┌──────────────┐                  │
│                   │ Rate limiter │                  │
│                   └──────────────┘                  │
└──────────────────────────┬──────────────────────────┘
                           │  JSON-RPC (forwarded)
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         Server A      Server B      Server C
       (GitHub)      (Jira)        (Slack)
```

The gateway is the single ingress point for all MCP traffic. It does four things before forwarding any request:

1. **Token validation**: verify the DPoP proof JWT and access token (as you wired in [[04-oauth-dpop-auth|Chapter 4]])
2. **RBAC enforcement**: check the token's scopes against the requested tool
3. **Rate limiting**: apply per-user or per-client token bucket limits
4. **Audit logging**: write one JSONL entry with request metadata before the upstream call

After the upstream server responds, the gateway may also sanitize the response (strip raw secrets from tool outputs) and write a second audit entry with the result status and duration.

### Server discovery via `.well-known/mcp.json`

For the gateway to know which upstream servers exist and what they expose, the MCP spec defines a discovery mechanism: a server exposes a `/.well-known/mcp.json` document at its base URL.[^2] The gateway polls this on startup and on a configurable interval (default: 5 minutes in most implementations).

A minimal `/.well-known/mcp.json` looks like this:

```json
{
  "schema_version": "2025-03-26",
  "server_name": "github-mcp",
  "description": "GitHub integration — list repos, read files, create PRs",
  "capabilities": {
    "tools": true,
    "resources": true,
    "prompts": false
  },
  "scopes_required": {
    "tools/list": ["tools:read"],
    "tools/call": ["tools:read"],
    "tools/call#create_pr": ["tools:admin"]
  },
  "auth": {
    "type": "oauth2_dpop",
    "metadata_url": "https://auth.example.com/.well-known/oauth-authorization-server"
  }
}
```

The `scopes_required` map is the key field: it tells the gateway which OAuth scopes are needed per method (and optionally per tool name, using the `#tool_name` suffix). The gateway uses this map to enforce RBAC without needing custom configuration per server — the policy is declared by the server itself.

---

## Configuring mcp-gateway

`mcp-gateway` is the reference OSS implementation. Install it:

```bash
pip install mcp-gateway        # Python variant
# or
npm install -g @mcp/gateway    # Node variant
```

The gateway is configured with a single YAML file:

```yaml
# gateway.yaml
listen: ":8080"

auth:
  jwks_uri: "https://auth.example.com/.well-known/jwks.json"
  audience: "mcp-github"
  dpop_required: true

servers:
  - name: github
    upstream: "http://localhost:9000"
    discovery: "http://localhost:9000/.well-known/mcp.json"
    refresh_interval_s: 300

rate_limits:
  default:
    requests_per_minute: 60
    burst: 10
  scopes:
    tools:admin:
      requests_per_minute: 20
      burst: 5

audit:
  output: "/var/log/mcp/audit.jsonl"
  fields:
    - timestamp
    - request_id
    - user_sub
    - tool_name
    - args_hash
    - result_status
    - duration_ms
    - gateway_id
```

Start the gateway:

```bash
mcp-gateway start --config gateway.yaml
```

The gateway will discover the upstream server's capabilities via `.well-known/mcp.json`, configure RBAC from the `scopes_required` map, and begin listening on port 8080.

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="You are an SRE reviewing an mcp-gateway YAML config. Identify any missing security-critical fields in this config:\n\nlisten: ':8080'\nauth:\n  jwks_uri: 'https://auth.example.com/.well-known/jwks.json'\n  audience: 'mcp-github'\nservers:\n  - name: github\n    upstream: 'http://localhost:9000'\nrate_limits:\n  default:\n    requests_per_minute: 100\naudit:\n  output: '/var/log/mcp/audit.jsonl'"
  expectedOutput="The model should flag: (1) dpop_required is missing — tokens would be accepted as plain bearer tokens; (2) discovery is missing — the gateway won't auto-update RBAC when the server's .well-known changes; (3) the rate limit of 100 rpm is high with no burst cap — easier to flood."
/>

---

## RBAC: scopes, tools, and the least-privilege rule

RBAC in MCP is scope-based: the OAuth access token carries a set of scopes, and the gateway checks them against the `scopes_required` map from `.well-known/mcp.json` before forwarding the request.

The two canonical scopes are:

| Scope | What it allows |
|---|---|
| `tools:read` | `tools/list`, `tools/call` on read-only tools, `resources/read` |
| `tools:admin` | All of the above + `tools/call` on write/destructive tools (e.g., `create_pr`, `delete_branch`) |

The mapping in `scopes_required` lets you be surgical:

```json
"scopes_required": {
  "tools/list": ["tools:read"],
  "tools/call": ["tools:read"],
  "tools/call#create_pr": ["tools:admin"],
  "tools/call#delete_branch": ["tools:admin"]
}
```

A user with only `tools:read` can call `list_repos` and `read_file`, but gets a `403 Forbidden` when they try to call `create_pr`. The gateway enforces this transparently — the server doesn't need to check scopes itself.

### Assigning scopes at the authorization server

When your auth server issues tokens (from [[04-oauth-dpop-auth|Chapter 4]]'s `.well-known/oauth-authorization-server`), it grants scopes based on user role. A simple mapping:

| User role | Granted scopes |
|---|---|
| Developer | `tools:read` |
| Senior Dev / Ops | `tools:read tools:admin` |
| CI/CD service account | `tools:read` |
| Security auditor | `tools:read` (read-only, audit view) |

This is the **least-privilege principle** applied to MCP: you grant the minimum scope needed for the job. A CI/CD pipeline that only reads file contents should never have `tools:admin`.

<KnowledgeCheck
  question="A developer has an access token with scope `tools:read`. They call `tools/call` on the `delete_branch` tool, which has `tools/call#delete_branch: ['tools:admin']` in the server's .well-known/mcp.json. What response does the gateway return?"
  options={[
    "200 OK — the gateway forwards the request to the upstream server",
    "401 Unauthorized — the token is invalid",
    "403 Forbidden — the token is valid but lacks the required scope",
    "404 Not Found — the tool is hidden from users without admin scope"
  ]}
  correctIdx={2}
  explanation="The gateway validates the DPoP token first (token is valid → not a 401), then checks scopes against the .well-known map. The token carries tools:read, but delete_branch requires tools:admin → 403 Forbidden. The tool is not hidden — it appears in tools/list — but calling it requires elevated scope. This is intentional: users can see what they're missing and request the right access, rather than being confused by silent tool omission."
/>

---

## Structured audit logging for SOC 2

A SOC 2 Type II audit requires that you can answer five questions about any system action:

1. **Who** performed it (identity, non-repudiable)
2. **What** they did (action and target)
3. **When** they did it (timestamp, UTC, sub-second)
4. **With what** (parameters — or at minimum a hash of parameters to avoid logging PII)
5. **What happened** (result: success, failure, partial)

MCP gateway audit logs answer all five. Here's the schema:

```json
{
  "timestamp": "2026-04-30T14:23:11.847Z",
  "request_id": "req_01HZXKV2G3FMRNT8QKJW5P",
  "gateway_id": "gw-prod-us-east-1-01",
  "user_sub": "user|8f3d2a1c",
  "client_id": "claude-desktop",
  "tool_name": "create_pr",
  "args_hash": "sha256:e3b0c44298fc1c149afb",
  "result_status": "success",
  "duration_ms": 342,
  "http_status": 200,
  "scope_used": "tools:admin",
  "upstream": "github"
}
```

Key design decisions in this schema:

- **`args_hash`** not `args`: never log raw tool arguments. Tool arguments frequently contain secrets (API keys passed as context), PII (user-provided queries), or IP-sensitive business data. Hash them for audit correlation without data exposure. SHA-256 of the serialized JSON args is sufficient.
- **`user_sub`** from the DPoP token, not from a header. This is non-repudiable: the subject claim in a DPoP-bound access token is cryptographically tied to the client's private key.
- **`request_id`** is a gateway-generated ULID (Universally Unique Lexicographically Sortable Identifier) — not a UUID. ULIDs sort chronologically, which makes log queries dramatically faster when you're scanning a time range.
- **`duration_ms`** covers gateway-to-upstream round-trip, not end-to-end client latency. This lets you distinguish slow tool execution from slow network.

### Adding the server-side audit hook

Even with a gateway, add a thin audit hook to your server for defense-in-depth — logs that capture what the server *actually processed*, not just what the gateway forwarded:

```python
import json
import time
import hashlib
import sys
from datetime import datetime, timezone

def audit_log(tool_name: str, args: dict, result_status: str, user_sub: str, duration_ms: float):
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": "mcp-server",
        "tool_name": tool_name,
        "args_hash": "sha256:" + hashlib.sha256(
            json.dumps(args, sort_keys=True).encode()
        ).hexdigest()[:20],
        "result_status": result_status,
        "user_sub": user_sub,
        "duration_ms": round(duration_ms, 2),
    }
    # JSON Lines: one object per line, to stderr (not stdout — stdout is the MCP channel)
    print(json.dumps(entry), file=sys.stderr, flush=True)
```

> **Important**: MCP servers using stdio transport write audit logs to `stderr`, not `stdout`. `stdout` is the MCP JSON-RPC channel; writing anything to it other than valid JSON-RPC responses will corrupt the stream. The [[02-json-rpc-over-stdio|wire protocol chapter]] explains why.

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="I have an MCP server that logs audit entries to stderr as JSON Lines. Write a one-liner bash command that tails the audit log file at /var/log/mcp/audit.jsonl, filters for entries where tool_name is 'create_pr', and pretty-prints them. Use jq."
  expectedOutput="tail -f /var/log/mcp/audit.jsonl | jq 'select(.tool_name == \"create_pr\")'\n\nThe model might also offer a version that pretty-prints with color, e.g. adding --color-output or just relying on jq's default pretty-printing mode."
/>

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="You are an MCP gateway configured with this RBAC policy:\n\n  tools:read → tools/list, tools/call (read tools)\n  tools:admin → all tools\n\nA request arrives with scope 'tools:read' for tool 'create_pr'. The server's .well-known says create_pr requires tools:admin.\n\nWrite the exact JSON-RPC error response the gateway should return, including the correct error code and a machine-readable error object that an MCP client can parse to show the user a meaningful message."
  expectedOutput="The model should return something like:\n{\n  'jsonrpc': '2.0',\n  'id': '<request-id>',\n  'error': {\n    'code': -32000,\n    'message': 'Insufficient scope',\n    'data': {\n      'required_scope': 'tools:admin',\n      'granted_scope': 'tools:read',\n      'tool': 'create_pr'\n    }\n  }\n}\n\nNote: -32000 is the JSON-RPC application error range. The error.data object gives the client enough information to request elevated scope."
/>

---

## Rate limiting: protecting your servers and your budget

Rate limiting in an MCP gateway serves two purposes: protecting upstream servers from accidental (or intentional) flooding, and protecting your LLM API budget from runaway agents.

The token bucket algorithm is the right choice for MCP:

- Each user starts with `burst` tokens
- Tokens replenish at `requests_per_minute / 60` tokens per second
- Each request consumes one token
- When the bucket is empty, the gateway returns `429 Too Many Requests` with a `Retry-After` header

The `mcp-gateway` config from earlier sets:

```yaml
rate_limits:
  default:
    requests_per_minute: 60
    burst: 10
  scopes:
    tools:admin:
      requests_per_minute: 20
      burst: 5
```

`tools:admin` gets a tighter limit because write operations (creating PRs, deleting branches) are inherently more impactful per call. A runaway agent with admin scope that makes 20 calls/minute is more dangerous than one making 60 read calls/minute.

<Callout type="warn">
**Rate limits must be per-user, not per-IP.** MCP clients behind a corporate proxy or VPN all share an IP address. IP-based rate limiting will throttle your entire organization when one user runs a batch job. Use the `user_sub` claim from the DPoP token as the rate-limit key — it's user-level and non-repudiable.
</Callout>

### The `Retry-After` contract

When the gateway returns `429`, MCP clients should honor the `Retry-After` header:

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 14

{
  "jsonrpc": "2.0",
  "id": "abc123",
  "error": {
    "code": -32029,
    "message": "Rate limit exceeded",
    "data": {
      "retry_after_seconds": 14,
      "limit": "60/minute",
      "scope": "tools:read"
    }
  }
}
```

Well-behaved MCP clients (Claude Desktop, the Anthropic Python SDK) will back off and retry after the specified interval. Badly-behaved clients that retry immediately will hit the limit again and extend their backoff window.

<KnowledgeCheck
  question="Your MCP gateway is configured with IP-based rate limiting at 100 requests/minute. A developer runs a batch job that makes 50 calls/minute. Their colleague, sitting at the same office (same IP), is trying to use the same MCP server interactively and is getting 429 errors despite not hitting any limit themselves. What is wrong and how do you fix it?"
  options={[
    "The rate limit is too low — raise it to 200 requests/minute",
    "The batch job should use a different MCP server than interactive users",
    "Rate limiting is keyed on IP, so the batch job and the interactive user share the same bucket — switch to user_sub as the rate-limit key",
    "429 errors in this scenario are expected — the interactive user should retry"
  ]}
  correctIdx={2}
  explanation="IP-based rate limiting collapses all users behind the same NAT/proxy into one bucket. The batch job (50 calls/min) plus the interactive user push the shared bucket over 100/min. The fix is to key rate limits on user_sub from the DPoP token — each user gets their own independent bucket. The batch job and interactive user are then rate-limited independently, and neither affects the other."
/>

---

## The five production failure modes

These are the five patterns that actually end production MCP deployments. Each has a mitigation that's straightforward once you know what to look for.

### Failure mode 1: Token expiry mid-session

**What happens**: An access token issued at session start expires (typically 15–60 minutes for DPoP tokens) while the model is mid-conversation. The next `tools/call` returns `401`. The client doesn't know how to refresh, so the session dies silently — the user sees the tool return nothing, not an error.

**Mitigation**: MCP clients must implement proactive token refresh — refresh the token when `expires_in - current_time < 60s`, not reactively on 401. Your server and gateway should return the `WWW-Authenticate: Bearer realm="...", error="invalid_token"` header on 401 with enough detail for the client to trigger refresh. Include `token_expiry` in the audit log so you can detect sessions that die at the same time as token expiry.

### Failure mode 2: Gateway single point of failure

**What happens**: You run one gateway instance. It crashes at 2 AM. All MCP traffic fails for 45 minutes until someone restarts it. You don't notice until users complain.

**Mitigation**: Run at least two gateway instances behind a load balancer (Nginx, HAProxy, or your cloud provider's NLB). Gateways are stateless — they validate tokens, check RBAC, forward requests. No session state needs to be shared between instances. A two-instance active-active setup with health checks is sufficient for most deployments under 1,000 users. Add a `/health` endpoint to your gateway config and wire it to your load balancer.

### Failure mode 3: Session state leaking into horizontal scaling

**What happens**: A developer adds in-memory caching to their MCP server — perhaps caching a GitHub API token or a user's last-read file. Works fine with one instance. When you add a second instance behind the gateway, requests load-balance randomly between them, and the cache miss rate doubles while users see inconsistent behavior (tool succeeds on one request, fails on the next identical request).

**Mitigation**: MCP servers must be stateless across requests. The [[02-json-rpc-over-stdio|wire protocol]] is inherently stateless at the transport level — each JSON-RPC request carries all the context needed to respond. If you need caching, use an external cache (Redis, Memcached) keyed on the user_sub + tool arguments hash, with a short TTL (30–120 seconds). Never use in-process state for user-specific data.

### Failure mode 4: Audit log storage saturation

**What happens**: Your MCP server is generating one audit log entry per tool call. At 1,000 users making 60 calls/minute each, that's 60,000 lines/minute. Uncompressed JSONL at ~300 bytes/line is 18 MB/minute, 26 GB/day. Your `/var/log` partition fills in 24 hours and the server crashes.

**Mitigation**: Never write audit logs to a local file in production. Stream them to an observability backend from the start: Loki (if you're running Grafana), Datadog Logs, CloudWatch Logs, or Splunk. The mcp-gateway supports a `sink` configuration:

```yaml
audit:
  sink: loki
  loki_push_url: "http://loki:3100/loki/api/v1/push"
  loki_labels:
    app: mcp-gateway
    env: production
```

If you must use local files (air-gapped environments), configure `logrotate` with daily rotation, 7-day retention, and `compress` + `delaycompress`. But stream first.

### Failure mode 5: Rate-limit false positives under burst load

**What happens**: A legitimate user runs a script that makes 15 calls in quick succession (processing a batch of files). The token bucket is set to `burst: 10`, so the last 5 calls return `429`. The user assumes the server is broken and files a support ticket. The script crashes mid-batch and leaves resources in an inconsistent state.

**Mitigation**: Design burst headroom for legitimate use cases. A burst of 10 is appropriate for interactive use; a burst of 50–100 is appropriate if your use case includes batch operations. Differentiate rate limits by OAuth scope or client_id:

```yaml
rate_limits:
  clients:
    claude-desktop:
      burst: 10          # Interactive — small burst
    ci-pipeline:
      burst: 100         # Batch — large burst, same per-minute ceiling
```

Identify legitimate batch clients by their `client_id` claim in the token and give them a higher burst allowance without raising the per-minute ceiling.

---

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="You are reviewing a production MCP audit log stream. Here are three consecutive JSONL lines:\n\n{\"timestamp\":\"2026-04-30T14:23:11.847Z\",\"user_sub\":\"user|abc\",\"tool_name\":\"list_repos\",\"result_status\":\"success\",\"duration_ms\":312}\n{\"timestamp\":\"2026-04-30T14:23:12.001Z\",\"user_sub\":\"user|abc\",\"tool_name\":\"read_file\",\"result_status\":\"success\",\"duration_ms\":89}\n{\"timestamp\":\"2026-04-30T14:23:12.050Z\",\"user_sub\":\"user|abc\",\"tool_name\":\"delete_branch\",\"result_status\":\"success\",\"duration_ms\":201}\n\nThe third entry is suspicious. What is wrong, and what two fields should you add to the schema to make this detectable automatically?"
  expectedOutput="The third entry shows delete_branch succeeding for a user — but if RBAC is configured, this should only succeed if the user has tools:admin scope. The log doesn't record which scope was used to authorize the call, making it impossible to audit whether RBAC was enforced. Two fields to add: (1) scope_used — the actual scope present in the token at call time; (2) rbac_policy_version — the version of the .well-known/mcp.json that the RBAC check ran against. With scope_used, a SIEM can flag calls to admin tools where scope_used is 'tools:read', indicating a gateway misconfiguration."
/>

## Horizontal scaling and zero-downtime deployments

When you're ready to scale from one server instance to a team of 1,000, two properties must hold:

**1. Servers must be stateless**: covered above. Verify by running two instances simultaneously and sending alternating requests to each. If any response depends on which instance received the previous request, you have leaked state.

**2. Rolling deployments must be possible**: the gateway must support routing traffic to new server versions before the old ones shut down. `mcp-gateway` supports weighted upstream routing:

```yaml
servers:
  - name: github-v2
    upstream: "http://server-v2:9000"
    weight: 90
  - name: github-v1
    upstream: "http://server-v1:9000"
    weight: 10
```

Start with 10% traffic on the new version, watch the error rate and p99 latency in your audit logs, then ramp to 100% and drain v1. This is a standard blue-green pattern applied to MCP.

<KnowledgeCheck
  question="Describe in 2-3 sentences: what makes an MCP server safe to run behind a load balancer with two instances? Name one specific thing a developer might add to an MCP server that would break this property."
  options={["self-check"]}
  correctIdx={0}
  explanation="A safe MCP server is stateless: every request carries all the context needed to produce a correct response, regardless of which instance handles it. This works because the JSON-RPC protocol is inherently request-response — there's no server-side session. A developer might break this by adding an in-memory dictionary that caches a user's last-called tool result, or by storing an OAuth token refresh counter in a module-level variable. Both cause divergent behavior when requests land on different instances."
/>

---

## Hands-on exercise: gateway + RBAC + audit logs end-to-end

**Goal**: deploy the DPoP-enabled server from Chapter 4 behind `mcp-gateway`. Configure RBAC. Verify that `tools:read` users can list and call read tools but are rejected from admin tools. Capture one audit log line per call.

**Setup** (15 minutes):

```bash
# 1. Install mcp-gateway
pip install mcp-gateway

# 2. Create gateway.yaml (use the config from this chapter, pointing to your ch04 server)
cat > gateway.yaml <<'EOF'
listen: ":8080"

auth:
  jwks_uri: "http://localhost:8000/.well-known/jwks.json"
  audience: "mcp-local-dev"
  dpop_required: true

servers:
  - name: my-mcp-server
    upstream: "http://localhost:9000"
    discovery: "http://localhost:9000/.well-known/mcp.json"

rate_limits:
  default:
    requests_per_minute: 60
    burst: 10

audit:
  output: "/tmp/mcp-audit.jsonl"
  fields: [timestamp, request_id, user_sub, tool_name, args_hash, result_status, duration_ms]
EOF

# 3. Add .well-known/mcp.json to your ch04 server
# (add this as a GET route returning the discovery document)

# 4. Start both
python server.py &        # your ch04 server on :9000
mcp-gateway start --config gateway.yaml &   # gateway on :8080
```

**Test RBAC** (10 minutes):

```bash
# Mint a tools:read token (use your ch04 auth server or a local mock)
READ_TOKEN=$(./mint-token.sh --scope tools:read --sub "test-user-read")

# Test: tools/list should succeed
curl -X POST http://localhost:8080 \
  -H "Authorization: DPoP $READ_TOKEN" \
  -H "DPoP: $(./gen-dpop-proof.sh POST http://localhost:8080)" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Test: calling an admin tool should return 403
curl -X POST http://localhost:8080 \
  -H "Authorization: DPoP $READ_TOKEN" \
  -H "DPoP: $(./gen-dpop-proof.sh POST http://localhost:8080)" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"delete_branch","arguments":{"branch":"test"}}}'
# Expected: 403 with error code -32000, message "Insufficient scope"
```

**Verify audit logs** (5 minutes):

```bash
# Watch the audit log in real-time
tail -f /tmp/mcp-audit.jsonl | jq '.'

# After running the tests above, you should see entries like:
# {"timestamp":"2026-04-30T...","tool_name":"tools/list","result_status":"success","user_sub":"test-user-read",...}
# {"timestamp":"2026-04-30T...","tool_name":"delete_branch","result_status":"forbidden","user_sub":"test-user-read",...}
```

**Success criteria**:
- `tools/list` returns `200` with the read-only token
- `delete_branch` call returns `403` with `required_scope: tools:admin`
- Audit log has one entry per request with `user_sub`, `tool_name`, and `result_status`
- Log entries are valid JSONL (parseable by `jq`)

**Estimated time**: 30 minutes including setup.

---

## What's next

This is the final chapter of the course. You've now built every layer of a production MCP deployment:

- **Chapter 1**: Why MCP exists and the N×M problem it solves
- **Chapter 2**: The [[02-json-rpc-over-stdio|wire protocol]] — JSON-RPC frames, the initialize lifecycle, stdio vs. HTTP transport
- **Chapter 3**: [[03-tools-resources-prompts|Tools, Resources, and Prompts]] — the three primitives and the decision rule
- **Chapter 4**: [[04-oauth-dpop-auth|OAuth 2.1 + DPoP]] — auth that survives a security audit
- **Chapter 5** (this chapter): Gateways, RBAC, audit logs, and five failure modes you can now prevent

The **capstone project** takes everything you've built and assembles it into a single GitHub integration MCP server: `list_repos` (Tool), `read_file` (Resource with URI templating), `generate_commit_message` (Prompt), DPoP auth, gateway config, and 10 tests. You should be able to complete it in under 60 minutes.

---

## References

[^1]: MCP 2026 Roadmap — https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/ · retrieved 2026-04-30
[^2]: MCP Specification (2025-03-26) — https://spec.modelcontextprotocol.io/ · retrieved 2026-04-30
[^3]: RFC 9449: DPoP — Demonstration of Proof of Possession — https://datatracker.ietf.org/doc/html/rfc9449 · retrieved 2026-04-30
[^4]: RFC 8414: OAuth 2.0 Authorization Server Metadata — https://datatracker.ietf.org/doc/html/rfc8414 · retrieved 2026-04-30
[^5]: JSON Lines specification — https://jsonlines.org/ · retrieved 2026-04-30
[^6]: OAuth 2.1 Draft (draft-ietf-oauth-v2-1-12) — https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-12 · retrieved 2026-04-30
