---
course_slug: mcp-from-first-principles-to-production
title: "MCP from First Principles to Production: Why JSON-RPC over stdio beat WebSockets + OpenAPI"
status: g0-passed
author: course-author
level: Builder
vendor_tag: anthropic
target_audience: "Developers who have used at least one LLM API (Claude, GPT, Gemini) and want to build production-grade integrations using MCP. Familiar with REST APIs, basic auth flows, and terminal-driven workflows."
prerequisites:
  - "Comfortable with Python or TypeScript (examples are in both)"
  - "Used at least one LLM API (Claude, OpenAI, Gemini)"
  - "Familiar with REST API concepts (request/response, JSON, HTTP verbs)"
  - "Basic understanding of what a process and stdio pipe are"
learning_outcomes:
  - "Explain WHY MCP chose JSON-RPC over stdio instead of WebSockets or a REST+OpenAPI approach — and when that choice matters for your own architecture"
  - "Read and write a complete MCP server from scratch, handling the full JSON-RPC lifecycle over stdio and HTTP streaming"
  - "Choose the right MCP primitive (Tool, Resource, or Prompt) for any integration requirement with a written decision rule"
  - "Wire up OAuth 2.1 + DPoP auth on an MCP server so it rejects unauthorized requests and produces a full audit trail"
  - "Deploy an MCP server behind a gateway to a team of 1,000 users with structured logs, RBAC, and zero-downtime rollout"
total_duration_min: 235
chapter_count: 5
capstone_project_min: 60
related_blogs:
  - mcp-2026-roadmap-explained
  - anthropic-agent-sdk-april-rebrand
sources:
  - https://spec.modelcontextprotocol.io/
  - https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/
---

# MCP from First Principles to Production

## Why this course

Every MCP tutorial starts with a hello-world tool and a five-line SDK call. That's fine for demos. It's useless for production.

The real question developers hit at 3 AM is never "how do I call `mcp.tool()`?" — it's "why is my server dropping messages under load?" or "why did OAuth succeed but the gateway reject my request?" Answering those questions requires understanding *why* MCP was designed the way it was. Design rationale is the skeleton key: once you know why the spec chose JSON-RPC 2.0 over stdio rather than WebSocket + REST, every other decision in the protocol makes sense and the failure modes become predictable.

This course takes a different path. We start with the design problem MCP was solving, work through the wire protocol frame by frame, build intuition for the three primitives, then climb to production concerns — OAuth 2.1 with DPoP, gateways, and audit logs. By the end you'll have shipped a working MCP server that handles auth, scales behind a gateway, and produces logs your security team can actually audit.

## Course outline

### Chapter 1: Why MCP exists — the design problem it actually solves
- **Duration**: 35 min
- **Prerequisites**: course intro only
- **Learning objectives**:
  1. Articulate the "N×M integration problem" that motivated MCP's creation
  2. Compare MCP to three alternatives (custom REST adapters, WebSocket hub, OpenAPI spec) and name the specific failure mode of each
  3. Explain how the LSP (Language Server Protocol) lineage shaped MCP's architecture choices
  4. Identify which problems MCP deliberately does NOT try to solve (and why)
- **Key concepts**: N×M tool proliferation, protocol vs. API, LSP lineage, host/client/server triad, separation of concerns
- **Hands-on exercise**: Map three real integrations from your own work onto MCP's host/client/server model. For each: identify what would be a Tool vs. Resource vs. Prompt, and write one sentence explaining why.
- **Contrarian angle**: MCP is NOT the universal agent middleware most blog posts claim. It's a narrow protocol for one specific job — standardised context injection into LLM inference. Understanding the narrowness is what makes it powerful.

---

### Chapter 2: JSON-RPC over stdio — the wire protocol explained
- **Duration**: 45 min
- **Prerequisites**: Chapter 1
- **Learning objectives**:
  1. Decode a raw MCP message frame at the byte level: envelope, id, method, params
  2. Explain why JSON-RPC 2.0 (not REST, not gRPC, not WebSocket) was the right choice for local stdio transport
  3. Implement the full initialize → capabilities → request → response lifecycle by hand (no SDK)
  4. Explain when to use HTTP+SSE (now Streamable HTTP) transport instead of stdio, and what changes
- **Key concepts**: JSON-RPC 2.0 envelope structure, newline-delimited framing, stdio vs. HTTP streaming transport, capability negotiation, notification vs. request vs. response
- **Hands-on exercise**: Write a 60-line Python MCP server that handles `tools/list` and `tools/call` over stdio — no SDK, raw sys.stdin/sys.stdout. Verify it with a manual JSON-RPC call piped from the terminal.
- **Contrarian angle**: stdio is not a limitation. It's the feature. Stateless process lifecycle, zero network attack surface, trivially restartable — these are deliberate production properties, not dev-env shortcuts.

---

### Chapter 3: Tools, Resources, Prompts — the three primitives and the decision rule
- **Duration**: 40 min
- **Prerequisites**: Chapter 2
- **Learning objectives**:
  1. Define each of the three MCP primitives with a one-sentence crisp definition
  2. Apply the "who initiates, who controls, what mutates" decision rule to classify any integration requirement
  3. Design a Resources schema for a multi-document knowledge base with URI templating
  4. Write a Prompt template with arguments that a model can invoke by name
