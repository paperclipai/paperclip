---
course_slug: mcp-from-first-principles-to-production
chapter_num: 4
chapter_slug: oauth-dpop-auth
title: "OAuth 2.1 + DPoP — production auth for MCP servers"
status: draft-for-review
author: Koenig Solutions
agent_drafted_by: claude-sonnet-4-6
vendor_tag: anthropic
content_type: course-chapter
date: 2026-04-30
duration_min: 55
prerequisites_chapters: [1, 2]
learning_objectives:
  - "Explain what OAuth 2.1 changes from OAuth 2.0 and why those changes matter specifically for MCP"
  - "Describe DPoP (Demonstration of Proof-of-Possession) and why bearer tokens alone are insufficient for MCP gateways"
  - "Implement an MCP server that validates DPoP-bound access tokens and returns structured auth errors"
  - "Write the .well-known/oauth-authorization-server metadata endpoint required by the MCP auth spec"
key_concepts: [OAuth 2.1, PKCE, DPoP, proof JWTs, token binding, WWW-Authenticate, .well-known metadata, Workload Identity Federation, bearer tokens, credential exfiltration]
hands_on_exercise: "Add DPoP auth validation to the Chapter 2 server: validate DPoP-bound access token on every tools/call, return structured 401 on failure, emit structured JSON audit log"
sources:
  - https://spec.modelcontextprotocol.io/
  - https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/authorization/
  - https://datatracker.ietf.org/doc/html/rfc9449
  - https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-15
  - https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/
  - https://datatracker.ietf.org/doc/html/rfc8414
---

# OAuth 2.1 + DPoP — production auth for MCP servers

OAuth 2.1 and DPoP together solve the production authentication problem for HTTP-based MCP servers: OAuth 2.1 tightens the grant flow (mandatory PKCE, no implicit grant), while DPoP cryptographically binds each access token to the client's private key so that a stolen token is useless without it. This chapter explains both mechanisms, implements DPoP validation on the Chapter 2 echo server, and covers the `.well-known/oauth-authorization-server` discovery endpoint required by compliant MCP clients.

> **Prerequisites**: [[01-why-mcp-exists|Chapter 1]] (architecture overview) and [[02-json-rpc-over-stdio|Chapter 2]] (wire protocol, the echo server). [[03-tools-resources-prompts|Chapter 3]] is helpful context but not required.
>
> **Time**: 55 minutes
>
> **What you'll be able to do**: By the end of this chapter, you can explain exactly what DPoP token binding prevents, implement a server that validates DPoP-bound access tokens on every tool call, and write the `.well-known` metadata endpoint that makes your server discoverable by compliant MCP clients. You'll also understand why "we're internal-only" is not a justification for skipping this step.

---

## Key facts

- **OAuth 2.1** is a consolidation of OAuth 2.0 (RFC 6749) that makes PKCE mandatory for all grants and removes the implicit grant and resource owner password credentials grant entirely.[^2]
- **DPoP** (RFC 9449) adds a proof JWT to every token request and API call that binds the access token to the client's public key — making stolen tokens useless without the matching private key.[^3]
- **The MCP auth spec** requires remote servers to expose a `/.well-known/oauth-authorization-server` metadata document (RFC 8414[^4]) that declares supported grant types, token endpoints, and capabilities.
- **Bearer token theft** is a real attack vector in MCP deployments: prompt injection attacks can cause models to leak token values into tool call arguments; log aggregators can inadvertently capture `Authorization` headers.
- **SEP-1932 (DPoP)** and **SEP-1933 (Workload Identity Federation)** are listed on the MCP roadmap as "On the Horizon" — community-driven work that maintainers are not yet actively initiating.[^1]
- **For stdio servers**: auth is process-level; the OS enforces that only the parent process can read from the subprocess's stdout. OAuth is only required for HTTP transport.

---

## The authentication problem MCP solved badly at first

The initial MCP specification shipped with a minimal auth story: for stdio servers, security came from process-level isolation (only the host that launched the process can talk to it); for HTTP servers, the spec recommended Bearer tokens but left the specifics up to implementors.

That gap creates real problems in HTTP deployments. Production MCP servers encounter Bearer token edge cases that the spec left unaddressed: tokens appearing in structured log pipelines, tokens exfiltrated via prompt injection into tool arguments, and multi-tenant servers accidentally accepting tokens issued for a different tenant because no standard binding validation existed.

