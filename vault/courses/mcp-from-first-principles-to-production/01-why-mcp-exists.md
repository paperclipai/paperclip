---
chapter_num: 1
course_slug: mcp-from-first-principles-to-production
title: "Why MCP exists — the design problem it actually solves"
status: awaiting-g0
author: course-author
ticket: KOE-36
learning_objectives:
  - "Articulate the N×M integration problem that motivated MCP's creation"
  - "Compare MCP to three alternatives (custom REST adapters, WebSocket hub, OpenAPI spec) and name the specific failure mode of each"
  - "Explain how the LSP (Language Server Protocol) lineage shaped MCP's architecture choices"
  - "Identify which problems MCP deliberately does NOT try to solve, and why"
prerequisites_chapters: []
duration_min: 35
level: Builder
vendor_tag: anthropic
sources:
  - https://spec.modelcontextprotocol.io/
  - https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/
  - https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
  - https://www.jsonrpc.org/specification
  - https://github.com/modelcontextprotocol/specification/issues
tags:
  - mcp
  - protocol
  - json-rpc
  - lsp
  - architecture
  - vendor/anthropic
---

# Why MCP exists — the design problem it actually solves

The **Model Context Protocol (MCP)** is an open, vendor-neutral protocol introduced by Anthropic on 25 November 2024 for standardising how AI applications connect to external data sources and tools through a JSON-RPC 2.0 wire format over stdio or HTTP transports.[^1] By April 2026, the protocol had attracted integrations from multiple AI development platforms, with the official 2026 roadmap charting its trajectory for remote-server authentication and gateway discovery.[^2]

Most tutorials start with a hello-world tool call and a five-line SDK import. That's fine for demos. It doesn't explain why the protocol is shaped the way it is, and without that, every 3 AM debugging session feels like archaeology. This chapter answers the *why*: what design constraint forced a specific set of decisions, what alternatives were rejected and for which precise reasons, and what problems MCP explicitly does not attempt to solve. Once that picture is clear, the rest of the specification reads like a logical consequence rather than a set of arbitrary choices.

---

## Key facts

- **Announced**: 25 November 2024 by Anthropic; specification published at `spec.modelcontextprotocol.io`.[^1]
- **Wire protocol**: JSON-RPC 2.0 (newline-delimited) over stdio or HTTP+SSE (Streamable HTTP); not REST, not WebSocket, not gRPC.[^1]
- **Three primitives**: Tools (model-initiated side-effects), Resources (app-controlled read-only data), Prompts (user-initiated templates).[^1]
- **LSP lineage**: Architecture is explicitly modelled on the Language Server Protocol, which solved the identical N×M problem for editors in 2016.[^3]
- **Auth trajectory**: The 2026 roadmap targets OAuth 2.1 + DPoP token binding (SEP-1932, an active proposal) for remote-server authentication, plus gateway discovery via `.well-known` metadata.[^2]
- **Adoption baseline (April 2026)**: Claude.ai ships MCP natively; multiple AI development platforms and IDEs have announced MCP-compatible integrations.[^1]
- **Governance**: Specification is Apache 2.0. Anthropic chairs the working group but does not hold exclusive change authority.

---

## The N×M integration problem

Before MCP existed, every team building an LLM application faced the same structural trap.

Suppose you are building an AI coding assistant. Your users need the model to read GitHub repos, query Jira tickets, pull documentation from Confluence, run tests in CI, and check Datadog metrics. That's five integrations. Each integration requires: understanding the third-party API, writing an adapter that maps the API's response shape to whatever JSON structure your model prefers, handling auth (likely OAuth for each service), dealing with pagination, and managing error recovery. Each adapter is bespoke code that belongs to your application and nobody else's.

Now suppose a second team is building an AI support agent. They need the same five integrations plus Salesforce and Zendesk. They repeat the work. A third team building an AI DevOps assistant needs most of the same integrations again. The result is N applications × M tools = **N×M integrations**, each implemented slightly differently, each with its own bugs, its own auth model, and its own failure modes.