- **Key concepts**: Tools (model-initiated, side-effects OK), Resources (app-controlled, read-only data), Prompts (user-initiated templates), URI templating, resource subscriptions, control flow ownership
- **Hands-on exercise**: Given a GitHub integration spec (list repos, read file, create PR, generate commit message), classify each operation as Tool/Resource/Prompt with reasoning. Then implement the Resources endpoint for file reading with URI templating.
- **Contrarian angle**: Most developers overload Tools and ignore Resources entirely. That's wrong. Resources are the correct primitive for anything that looks like a data source — and getting this right dramatically reduces token waste and latency.

---

### Chapter 4: OAuth 2.1 + DPoP — production auth for MCP servers
- **Duration**: 55 min
- **Prerequisites**: Chapter 2, familiarity with OAuth 2.0 basics
- **Learning objectives**:
  1. Explain what OAuth 2.1 changes from 2.0 (PKCE mandatory, implicit grant removed) and why that matters for MCP
  2. Describe DPoP (Demonstration of Proof-of-Possession, SEP-1932) and why bearer tokens alone are insufficient for MCP gateways
  3. Implement an MCP server that validates DPoP-bound access tokens and returns structured auth errors
  4. Write the `.well-known/oauth-authorization-server` metadata endpoint required by the MCP auth spec
- **Key concepts**: OAuth 2.1, PKCE, DPoP proof JWTs, token binding, `WWW-Authenticate` challenge/response, `.well-known` metadata, Workload Identity Federation (SEP-1933)
- **Hands-on exercise**: Add auth to the server from Chapter 2. Validate a DPoP-bound access token on every `tools/call` request, return a properly structured `401` with `WWW-Authenticate` on failure, and log the token subject to stdout as structured JSON.
- **Contrarian angle**: "We're internal-only" is not a reason to skip DPoP. Token theft from memory dumps and log scraping is a real attack vector. DPoP is two-hour work that eliminates an entire class of credential-exfiltration risk.

---

### Chapter 5: Gateways, audit logs, and shipping to a 1,000-user team
- **Duration**: 60 min
- **Prerequisites**: Chapters 1–4
- **Learning objectives**:
  1. Explain the role of an MCP gateway vs. running servers directly (discovery, RBAC, rate limiting, audit)
  2. Configure a gateway with server discovery via `.well-known` metadata, RBAC policies, and per-user rate limits
  3. Produce a structured audit log stream (who called what tool with what args, at what time, with what result) that passes a SOC 2 audit template
  4. Describe the five most common production failure modes and their mitigations
- **Key concepts**: MCP gateway topology, `.well-known` server discovery, RBAC scopes, structured audit logging (JSON Lines), rate limiting, horizontal scaling without session state, rolling deployments
- **Hands-on exercise**: Deploy the auth-enabled MCP server from Chapter 4 behind a lightweight gateway (using `mcp-gateway` OSS or Nginx + Lua). Configure one RBAC policy that grants `tools:read` to regular users and `tools:admin` to ops. Emit one audit log line per tool call and pipe it to a local file. Verify with a curl test that unauthorized users are rejected.
- **Contrarian angle**: Most teams wait until 100 users before thinking about gateways. By then the audit trail is gone, RBAC is bolted on wrong, and the refactor takes a sprint. Start with gateway topology at day one — it's a 2-hour setup that saves a week later.

---

## Capstone project

**Build and deploy a production-ready MCP server for a GitHub integration.**

### Deliverable
A public GitHub repo containing:
- An MCP server (Python or TypeScript) implementing: `list_repos` (Tool), `read_file` (Resource with URI templating), `generate_commit_message` (Prompt)
- OAuth 2.1 + DPoP auth with `.well-known` metadata endpoint
- Structured JSON audit log on every tool call (timestamp, user sub, tool name, args hash, result status)
- Gateway config (nginx or mcp-gateway) with RBAC: `tools:read` for regular scope, `tools:admin` for write tools
- README with curl test commands that prove each primitive works and auth rejects bad tokens
- 10 tests (pytest or vitest) covering: capability negotiation, tool execution, resource fetch, auth rejection, audit log emission

### Verification criteria
- `tools/list` returns correct schema for all three primitives
- `tools/call list_repos` succeeds with valid DPoP token, fails with 401 on missing/invalid token
- `resources/read github://owner/repo/path/to/file` resolves correctly
- Audit log contains one line per call with required fields
- Gateway RBAC rejects `tools:read` scope from calling a write tool
- All 10 tests pass

### Estimated time: 60 min (for learners who completed all 5 chapters)

---

## Why this beats alternatives

Every other MCP course stops at "here's how to use the SDK." This one makes you understand the protocol so deeply that you can debug raw JSON-RPC frames, choose the right primitive for any requirement, and explain to your security team exactly what DPoP buys you and what it doesn't. That's the difference between a developer who ships MCP integrations and a developer who can own them.