The 2026 roadmap lists two SEPs (Specification Enhancement Proposals) to address this[^1]:
- **SEP-1932**: DPoP (Demonstration of Proof-of-Possession) as the mandatory binding mechanism for access tokens on remote MCP servers
- **SEP-1933**: Workload Identity Federation for machine-to-machine MCP server access

This chapter covers both the current auth spec[^5] and the SEP-1932 design so you're building for where the protocol is going, not where it was.

---

## OAuth 2.1: what changed and why it matters

OAuth 2.0 (2012) was designed for a world of server-rendered web apps and mobile apps with long-lived refresh tokens. Over the years, several of its grant types were found to have exploitable weaknesses. OAuth 2.1 is the IETF working group's response: a clean slate that incorporates the security best practices that evolved over the previous decade.[^2]

The changes that directly affect MCP server implementations:

### PKCE is now mandatory for all grant types

PKCE (Proof Key for Code Exchange, RFC 7636[^6]) was originally an optional extension for mobile apps to prevent authorization code interception attacks. OAuth 2.1 makes it mandatory for *all* authorization code grants, including server-to-server flows.

In practice: when an MCP client initiates an OAuth flow to get tokens for your server, it must include a `code_challenge` in the authorization request and a `code_verifier` in the token request. Your server's authorization endpoint must verify them. If your auth server doesn't implement PKCE, you're not OAuth 2.1 compliant, and SEP-1932-compliant MCP clients may refuse to proceed.

### Implicit grant removed

The OAuth 2.0 implicit grant returned access tokens directly in the URL fragment after authorization. This was convenient but deeply insecure: the token appeared in browser history, server logs, and `Referer` headers. It's removed in OAuth 2.1. MCP clients that use implicit grant to get tokens for your server will fail with OAuth 2.1 compliant authorization servers.

### Token lifetime requirements

OAuth 2.1 tightens guidance on refresh token rotation (one-time use) and recommends short-lived access tokens (minutes, not hours). This is directly relevant to MCP: a model inference session that runs for 30 minutes might hit token expiry mid-session. Your server needs to handle `401 Unauthorized` responses gracefully and trigger token refresh.

<Callout type="hot">
**The implicit grant removal breaks a common pattern**. Many internal tools implemented MCP auth using the implicit grant because it's simple — no server-side token exchange required. If you're using implicit grant today, you need to migrate to authorization code + PKCE before SEP-1932 lands. The migration is a one-time engineering effort, but leaving it until the SEP ships means a forced migration with a hard deadline.
</Callout>

<RunPromptCell
  model="claude-sonnet-4-6"
  system="You are an OAuth 2.1 implementation expert. Give practical, precise answers."
  prompt="Walk me through the exact sequence of messages in an OAuth 2.1 authorization code + PKCE flow for an MCP client requesting tokens for an MCP server. Include: (1) what the MCP client generates before redirecting to the authorization endpoint, (2) what parameters it includes in the authorization request, (3) what it sends in the token request, and (4) what the authorization server validates at the token exchange step."
  expectedOutput="The expert covers: (1) The client generates a cryptographically random code_verifier (43-128 URL-safe chars), then computes code_challenge = BASE64URL(SHA256(code_verifier)). (2) Authorization request includes: response_type=code, client_id, redirect_uri, scope, state (CSRF token), code_challenge, code_challenge_method=S256. (3) Token request sends: grant_type=authorization_code, the authorization code received from the redirect, the original redirect_uri, and code_verifier. (4) The authorization server validates: BASE64URL(SHA256(code_verifier)) must equal the stored code_challenge — if this check fails, the token request is rejected with error=invalid_grant. This prevents authorization code interception: a stolen code is useless without the code_verifier that only the legitimate client holds."
/>

<KnowledgeCheck
  question="An MCP client sends an authorization request to your OAuth 2.1 authorization server but omits the code_challenge parameter. What must a compliant authorization server do?"
  options={[
    "Accept it — PKCE is only mandatory for public clients (mobile/SPA), not confidential clients",
    "Reject the authorization request — PKCE with S256 is mandatory for ALL authorization code grants in OAuth 2.1",
    "Issue the authorization code but add a warning in the response",
    "Accept it but require the client to prove identity via client_secret instead"
  ]}
  correctIdx={1}
  explanation="OAuth 2.1 makes PKCE mandatory for ALL authorization code grants — there is no exception for confidential clients. This is a deliberate hardening: the authorization code interception attack works against any client that lacks PKCE, regardless of whether it's a mobile app or a server-side service. A compliant authorization server MUST reject authorization requests missing a code_challenge. If your internal auth server accepts them silently, it is not OAuth 2.1 compliant — a fact worth surfacing to your identity team before SEP-1932 mandates it."