This isn't a hypothetical. In the period leading up to MCP's launch, teams building on Claude and other LLMs had each written bespoke integration adapters for every tool they needed — a landscape of redundant, incompatible implementations, each solving the same underlying problem in isolation.[^1] Every major LLM provider observed the same fragmentation pattern. The ecosystem was splitting along exactly the axis that makes tooling ecosystems fail: each participant solving the same local problem independently, without a shared protocol layer.

The textbook fix for N×M proliferation is to insert a standard: instead of N×M direct connections, you get N+M relationships to a common interface. That is exactly what MCP does for LLM tool integrations.

<Callout type="info">
**The N×M problem is not new to software.** It appeared in compiler design (solved by LLVM's IR layer), in video codec support (solved by DirectShow/GStreamer), and famously in editor language support — which is where MCP's direct intellectual ancestors come from. See [[glossary/mcp]] for the protocol's formal definition and adoption timeline.
</Callout>

---

## Three alternatives that didn't survive contact with reality

The N×M framing explains *that* a protocol was needed. It doesn't explain why MCP looks the way it does. For that, you need to understand what was rejected and why.

### Alternative 1: Custom REST adapters (the status quo before MCP)

The simplest approach is no approach: each LLM application team writes its own integration layer, calling third-party REST APIs directly and shaping the response JSON however suits the model's context window. Most of the bespoke adapters that proliferated before MCP followed this pattern.

**The specific failure mode**: REST APIs are designed for human-operated software clients with stable lifecycles. They assume: a long-lived HTTP connection, a client that can parse HTML error pages or inconsistent response schemas, retry logic calibrated to human workflows, and auth tokens whose expiry is handled by a logged-in user session. LLM tool calls have none of these properties. They're ephemeral (one inference pass), unbounded in concurrency (the model can call tools in parallel), and entirely programmatic — there's no human in the loop to re-authenticate when a token expires mid-task. Custom REST adapters fail silently under these conditions, and the failure only surfaces as a degraded model response that the user may not recognise as a tool failure.

The deeper problem: no REST adapter is reusable across applications. If two teams are both querying the same GitHub API, they ship two adapters. Neither can benefit from the other's bug fixes.

### Alternative 2: WebSocket hub

A more architecturally sophisticated approach: build a central hub that all LLM applications connect to via WebSocket. The hub speaks to each third-party service and exposes a unified API to the models. This is roughly how several enterprise "AI middleware" products positioned themselves in 2023–2024.

**The specific failure mode**: WebSocket connections are stateful. The hub must maintain a live socket per LLM application session, track which model is mid-task, and route responses back to the right session. Under load, this creates a complex multiplexed-session management problem that grows with the number of concurrent LLM calls. More critically: the hub becomes a single point of failure. If it goes down — or even experiences elevated latency — every LLM application it serves degrades simultaneously.

There is a subtler problem for local development. WebSocket hubs require network reachability. An MCP server for a local tool (like a file system reader or a local database) runs as a child process on the developer's machine. A WebSocket hub requires that local process to expose a public network address, which is either a security hole or an operational headache. stdio sidesteps this entirely: the MCP server is a child process of the host application, communicating over a Unix pipe. No network, no auth surface, trivially restartable.

### Alternative 3: OpenAPI spec passthrough

A third approach: standardise the *description format* for tools rather than the *transport*. Publish an OpenAPI 3.1 spec for each service, have the LLM read the spec, and generate API calls directly. Some LLM providers experimented with this in 2023.

**The specific failure mode**: OpenAPI describes what an API does, not how an LLM should call it. The semantics of "what parameters to pass and when" are not representable in OpenAPI's schema layer — they require the kind of natural-language description that MCP's Tool definition carries in its `description` field. OpenAPI also provides no mechanism for streaming partial results back to the model (which matters enormously for long-running tool calls), no capability negotiation (so the model doesn't know which version of the tool is available), and no structured error typing that the model can reason about.

More critically: OpenAPI passthrough gives the model direct access to an API with no mediation layer. If the model makes a malformed call — which LLMs do, especially with complex parameter schemas — the error comes back as a raw HTTP 422 or 500, which the model must parse without context. MCP's typed error responses (`error.code`, `error.message`, structured `data`) are designed precisely so that the model has enough signal to retry or escalate without human intervention.[^5]

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="I want to understand the N×M problem concretely. Without any standard protocol: if I have 4 LLM applications (a coding assistant, a support agent, a data analyst tool, and a DevOps helper) and each needs to integrate with 6 tools (GitHub, Jira, Confluence, Slack, Datadog, and PostgreSQL), how many integration adapters do I need to write and maintain? Now explain how a standard protocol like MCP reduces that number and what trade-offs the reduction introduces."
  expectedOutput="Without a standard protocol, you need 4 × 6 = 24 integration adapters — each application writes its own connector to each tool.\n\nWith a standard protocol like MCP:\n- Each of the 6 tools publishes 1 MCP server (6 total)\n- Each of the 4 applications implements 1 MCP client (4 total)\n- Total integration surface: 6 + 4 = 10 pieces, not 24\n\nThe trade-offs: (1) Protocol overhead — every call goes through JSON-RPC framing and capability negotiation. (2) Least-common-denominator risk — the protocol must be general enough for all tools. (3) Versioning coupling — spec changes require both clients and servers to update. (4) Discovery bootstrapping — you need a way for applications to find servers, which the 2026 roadmap solves with .well-known gateway metadata.\n\nThe trade-off is worth it once N and M are both greater than ~3."
/>

---

## The LSP lineage: a protocol that solved this before

The Model Context Protocol did not invent its own design. It borrowed from a protocol that already solved the identical N×M problem in a different domain: the **Language Server Protocol (LSP)**, introduced by Microsoft in 2016.[^3]

Before LSP, every code editor (VS Code, Vim, Emacs, Eclipse, IntelliJ) had to implement language support for every programming language — syntax highlighting, go-to-definition, autocomplete, rename refactor. The result was the same N×M explosion: M editors × N languages = M×N implementations, each with different quality and feature parity.

LSP solved it with a single insight: separate the *language intelligence* from the *editor UI*. A language server runs as a local process and speaks a standard JSON-RPC protocol. Any editor that implements the LSP client can talk to any language server. Today, the Python LSP server (`pylsp`) works identically in VS Code, Neovim, Emacs, and Helix. The editor teams wrote one client; the language teams wrote one server.

MCP borrows three specific architectural choices from LSP:

**1. JSON-RPC 2.0 over stdio for local servers.** LSP uses JSON-RPC over stdio for local servers. MCP uses exactly the same wire format for the same reason: it's a self-contained framing protocol, easy to parse, with no external dependencies. A process that reads from stdin and writes to stdout is the simplest possible IPC primitive — no sockets, no shared memory, no OS-specific APIs.[^1][^4]

**2. Capability negotiation at handshake time.** LSP's `initialize` / `initialized` handshake lets the client and server advertise which features each supports before any work begins. MCP's `initialize` lifecycle follows the same pattern: the client sends its capabilities, the server responds with its own, and both parties agree on the protocol version. This means a new client can talk to an old server (or vice versa) without crashing — they negotiate down to the intersection of their capabilities.[^1]

**3. Stateful session model.** LSP maintains a session per open project. MCP maintains a session per connected client. Both sessions are terminated when the process exits or the connection closes. This is in contrast to REST APIs, which are stateless by design. The stateful model allows MCP servers to maintain context between calls (e.g., an open database connection, a cached authentication token) without re-establishing it on every request.

The explicit LSP comparison appears in the original MCP announcement from Anthropic and in the specification's architecture documentation.[^1]

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="Compare LSP's initialize/initialized handshake with MCP's initialize lifecycle. Walk me through exactly what fields are exchanged in MCP's initialize request and response, and explain what each side learns from the handshake that it couldn't determine from a simple REST health-check endpoint."
  expectedOutput="MCP's initialize handshake (spec §3.1):\n\nClient → Server (initialize request):\n- protocolVersion: the spec version the client supports (e.g. '2024-11-05')\n- capabilities: object advertising what the client can handle (roots, sampling)\n- clientInfo: { name, version } for diagnostics\n\nServer → Client (initialize response):\n- protocolVersion: the version the server will use (must be ≤ client's)\n- capabilities: object advertising what the server exposes (tools, resources, prompts, logging)\n- serverInfo: { name, version } for diagnostics\n\nClient → Server (notifications/initialized): confirms the client is ready.\n\nWhat each side learns that a REST /health check cannot tell you:\n1. Protocol version compatibility — the client knows immediately whether the server speaks a version it understands. A /health endpoint returns 200 OK regardless of spec version.\n2. Capability surface — the client learns exactly which primitives (tools/resources/prompts) the server supports before making a single call. No trial-and-error.\n3. Negotiated version floor — both sides agree on the lowest common version, so neither sends fields the other can't parse.\n4. Server identity — serverInfo lets the host log which implementation is running, useful for debugging multi-server setups.\n\nA REST /health check tells you only that the server is alive. MCP's handshake tells you what it can do and whether you can talk to it."
/>

---

## The host / client / server triad

MCP defines a precise three-way topology that almost every tutorial glosses over. Understanding it prevents an entire class of architectural mistakes.

**Host** — The LLM application. Claude.ai is a host. Cursor is a host. Your custom agent is a host. The host is responsible for: starting and stopping MCP server processes, managing user sessions, holding the LLM inference loop, and deciding which tool results to include in the model's context.

**Client** — A component *inside the host* that manages a single MCP server connection. A host can maintain multiple clients simultaneously (one per MCP server). The client handles: JSON-RPC framing, capability negotiation, request multiplexing, and lifecycle management for one server. It is not user-facing; it's plumbing.

**Server** — The MCP server itself. A server exposes some combination of Tools, Resources, and Prompts, and it serves exactly one domain: a GitHub MCP server knows about repos and files; a Postgres MCP server knows about tables and queries. Servers are intentionally narrow.

The key constraint: **the server never calls the host, and it never calls other servers**. Information flows in one direction: the client calls the server, the server returns results, the client passes them to the host, the host injects them into the model context. This unidirectional constraint is what makes MCP servers safe to run as untrusted third-party processes: a malicious server can return garbage, but it cannot initiate actions against the host or against other connected services.

<Callout type="warning">
**The unidirectional constraint has teeth.** If you design an MCP server that tries to call back into the host (e.g., to trigger another tool call), you have broken the security model. The server has no channel for this — and any workaround (e.g., embedding a callback URL in a tool result) should be treated as a red flag in code review. See [[courses/mcp-from-first-principles-to-production/02-json-rpc-wire-protocol]] for how the JSON-RPC framing enforces this at the wire level.
</Callout>

<KnowledgeCheck
  questions={[
    {
      question: "An MCP server embeds a callback URL in a tool result, and the host application uses it to trigger a call on a different MCP server. Why is this a security concern in the MCP architecture?",
      answers: [
        "Callback URLs are not valid JSON-RPC response fields",
        "The server has bypassed the unidirectional constraint — it is covertly initiating an action chain the host did not authorise, outside the normal audit trail",
        "HTTP callbacks introduce latency incompatible with stdio transport",
        "MCP servers are not permitted to return string fields in tool results"
      ],
      correct: 1,
      explanation: "The MCP security model depends on servers only returning data — never initiating actions. When a server embeds a callback URL to trigger further tool calls, it is covertly influencing host behaviour, bypassing the access controls and audit trail the host maintains. This is a common prompt-injection vector in agentic systems. MCP's unidirectional architecture makes server intent auditable by restricting servers to returning structured data only."
    }
  ]}
/>

---

## What MCP deliberately does NOT solve

This is the contrarian angle that almost every MCP post omits. MCP is not universal agent middleware. It is a narrow protocol for one specific job — standardised context injection into LLM inference — and its narrowness is what makes it deployable. Every problem MCP does *not* solve is a problem it deliberately deferred to a higher layer.

**Agent orchestration.** There is no flow control in MCP, no mechanism for a server to direct the model to call another tool, no branching logic. Orchestration (deciding which tool to call, in what order, with what retry logic) is the host's job. This is intentional: if the protocol encoded orchestration, every orchestration model (ReAct, plan-and-execute, tree-of-thought) would require a protocol extension. By leaving orchestration out, MCP can be used with any orchestration model without modification.[^2]

**Multi-agent coordination.** Two MCP-enabled agents cannot coordinate through MCP itself. They would need a separate channel — a message queue, a shared database, or an orchestrator agent that calls both via its own MCP clients. The 2026 roadmap explicitly names multi-agent coordination as a future consideration, not a current feature.[^2]

**Session memory and persistence.** When an MCP server process exits, its state is gone. Persistent memory (conversation history, user preferences, cross-session context) is the host's responsibility. Servers that want to persist state must use an external database and manage it themselves.

**Model routing.** Which model gets called, at what temperature, with what context window budget — none of that is MCP's concern. MCP is below the model layer; it's the mechanism by which context reaches a model, not the mechanism by which a model is selected or invoked.

**Billing and rate limiting at the server level.** A raw MCP server has no concept of who is calling it or how many times. That's what the gateway layer (Chapter 5) adds — RBAC, per-user rate limits, and audit trails. Running MCP servers without a gateway on a multi-user system is like running a database without connection pooling or access control.

The deliberate narrowness is the design. A protocol that tried to solve all five of these problems would be so complex that no two implementations would be compatible. MCP's power comes from what it excludes.

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="I'm building an AI coding assistant that needs to: (1) read files from a GitHub repo, (2) run tests in CI and get results, (3) remember which files the user worked on across sessions, (4) decide whether to call GitHub or CI first based on context, and (5) limit the number of CI calls per user per hour. For each of these five requirements, tell me: is this MCP's job, or does it belong to a different layer? Name the layer if it's not MCP."
  expectedOutput="1. Read files from GitHub repo → MCP's job. A GitHub MCP server with a read_file Resource or Tool handles this directly.\n\n2. Run tests in CI and get results → MCP's job. A CI MCP server with a run_tests Tool handles this. The Tool returns structured results the model can reason over.\n\n3. Remember which files the user worked on across sessions → NOT MCP's job — the host's responsibility. MCP servers are stateless between sessions. Persistent memory belongs to your application layer: a database, vector store, or session management system the host controls.\n\n4. Decide whether to call GitHub or CI first → NOT MCP's job — orchestration. The model (guided by your system prompt and tool descriptions) decides call order. MCP just executes whichever call the model makes. Deterministic ordering is enforced by your host's orchestration logic.\n\n5. Limit CI calls per user per hour → NOT MCP's job — the gateway/infrastructure layer. A raw MCP server has no concept of users or rate limits. You need an MCP gateway (Chapter 5) with RBAC and rate-limiting policies, or a reverse proxy that enforces quotas before requests reach the server."
/>

---

## A minimal MCP server: hello world in ~38 lines

The best way to make the architecture concrete is to read a complete, working MCP server. The following Python implementation is stripped to the minimum that satisfies the MCP specification's `initialize` handshake and handles a single tool call over stdio.[^1]

```python
#!/usr/bin/env python3
"""Minimal MCP server: exposes one tool (echo) over stdio transport."""
import json
import sys

def send(msg: dict) -> None:
    # Never use print() here — it writes to stdout and corrupts the stdio channel
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()

def handle(msg: dict) -> None:
    method = msg.get("method")
    id_ = msg.get("id")

    if method == "initialize":
        send({
            "jsonrpc": "2.0", "id": id_,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "hello-mcp", "version": "0.1.0"}
            }
        })

    elif method == "tools/list":
        send({
            "jsonrpc": "2.0", "id": id_,
            "result": {"tools": [{
                "name": "echo",
                "description": "Returns the input string unchanged.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"message": {"type": "string"}},
                    "required": ["message"]
                }
            }]}
        })

    elif method == "tools/call":
        args = msg.get("params", {}).get("arguments", {})
        send({
            "jsonrpc": "2.0", "id": id_,
            "result": {"content": [{"type": "text", "text": args.get("message", "")}]}
        })

    elif method == "notifications/initialized":
        pass  # Notifications receive no response

    else:
        # JSON-RPC 2.0 §5: requests carrying an id MUST receive a response;
        # only notifications (no id field) may be silently dropped.
        if id_ is not None:
            send({
                "jsonrpc": "2.0", "id": id_,
                "error": {"code": -32601, "message": "Method not found"}
            })

for line in sys.stdin:
    line = line.strip()
    if line:
        handle(json.loads(line))
```

Run it and drive it manually to see the full lifecycle:

```bash
python3 hello_mcp.py << 'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-client","version":"0.1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello, MCP"}}}
EOF
```

Expected output:

```json
{"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "hello-mcp", "version": "0.1.0"}}}
{"jsonrpc": "2.0", "id": 2, "result": {"tools": [{"name": "echo", "description": "Returns the input string unchanged.", "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]}}]}}
{"jsonrpc": "2.0", "id": 3, "result": {"content": [{"type": "text", "text": "hello, MCP"}]}}
```

Every field maps directly to a section of the MCP specification.[^1] The `protocolVersion` in the `initialize` response is the spec version the server implements — clients use this to decide whether to proceed or reject the connection. The `capabilities` object is the negotiation surface: if your server doesn't include `{"resources": {}}` in capabilities, the client will not attempt `resources/list`. The `content` array in a tool response is typed — each item has a `type` field (`text`, `image`, `resource`) that tells the host how to render the result.

Notice what is *not* in this server: no authentication, no rate limiting, no session management, no orchestration. Those are host and gateway concerns. This server's only job is to expose the `echo` tool correctly.

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="I have the minimal echo MCP server from this chapter. Extend it to add a second tool called 'reverse' that takes a 'text' string parameter and returns the string reversed. Show: (1) the updated tools/list result body listing both tools, (2) the updated tools/call handler that branches on tool name, and (3) a bash one-liner to test the reverse tool. Keep it raw stdio Python — no SDK, no imports beyond json and sys."
  expectedOutput="(1) Updated tools/list result body:\n{\n  \"tools\": [\n    {\n      \"name\": \"echo\",\n      \"description\": \"Returns the input string unchanged.\",\n      \"inputSchema\": {\"type\": \"object\", \"properties\": {\"message\": {\"type\": \"string\"}}, \"required\": [\"message\"]}\n    },\n    {\n      \"name\": \"reverse\",\n      \"description\": \"Returns the input string reversed.\",\n      \"inputSchema\": {\"type\": \"object\", \"properties\": {\"text\": {\"type\": \"string\"}}, \"required\": [\"text\"]}\n    }\n  ]\n}\n\n(2) Updated tools/call handler:\nelif method == 'tools/call':\n    name = msg.get('params', {}).get('name')\n    args = msg.get('params', {}).get('arguments', {})\n    if name == 'echo':\n        result_text = args.get('message', '')\n    elif name == 'reverse':\n        result_text = args.get('text', '')[::-1]\n    else:\n        result_text = ''\n    send({'jsonrpc': '2.0', 'id': id_, 'result': {'content': [{'type': 'text', 'text': result_text}]}})\n\n(3) Bash test:\necho '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"0\"}}}\\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"reverse\",\"arguments\":{\"text\":\"hello\"}}}' | python3 hello_mcp.py\nExpected last line: {\"jsonrpc\": \"2.0\", \"id\": 2, \"result\": {\"content\": [{\"type\": \"text\", \"text\": \"olleh\"}]}}"
/>

<Callout type="hot">
**Why stdio, not HTTP, for local servers?** This server reads from stdin and writes to stdout — there is no network socket. That means: zero firewall configuration, zero network authentication surface, trivial restart (kill and respawn the process), and clean process isolation (the server dies when its parent dies). The stdio transport is not a dev-environment shortcut. It is the production transport for any MCP server that runs on the same machine as the host. Chapter 2 covers when to switch to HTTP+SSE (Streamable HTTP) for remote servers — and what you give up when you do.
</Callout>

---

## Knowledge checks

<KnowledgeCheck
  questions={[
    {
      question: "In the MCP architecture, which component decides which tool to call next — the host, the client, or the server?",
      answers: [
        "The MCP server, based on its tool metadata",
        "The MCP client, based on capability negotiation",
        "The host (the LLM application), based on model output",
        "The MCP specification mandates a round-robin call order"
      ],
      correct: 2,
      explanation: "The host runs the LLM inference loop and acts on model output. The model (guided by tool descriptions) suggests which tool to call; the host executes that call via its MCP client. The server has no visibility into this decision."
    },
    {
      question: "Which of the following is NOT a problem that MCP was designed to solve?",
      answers: [
        "Standardising how LLM applications call external tools",
        "Eliminating N×M custom integration adapters",
        "Persisting conversation history across sessions",
        "Defining a capability negotiation handshake between client and server"
      ],
      correct: 2,
      explanation: "Session persistence is explicitly out of scope for MCP. The protocol is stateless between sessions — a server process that exits loses its state. Persistent memory is the host application's responsibility."
    },
    {
      question: "The MCP specification uses JSON-RPC 2.0 over stdio for local servers. Which protocol directly inspired this design choice?",
      answers: [
        "GraphQL subscriptions",
        "gRPC bidirectional streaming",
        "The Language Server Protocol (LSP)",
        "WebSocket over TLS"
      ],
      correct: 2,
      explanation: "MCP is explicitly modelled on LSP, which uses JSON-RPC over stdio to solve the identical N×M problem for editors and language tooling. The architecture documentation in the MCP specification cites this lineage directly."
    }
  ]}
/>

<KnowledgeCheck
  questions={[
    {
      question: "A colleague proposes building a WebSocket hub as universal middleware for all LLM tool integrations. What is the specific architectural failure mode of this approach?",
      answers: [
        "WebSocket is too slow for LLM response times",
        "The hub becomes a stateful single point of failure, and local-process tools cannot be reached without a public network address",
        "WebSocket is not supported by JSON-RPC 2.0",
        "LLMs cannot parse WebSocket frames natively"
      ],
      correct: 1,
      explanation: "Stateful session management at scale and the requirement for network reachability are the two structural problems. Local tools have no natural network address — stdio process spawning sidesteps this completely."
    }
  ]}
/>

---

## Hands-on exercise: map your own integrations onto the MCP model

**Pick three integrations you have built or maintain** — REST API calls your application makes, database queries, file system reads, third-party SDKs. For each, answer:

1. **Host / Client / Server assignment**: If this were an MCP server, which component would own the domain logic? What would the server's `name` be?

2. **Primitive classification**: Is this primarily a **Tool** (model-initiated, side-effects acceptable), a **Resource** (app-controlled, read-only context), or a **Prompt** (user-triggered template)?

3. **What MCP would NOT handle**: Identify one concern that MCP leaves to your application layer — auth, rate limiting, caching, session state — and name which layer owns it.

Write three one-paragraph descriptions, one per integration, structured as: "This is an MCP [Tool/Resource/Prompt] exposed by a server named [X]. The host is [Y]. MCP handles [specific responsibility]. The [auth/rate-limit/etc.] concern belongs to [layer/component] because [reason]."

**Success criteria**: If you can write all three paragraphs without hedging on the primitive classification, you've internalised the host/client/server separation well enough to proceed to the next chapter.

---

## What's next

Chapter 1 answered the *why*. Chapter 2 answers the *how* — down to the byte level.

In [[courses/mcp-from-first-principles-to-production/02-json-rpc-wire-protocol]] you will dissect the JSON-RPC 2.0 envelope frame by frame, implement the full `initialize → capabilities → request → response` lifecycle by hand (no SDK), and build the 60-line Python server that handles `tools/list` and `tools/call` over raw stdin/stdout. You'll also learn when stdio transport breaks down and why Streamable HTTP (HTTP+SSE) is the right choice for remote servers — including what you give up when you leave stdio behind.

If you want context on where the protocol is heading before diving into wire-level details, [[blogs/mcp-2026-roadmap-explained]] covers the OAuth 2.1 + DPoP trajectory and the gateway discovery work planned for the second half of 2026.

---

## References

[^1]: Model Context Protocol Specification — https://spec.modelcontextprotocol.io/ · retrieved 2026-04-30
[^2]: MCP 2026 Roadmap (Official Blog) — https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/ · retrieved 2026-04-30
[^3]: Language Server Protocol Specification 3.17 — https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/ · retrieved 2026-04-30
[^4]: JSON-RPC 2.0 Specification — https://www.jsonrpc.org/specification · retrieved 2026-04-30
[^5]: MCP Specification GitHub Issues — https://github.com/modelcontextprotocol/specification/issues · retrieved 2026-04-30