/>

---

## Bearer tokens and why they're not enough

Before understanding DPoP, you need to understand what's wrong with Bearer tokens in the MCP context.

A Bearer token is exactly what the name implies: **whoever bears it wins**. The HTTP spec (RFC 6750) defines Bearer tokens with no binding between the token and the client that requested it. If an attacker steals your Bearer token — by reading it from a log, from a process's memory, from a misconfigured environment variable, or via prompt injection that causes the model to echo it in a tool call — they can use it from any machine, any location, with any client, until it expires.

In traditional web app contexts, Bearer tokens are acceptable because:
1. Token expiry is typically short (1 hour)
2. Transmission is over TLS, which makes interception hard
3. Tokens are used by human-operated clients, not automated pipelines

MCP changes the threat model:

**Prompt injection is a first-class attack vector**. An attacker who controls a document that gets loaded as a Resource can embed instructions that cause the model to include the contents of the `Authorization` header in a tool call response. The model follows the instructions; the tool response containing the token is logged by the host; the attacker extracts the token from the log.

**Multi-tenant HTTP servers share a token endpoint**. An MCP server serving multiple organisations may accept tokens from all of them. A Bearer token issued for Organisation A's MCP client, if leaked, can be used to call Organisation B's tools if the server's validation only checks token validity, not token binding.

**Long-running agentic sessions hold tokens for extended periods**. A 30-minute agent workflow holds an access token for 30 minutes. Bearer tokens valid for that window are high-value targets.

DPoP addresses all three.

---

## DPoP: how token binding works

DPoP (Demonstration of Proof-of-Possession, RFC 9449) adds a cryptographic binding between an access token and the client that requested it.[^3]

Here's the mechanism:

**Step 1: Key generation**. The MCP client generates an ephemeral asymmetric key pair (EC P-256 or RSA 2048) at session start. The private key stays in memory; the public key is included in a `DPoP-Proof` JWT header.

**Step 2: Token request with DPoP proof**. When requesting an access token from the OAuth server, the client sends a `DPoP` header containing a signed JWT that includes:
- `jwk`: the client's public key
- `htm`: the HTTP method of this request (`POST`)
- `htu`: the URL of this request (token endpoint)
- `iat`: issuance time
- `jti`: a unique identifier (prevents replay)

```
DPoP: eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand...
Authorization: (none yet, this is the token request)
```

**Step 3: Token issuance with binding**. The OAuth server validates the DPoP proof, then issues an access token that is cryptographically bound to the client's public key. The token's `cnf` (confirmation) claim contains a `jkt` (JWK Thumbprint) — a fingerprint of the client's public key:

```json
{
  "sub": "user-alice@example.com",
  "scope": "tools:read",
  "exp": 1714600000,
  "cnf": {
    "jkt": "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I"
  }
}
```

**Step 4: API calls with DPoP proof**. Every API call to the MCP server includes both the access token AND a new DPoP proof JWT (this one includes `ath` — a hash of the access token, binding the proof to the specific token):

```http
POST /mcp HTTP/1.1
Authorization: DPoP eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand...
DPoP: eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3AiLCJqd2siOnsiY3...
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/call",...}
```

**Step 5: Server validation**. The MCP server validates:
1. The `Authorization: DPoP <token>` is a valid access token (signature, expiry, audience)
2. The `DPoP` header is a valid DPoP proof JWT
3. The DPoP proof's public key matches the `cnf.jkt` claim in the access token
4. The `htm` and `htu` in the DPoP proof match the current request's method and URL
5. The `iat` is recent (within a small window, e.g. 60 seconds — prevents replay)
6. The `jti` hasn't been seen before (nonce-based replay protection)

If an attacker steals the access token from a log, they can't use it. Using it requires a DPoP proof signed by the matching private key, which never left the client.

<RunPromptCell
  model="claude-sonnet-4-6"
  system="You are a security engineer specialising in OAuth and JWT. Give precise, technical answers."
  prompt="A developer argues: 'We run our MCP server over TLS and our Bearer tokens expire in 15 minutes. That's secure enough — we don't need DPoP.' Evaluate this argument. What specific attacks does DPoP prevent that short-lived Bearer tokens over TLS do not? Give three concrete attack scenarios."
  expectedOutput="The security engineer names: (1) Prompt injection exfiltration — TLS protects the transport, not the application layer; a prompt injection attack causes the model to emit the token value in a tool response or reasoning trace, bypassing TLS entirely. A 15-minute window is plenty for an automated exfiltration. (2) Log scraping — structured logging pipelines sometimes capture Authorization headers; a stolen token from logs can be used within the 15-minute window. DPoP makes this useless since the attacker doesn't have the private key. (3) SSRF pivot — a Server-Side Request Forgery attack that tricks the MCP server into forwarding a request to an internal service, potentially including the Authorization header. DPoP binding means even if the token is forwarded, it's only valid for the original server's URL (the `htu` claim in the DPoP proof must match)."
/>

---

## Implementing the .well-known metadata endpoint

Before clients can authenticate against your server, they need to know where the authorization endpoints are. The MCP auth spec requires remote servers to expose an RFC 8414-compliant metadata document at `/.well-known/oauth-authorization-server`.[^4]

Here's the minimal required document:

```json
{
  "issuer": "https://mcp.yourcompany.com",
  "authorization_endpoint": "https://auth.yourcompany.com/authorize",
  "token_endpoint": "https://auth.yourcompany.com/token",
  "jwks_uri": "https://auth.yourcompany.com/.well-known/jwks.json",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_basic"],
  "dpop_signing_alg_values_supported": ["ES256", "RS256"],
  "scopes_supported": ["tools:read", "tools:write", "resources:read"],
  "subject_types_supported": ["public"]
}
```

Key fields:
- `dpop_signing_alg_values_supported` — declares that this server accepts DPoP proofs. If absent, clients may fall back to Bearer-only.
- `code_challenge_methods_supported: ["S256"]` — declares PKCE with SHA-256 only (`plain` is insecure and should not be listed).
- `scopes_supported` — the tool scopes your server recognises. Chapter 5 maps these to RBAC policies.

In Python (adding to your HTTP MCP server):

```python
from http.server import HTTPServer, BaseHTTPRequestHandler
import json

WELL_KNOWN = {
    "issuer": "https://mcp.yourcompany.com",
    "authorization_endpoint": "https://auth.yourcompany.com/authorize",
    "token_endpoint": "https://auth.yourcompany.com/token",
    "jwks_uri": "https://auth.yourcompany.com/.well-known/jwks.json",
    "response_types_supported": ["code"],
    "grant_types_supported": ["authorization_code", "refresh_token"],
    "code_challenge_methods_supported": ["S256"],
    "dpop_signing_alg_values_supported": ["ES256"],
    "scopes_supported": ["tools:read", "tools:write", "resources:read"],
}

class MCPHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/.well-known/oauth-authorization-server":
            body = json.dumps(WELL_KNOWN).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()
```

<RunPromptCell
  model="claude-sonnet-4-6"
  system="You are a developer integrating an MCP server with a production OAuth 2.1 authorization server."
  prompt="My team is asking why I need to include 'dpop_signing_alg_values_supported': ['ES256'] in the .well-known/oauth-authorization-server metadata when our current MCP clients don't use DPoP yet. What is the operational benefit of declaring DPoP support in the metadata before all clients support it? What happens to a SEP-1932-compliant client if the field is omitted?"
  expectedOutput="The developer explains: Declaring dpop_signing_alg_values_supported signals that the server is DPoP-capable, enabling progressive adoption — DPoP-capable clients will use it, while legacy clients fall back to Bearer (if the server still permits both). Without the field, a SEP-1932-compliant client following metadata discovery will assume DPoP is not supported and either fall back to Bearer-only or refuse to connect entirely, depending on its policy. Including the field costs nothing: it's a metadata field, not a code change. It also future-proofs your deployment — when DPoP becomes mandatory in a spec revision, no metadata update is needed. Early declaration is how the ecosystem bootstraps a new security mechanism without a hard flag-day cutover."
/>

---

## Implementing DPoP validation in the MCP server

Here's a production-oriented DPoP validation implementation. This adds to the Chapter 2 echo server, extended to HTTP transport.

```python
import time
import hashlib
import base64
import json
from typing import Optional
import jwt  # pip install PyJWT[crypto]
from cryptography.hazmat.primitives.asymmetric.ec import ECDSA
from cryptography.hazmat.primitives import hashes

# In production: use a proper nonce store with TTL (Redis, memcached)
# This in-memory set is for illustration only
_used_jti: set = set()

class DPoPValidationError(Exception):
    def __init__(self, message: str, error_code: str):
        super().__init__(message)
        self.error_code = error_code  # e.g. "invalid_dpop_proof", "use_dpop_nonce"

def validate_dpop_proof(
    dpop_header: str,
    access_token: str,
    method: str,
    url: str,
    max_age_seconds: int = 60
) -> dict:
    """
    Validate a DPoP proof JWT per RFC 9449.
    Returns the decoded DPoP payload on success.
    Raises DPoPValidationError on any validation failure.
    """
    try:
        # Decode header without verification first (to get the JWK)
        unverified_header = jwt.get_unverified_header(dpop_header)
    except jwt.DecodeError as e:
        raise DPoPValidationError(f"Cannot decode DPoP header: {e}", "invalid_dpop_proof")

    if unverified_header.get("typ") != "dpop+jwt":
        raise DPoPValidationError("DPoP JWT must have typ=dpop+jwt", "invalid_dpop_proof")

    jwk = unverified_header.get("jwk")
    if not jwk:
        raise DPoPValidationError("DPoP JWT must contain jwk in header", "invalid_dpop_proof")

    # Load the public key from JWK
    try:
        from cryptography.hazmat.primitives.serialization import load_der_public_key
        from jwt.algorithms import ECAlgorithm
        public_key = ECAlgorithm.from_jwk(json.dumps(jwk))
    except Exception as e:
        raise DPoPValidationError(f"Invalid JWK in DPoP header: {e}", "invalid_dpop_proof")

    # Verify signature and decode payload
    try:
        payload = jwt.decode(
            dpop_header,
            public_key,
            algorithms=["ES256", "RS256"],
            options={"verify_exp": False}  # We check iat manually
        )
    except jwt.InvalidSignatureError:
        raise DPoPValidationError("DPoP proof signature invalid", "invalid_dpop_proof")

    # Validate htm (HTTP method) and htu (HTTP URI)
    if payload.get("htm", "").upper() != method.upper():
        raise DPoPValidationError(
            f"DPoP htm mismatch: expected {method}, got {payload.get('htm')}",
            "invalid_dpop_proof"
        )
    if payload.get("htu", "") != url:
        raise DPoPValidationError(
            f"DPoP htu mismatch: expected {url}, got {payload.get('htu')}",
            "invalid_dpop_proof"
        )

    # Validate iat (freshness, prevent replay)
    iat = payload.get("iat", 0)
    now = int(time.time())
    if abs(now - iat) > max_age_seconds:
        raise DPoPValidationError(
            f"DPoP proof too old or too new: iat={iat}, now={now}",
            "invalid_dpop_proof"
        )

    # Validate jti (uniqueness, prevent replay)
    jti = payload.get("jti")
    if not jti:
        raise DPoPValidationError("DPoP proof missing jti", "invalid_dpop_proof")
    if jti in _used_jti:
        raise DPoPValidationError(f"DPoP jti already used: {jti}", "invalid_dpop_proof")
    _used_jti.add(jti)

    # Validate ath (access token hash)
    expected_ath = base64.urlsafe_b64encode(
        hashlib.sha256(access_token.encode()).digest()
    ).rstrip(b"=").decode()
    if payload.get("ath") != expected_ath:
        raise DPoPValidationError("DPoP ath (access token hash) mismatch", "invalid_dpop_proof")

    return payload


def build_www_authenticate_header(error: str, error_desc: str) -> str:
    """Build a RFC 9449-compliant WWW-Authenticate header for DPoP failures."""
    return (
        f'DPoP realm="mcp-server", '
        f'error="{error}", '
        f'error_description="{error_desc}", '
        f'algs="ES256"'
    )


def extract_dpop_token(auth_header: str) -> Optional[str]:
    """Extract access token from 'DPoP <token>' Authorization header."""
    if not auth_header or not auth_header.startswith("DPoP "):
        return None
    return auth_header[5:].strip()
```

**Wiring into the MCP request handler**:

```python
import sys
import time

def handle_mcp_request(auth_header: str, dpop_header: str, request_url: str, msg: dict) -> dict:
    """
    Validates auth before processing MCP message.
    Returns a JSON-RPC error response if auth fails.
    """
    access_token = extract_dpop_token(auth_header)
    if not access_token:
        return {
            "jsonrpc": "2.0", "id": msg.get("id"),
            "error": {"code": -32000, "message": "Missing or invalid Authorization header. Expected: DPoP <token>"}
        }

    try:
        dpop_payload = validate_dpop_proof(
            dpop_header=dpop_header,
            access_token=access_token,
            method="POST",
            url=request_url
        )
    except DPoPValidationError as e:
        # Log the failure to stderr as structured JSON for audit
        audit_entry = {
            "ts": time.time(),
            "event": "auth_failure",
            "error_code": e.error_code,
            "error": str(e),
            "method": msg.get("method"),
        }
        print(json.dumps(audit_entry), file=sys.stderr)
        return {
            "jsonrpc": "2.0", "id": msg.get("id"),
            "error": {"code": -32001, "message": str(e), "data": {"error_code": e.error_code}}
        }

    # Auth passed — emit audit log line
    token_sub = "unknown"
    try:
        # Decode without verification (we already verified via DPoP chain)
        decoded = jwt.decode(access_token, options={"verify_signature": False})
        token_sub = decoded.get("sub", "unknown")
    except Exception:
        pass

    audit_entry = {
        "ts": time.time(),
        "event": "tool_call",
        "sub": token_sub,
        "method": msg.get("method"),
        "tool": msg.get("params", {}).get("name"),
        "args_hash": hashlib.sha256(
            json.dumps(msg.get("params", {}).get("arguments", {}), sort_keys=True).encode()
        ).hexdigest()[:16]
    }
    print(json.dumps(audit_entry), file=sys.stderr)

    # Proceed with normal MCP handling
    return handle(msg)
```

<RunPromptCell
  model="claude-sonnet-4-6"
  system="You are a security engineer reviewing MCP authentication code. Be specific about what can go wrong."
  prompt="Review this DPoP validation implementation. The code uses an in-memory set (_used_jti) to prevent JTI replay. What are the three most important production problems with this approach, and how would you fix each one?"
  expectedOutput="The engineer identifies: (1) In-memory JTI store is not shared across server instances — in a horizontally-scaled deployment, a replay attack can succeed by sending the duplicate JTI to a different instance. Fix: use Redis with TTL equal to the DPoP proof max_age window. (2) The set grows unboundedly — in production, old JTIs from minutes ago should be evicted. Fix: use a TTL-keyed store. (3) Server restart loses all JTIs — a replay of recently-used JTIs succeeds after a restart. Fix: persist the JTI store to durable storage, or accept this as a known trade-off for stateless deployments and document it."
/>

<KnowledgeCheck
  question="Your MCP server receives this HTTP request: Authorization: Bearer eyJhbGci... (no DPoP header). Your server is configured to require DPoP. What is the correct response?"
  options={[
    "Accept it — Bearer tokens are valid OAuth 2.1",
    "Return HTTP 401 with WWW-Authenticate: DPoP realm='mcp-server', error='use_dpop_nonce', algs='ES256'",
    "Return HTTP 403 Forbidden",
    "Return HTTP 400 Bad Request with a JSON body"
  ]}
  correctIdx={1}
  explanation="RFC 9449 and the MCP auth spec require the server to respond with HTTP 401 and a WWW-Authenticate header that includes the DPoP scheme. The error field 'use_dpop_nonce' (or in this case, indicating DPoP is required) signals to compliant clients exactly what they need to provide. HTTP 403 would imply the client is authenticated but lacks permission — wrong here, since the issue is missing authentication. HTTP 400 is for malformed requests. The correct response is 401 with the WWW-Authenticate header specifying DPoP requirements."
/>

---

## Hands-on exercise

**Add DPoP validation to the Chapter 2 echo server.**

**Goal**: Extend the Python echo server to run as an HTTP server. Add DPoP validation on every `tools/call` request. Return a structured 401 on any auth failure. Emit one structured JSON audit log line per validated call.

**Steps**:

1. Copy the DPoP validation functions above into your echo server.

2. Add an HTTP endpoint (`POST /mcp`) that validates DPoP before dispatching. The critical 401 path must include a `WWW-Authenticate` header:

```python
class MCPHTTPHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/mcp":
            self.send_response(404); self.end_headers(); return

        auth_header = self.headers.get("Authorization", "")
        dpop_header = self.headers.get("DPoP", "")
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))

        access_token = extract_dpop_token(auth_header)
        if not access_token or not dpop_header:
            self.send_response(401)
            self.send_header(
                "WWW-Authenticate",
                'DPoP realm="mcp-server", algs="ES256"'
            )
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "jsonrpc": "2.0", "id": body.get("id"),
                "error": {"code": -32000, "message": "DPoP authorization required"}
            }).encode())
            return

        try:
            validate_dpop_proof(dpop_header, access_token, "POST",
                                f"http://localhost:8080/mcp")
        except DPoPValidationError as e:
            self.send_response(401)
            self.send_header("WWW-Authenticate",
                             build_www_authenticate_header(e.error_code, str(e)))
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "jsonrpc": "2.0", "id": body.get("id"),
                "error": {"code": -32001, "message": str(e)}
            }).encode())
            return

        # Auth passed — dispatch normally
        result = handle(body)
        resp = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)
```

3. Add the `/.well-known/oauth-authorization-server` endpoint from the earlier section.

4. Add the `GET` handler for:
   ```
   GET /.well-known/oauth-authorization-server
   → 200 + WELL_KNOWN JSON
   ```

**Testing** (using curl to simulate a request with a fake token — DPoP validation will fail, confirming the 401 path works):

```bash
# Start your server on port 8080
python3 echo_server_http.py &

# Verify .well-known endpoint
curl -s http://localhost:8080/.well-known/oauth-authorization-server | jq .

# Test tools/call without auth (should return 401)
curl -s -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello"}}}' | jq .

# Confirm audit log (stderr) shows auth_failure event
```

**Verification criteria**:
- `.well-known` returns valid JSON with `dpop_signing_alg_values_supported`
- Unauthenticated `tools/call` returns HTTP 401 with `WWW-Authenticate: DPoP ...` header
- Audit log (stderr) contains one JSON line per request with `event`, `ts`, and `error_code` fields

**Estimated time**: 20 minutes.

<KnowledgeCheck
  question="In your own words: explain to a colleague why 'we only use this server internally, behind our VPN' is not a sufficient reason to skip DPoP. Name one specific attack path that VPN protection does not block."
  options={["self-check"]}
  correctIdx={0}
  explanation="Strong answers identify that prompt injection attacks bypass network-level controls entirely. An attacker who can influence a document that gets loaded into an MCP server's context (via Resources) can craft an injection payload that causes the model to echo the access token into a tool call response. Since the injection happens at the application layer, VPN protection is irrelevant — the attacker is already 'inside' the conversation context. DPoP makes this exfiltration worthless because the stolen token cannot be used without the client's private key."
/>

---

## What's next

In [[05-gateways-audit-logs|Chapter 5]], we take the auth-enabled server from this chapter and put it behind a gateway. You'll configure RBAC so that `tools:read` scope can only call read tools and `tools:admin` scope is required for write tools. You'll set up structured audit logging that meets a SOC 2 audit template, and you'll deploy with zero downtime using rolling restarts behind the gateway.

---

## References cited

[^1]: MCP 2026 Roadmap — https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/ · retrieved 2026-04-30

[^2]: The OAuth 2.1 Authorization Framework (draft-ietf-oauth-v2-1-15) — https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-15 · retrieved 2026-04-30

[^3]: RFC 9449: OAuth 2.0 Demonstrating Proof of Possession (DPoP) — https://datatracker.ietf.org/doc/html/rfc9449 · retrieved 2026-04-30

[^4]: RFC 8414: OAuth 2.0 Authorization Server Metadata — https://datatracker.ietf.org/doc/html/rfc8414 · retrieved 2026-04-30

[^5]: Model Context Protocol Specification — https://spec.modelcontextprotocol.io/ · retrieved 2026-04-30

[^6]: RFC 7636: Proof Key for Code Exchange by OAuth Public Clients — https://datatracker.ietf.org/doc/html/rfc7636 · retrieved 2026-04-30

- MCP Authorization Specification — https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/authorization/ · retrieved 2026-04-30
