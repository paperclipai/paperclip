---
course_slug: mcp-from-first-principles-to-production
chapter_num: 2
chapter_slug: json-rpc-over-stdio
title: "JSON-RPC over stdio — the wire protocol explained"
status: draft-for-review
author: course-author
date: 2026-04-30
duration_min: 45
prerequisites_chapters: [1]
learning_objectives:
  - "Decode a raw MCP message frame at the byte level: envelope, id, method, params"
  - "Explain why JSON-RPC 2.0 over stdio was chosen over REST, gRPC, or WebSocket for local transport"
  - "Implement the full initialize → capabilities → tools/list → tools/call lifecycle by hand without an SDK"
  - "Explain when to use HTTP Streaming transport instead of stdio and what changes at the protocol level"
key_concepts: [JSON-RPC 2.0, newline-delimited framing, stdio transport, HTTP streaming transport, capability negotiation, notification vs request vs response, protocol version]
hands_on_exercise: "Write a 60-line Python MCP server handling tools/list and tools/call over raw stdio — no SDK, raw sys.stdin/sys.stdout. Verify with a manual JSON-RPC call piped from the terminal."
sources:
  - https://www.jsonrpc.org/specification
  - https://spec.modelcontextprotocol.io/specification/2025-03-26/
  - https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/
---

# JSON-RPC over stdio — the wire protocol explained

> **Prerequisites**: [[01-why-mcp-exists|Chapter 1 (Why MCP exists)]]. You should be able to sketch the host/client/server triad and articulate the N×M problem MCP solves.
>
> **Time**: 45 minutes
>
> **What you'll be able to do**: By the end of this chapter, you can read a raw MCP message exchange at the byte level, explain every design choice in the wire format, and write a working MCP server from scratch without an SDK. This hands-on fluency is what separates developers who can ship MCP integrations from developers who can merely configure them.

---

## Why the wire format matters

Every MCP SDK — the Python `mcp` package, the TypeScript `@modelcontextprotocol/sdk`, the Rust crate — is an abstraction layer over the same wire protocol. When something goes wrong in production, the abstraction disappears and you're reading raw JSON in a log file or a debugger. If you don't know what that JSON *should* look like, you can't diagnose the problem.

More importantly: once you understand the wire format, the SDK stops being magic. Every SDK call maps to one or two JSON messages. Once you can see those messages, you can reason about performance (how many round-trips does a tool call require?), error handling (what does a structured error look like vs. a malformed request?), and security (what information is in the request that an attacker could exploit?).

This chapter builds that fluency from scratch.

---

## JSON-RPC 2.0: the message envelope

MCP uses **[[JSON-RPC 2.0]]**[^1] as its message format. This is not an implementation detail — it's a deliberate choice with specific consequences. Let's understand it before we look at MCP-specific message types.

JSON-RPC 2.0 defines four message shapes:

### Request (client → server, or server → client)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_github",
    "arguments": { "query": "MCP protocol", "limit": 10 }
  }
}
```

The `id` field is critical: it's how the *response* is correlated back to this specific request. In a world where multiple requests can be in-flight simultaneously (the client doesn't wait for one response before sending the next), the id lets both sides match requests to their responses. The id can be a number or a string; MCP conventionally uses integers.

### Response (server → client, or client → server)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      { "type": "text", "text": "Found 47 results for 'MCP protocol'" }
    ],
    "isError": false
  }
}
```

Or on error:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Invalid params",
    "data": { "field": "limit", "issue": "must be between 1 and 100" }
  }
}
```

The `error` and `result` fields are mutually exclusive. A valid JSON-RPC response has exactly one of them.

### Notification (either direction, no response expected)

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/tools/list_changed",
  "params": {}
}
```

Notice: **no `id` field**. A notification is a one-way message. The sender never expects a response. This is how MCP servers push events to clients (tool list changes, resource updates, progress on long-running operations) without the client polling.

### Batch (array of requests/notifications)

```json
[
  { "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} },
  { "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} }
]
```

MCP supports batch messages but rarely uses them in practice. Most SDK implementations send messages individually.

<KnowledgeCheck
  question="Which JSON-RPC field is ABSENT in a notification but REQUIRED in a request?"
  options={[
    "jsonrpc",
    "method",
    "id",
    "params"
  ]}
  correctIdx={2}
  explanation="A notification has no `id` field because no response is expected. The `id` in a request is what allows the receiver to correlate the response back to the specific request. Notifications are one-way messages — the sender never expects a reply, so there is nothing to correlate."
/>

---

## The stdio transport: why a pipe beats a socket

### The technical choice

For local MCP servers — servers running on the same machine as the host — the MCP spec defines **[[MCP stdio transport|stdio transport]]**: the host launches the server as a subprocess and communicates via stdin (host → server) and stdout (server → host). Each message is a JSON object terminated by a single newline character (`\n`).[^2]

This is newline-delimited JSON, also called NDJSON or JSON Lines. The framing rule is brutally simple: read until `\n`, parse what you got as JSON, process it.

```
[host writes to server stdin]
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"claude-desktop","version":"1.0"}}}\n

[server writes to host stdout]
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{},"resources":{}},"serverInfo":{"name":"github-mcp","version":"0.1.0"}}}\n

[host writes to server stdin — client signals readiness, no response expected]
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n
```

### Why not WebSockets?

WebSockets provide a persistent bidirectional connection — sounds like an obvious choice. Here's what you'd actually be choosing:

- **Network stack dependency**: WebSocket connections require a port, a network interface, and TLS for anything beyond localhost. Running a local MCP server on WebSockets means opening a port on the host machine, managing its lifecycle, ensuring it's not accessible from outside. This is solvable but it's operational overhead that stdio avoids entirely.

- **Complex lifecycle management**: A WebSocket server is a long-running process. The host needs to know where it's listening (port, hostname), how to restart it if it crashes, and how to clean up when the host exits. With stdio, the lifecycle is implicit: the host forks a subprocess, and the subprocess dies when the host closes its end of the pipe. No cleanup logic required.

- **Session multiplexing complexity**: WebSocket servers often need to handle multiple concurrent connections. Stdio is inherently single-connection-per-process. For MCP's use case (one client per server connection), this simplicity is a feature.

### Why not gRPC?

gRPC is mature, fast, and has excellent schema tooling via Protocol Buffers. The failure modes:

- **Protobuf schema requirement**: gRPC requires a `.proto` schema definition. Every new tool or resource change requires a schema update and re-compilation. MCP's JSON Schema approach allows runtime schema changes (a server can add new tools without recompiling anything).
- **Binary format opacity**: A gRPC message is not human-readable. Debugging a local MCP server by reading its stdio output is trivial with JSON. With Protobuf, you need a decoder.
- **Tooling weight**: gRPC requires a code generation step, language-specific runtimes, and for web/browser environments, special proxies (grpc-web). JSON-RPC needs only a JSON parser.

### Why not REST?

REST over HTTP is request-response only. MCP needs bidirectionality: the server must be able to send unsolicited notifications to the client (tool list changes, resource updates, progress events). With REST, you'd need polling (inefficient, adds latency) or webhooks (requires the client to expose an HTTP server, which is complex for desktop apps). JSON-RPC over stdio gets bidirectionality for free: either side can write to its output at any time.

<Callout type="warn">
**stderr is NOT part of the protocol**. The MCP spec reserves stdout for protocol messages only. Any log output, debug prints, or error messages your server writes to stdout will corrupt the JSON stream and cause parse errors in the client. **All server-side logging must go to stderr** (or a file). This is the most common mistake in first-time MCP server implementations — and it's usually the last thing developers check when debugging a broken server.
</Callout>

---

## The initialize handshake: step by step

Every MCP session begins with a [[MCP initialize handshake|three-message handshake]][^4]. Understanding it prevents a surprising class of bugs where a server works in isolation but fails when connected to a real host.

### Message 1: `initialize` (client → server)

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {
      "roots": { "listChanged": true },
      "sampling": {}
    },
    "clientInfo": {
      "name": "claude-desktop",
      "version": "1.2.0"
    }
  }
}
```

The client declares:
- `protocolVersion` — the version it wants to speak. Servers should accept any version they support; the spec doesn't mandate that servers reject older versions.
- `capabilities` — what the *client* can do. `roots.listChanged` means the client supports notifications when the root (workspace) changes. `sampling` means the client supports the server requesting LLM completions via the host.
- `clientInfo` — for logging and diagnostics.

### Message 2: `initialize` response (server → client)

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": "2025-03-26",
    "capabilities": {
      "tools": { "listChanged": true },
      "resources": { "subscribe": true, "listChanged": true },
      "prompts": { "listChanged": true },
      "logging": {}
    },
    "serverInfo": {
      "name": "github-mcp",
      "version": "0.2.1"
    }
  }
}
```

The server declares its capabilities:
- `tools.listChanged` — the server will send `notifications/tools/list_changed` when its tool set changes.
- `resources.subscribe` — clients can subscribe to resource updates.
- `logging` — the server supports the `logging/setLevel` request.

Capabilities not declared here are not supported. If the client tries to use an undeclared capability, the server may return an error or silently ignore the request.

### Message 3: `notifications/initialized` (client → server, notification)

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized",
  "params": {}
}
```

This is the client saying "I've processed your initialize response and I'm ready." No id, no response expected. After this, the session is live and the client can send any supported request.

The entire handshake is synchronous: no other messages can be sent until `notifications/initialized` is dispatched. This is important for implementations that try to pre-load tool lists before the handshake completes — they'll get a protocol error.

<KnowledgeCheck
  question="After receiving the server's initialize response, what MUST the client send before any tool call is valid?"
  options={[
    "tools/list",
    "notifications/initialized",
    "initialize again",
    "Nothing — the session is immediately live"
  ]}
  correctIdx={1}
  explanation="The MCP spec mandates that the client send `notifications/initialized` after processing the server's initialize response. This notification signals that the client is ready to proceed. Sending any other request — including tools/list or tools/call — before dispatching this notification is a protocol violation. The notification has no `id` because no response is expected."
/>

<RunPromptCell
  model="claude-sonnet-4-6"
  system="You are an MCP protocol expert. Be precise and terse."
  prompt="A client has just received the server's initialize response containing the server's capabilities. What is the NEXT message the client MUST send, and why? What happens if it skips this step and sends tools/list immediately?"
  expectedOutput="The client must send 'notifications/initialized' — a JSON-RPC notification (no id) with method='notifications/initialized' and empty params. This signals to the server that the client has processed the initialize response and the session is live. If the client skips this and sends tools/list directly, it violates the MCP handshake protocol. Spec-compliant servers should treat any non-handshake request before notifications/initialized as a protocol error, potentially returning -32600 (Invalid Request) or closing the connection."
/>

---

## Reading a real MCP exchange

Let's trace a complete tool call from wire to result. The scenario: a user in Claude Desktop asks "What are my open GitHub PRs?" and the host invokes the `list_pull_requests` tool on a GitHub MCP server.

**Step 1**: Host discovers available tools.

```json
→ {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}

← {
    "jsonrpc":"2.0",
    "id":2,
    "result":{
      "tools":[
        {
          "name":"list_pull_requests",
          "description":"List open pull requests for a repository",
          "inputSchema":{
            "type":"object",
            "properties":{
              "owner":{"type":"string","description":"GitHub org or username"},
              "repo":{"type":"string","description":"Repository name"},
              "state":{"type":"string","enum":["open","closed","all"],"default":"open"}
            },
            "required":["owner","repo"]
          }
        }
      ]
    }
  }
```

The `inputSchema` is a JSON Schema object[^3]. This is what the host passes to the model to describe the tool's calling convention. The model uses this schema to decide what arguments to generate.

**Step 2**: Model decides to call the tool. Host sends `tools/call`.

```json
→ {
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{
      "name":"list_pull_requests",
      "arguments":{
        "owner":"anthropics",
        "repo":"anthropic-sdk-python",
        "state":"open"
      }
    }
  }
```

**Step 3**: Server calls the GitHub API, returns the result.

```json
← {
    "jsonrpc":"2.0",
    "id":3,
    "result":{
      "content":[
        {
          "type":"text",
          "text":"Found 12 open PRs:\n1. #847 — Add streaming support for tool_use...\n2. #821 — Fix retry logic on 529..."
        }
      ],
      "isError":false
    }
  }
```

**Step 4**: If the tool failed (GitHub API down, bad credentials):

```json
← {
    "jsonrpc":"2.0",
    "id":3,
    "result":{
      "content":[
        {
          "type":"text",
          "text":"GitHub API returned 401: Bad credentials. Check your GITHUB_TOKEN environment variable."
        }
      ],
      "isError":true
    }
  }
```

Note: tool errors use `isError: true` in the `result`, NOT the JSON-RPC `error` field. The JSON-RPC `error` field is reserved for *protocol* errors (malformed request, unknown method). Separating protocol errors from tool errors is a deliberate design choice: a protocol error means the server couldn't understand the request; a tool error means the server understood the request but execution failed. The host handles these differently.

<RunPromptCell
  model="claude-sonnet-4-6"
  system="You are an MCP protocol expert. Be precise and concrete."
  prompt="I'm reading MCP server logs and I see this message arrive on stdin: {\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"run_query\",\"arguments\":{\"sql\":\"SELECT * FROM users LIMIT 10\"}}}. Walk me through: (1) what my server must do to validate this message before executing anything, (2) what a successful response looks like, (3) what the response looks like if the SQL query fails because the table doesn't exist."
  expectedOutput="The expert covers: (1) validate jsonrpc='2.0', id exists, method='tools/call', params.name matches a known tool, params.arguments validates against the tool's inputSchema — if any fail, return a JSON-RPC error with code -32602. (2) result.content array with text content and isError:false. (3) result.content with the error message and isError:true — NOT a JSON-RPC error object, because the protocol worked fine; only the tool execution failed."
/>

---

## HTTP Streaming transport: when stdio isn't enough

Stdio is perfect for local servers. But you can't run a stdio process when the MCP server is a cloud API — when the server is a SaaS vendor's integration, a company-wide shared endpoint, or a multi-tenant service.

The MCP spec defines an **HTTP Streaming transport** (formerly called HTTP+SSE; the 2025 spec revision renamed and updated it)[^2] for remote servers. The key differences:

**Connection model**: Instead of a subprocess pipe, the client makes HTTP POST requests to a single endpoint. The server can respond with a streaming body (using chunked transfer encoding) to push multiple messages in one HTTP response.

**Message format**: Same JSON-RPC 2.0 envelope. Same newline delimiting. The wire format is identical; only the carrier changes.

**Bidirectionality**: Because HTTP is inherently request-initiated, server-to-client notifications can't be sent spontaneously. The spec handles this with Server-Sent Events (SSE) on a separate `/events` endpoint, or in the updated Streamable HTTP transport, by allowing the server to include multiple JSON-RPC messages in a single streaming response body.

**Session management**: HTTP is stateless. The client includes a session identifier in each request header so the server can correlate requests to the same logical session.

**Auth**: HTTP headers carry auth credentials (Bearer tokens, DPoP proofs — covered in Chapter 4). Stdio has no native auth mechanism; security relies on process-level isolation instead.

The choice between transports is architectural:

| Scenario | Transport |
|---|---|
| Local tool running on developer's machine | stdio |
| Internal service running in Kubernetes | HTTP Streaming |
| SaaS vendor's integration endpoint | HTTP Streaming |
| CI/CD pipeline action | stdio (subprocess) |
| Multi-tenant shared MCP server | HTTP Streaming |
| Desktop IDE plugin | stdio |

<RunPromptCell
  model="claude-sonnet-4-6"
  system="You are a solutions architect specializing in AI integration infrastructure."
  prompt="A team is building a SaaS vendor integration that will serve thousands of tenants, each making concurrent MCP requests. Which MCP transport should they choose, and what are the three main protocol differences versus stdio transport they need to account for in their implementation?"
  expectedOutput="The team should choose HTTP Streaming transport. Three key differences vs stdio: (1) Session management — HTTP is stateless, so each request must include a session identifier in request headers so the server can correlate requests to the same logical session; (2) Server-push mechanism — stdio lets the server write to stdout at any time, but HTTP requires Server-Sent Events (SSE) on a /events endpoint or a streaming response body for server-to-client notifications; (3) Authentication — HTTP headers carry Bearer tokens or DPoP proofs for per-request auth, while stdio relies on OS process isolation with no native auth mechanism."
/>

---

## Hands-on exercise: a 60-line MCP server, no SDK

This is the most important exercise in the course. You're going to write an MCP server from scratch, in Python, using only `sys.stdin` and `sys.stdout`. No `mcp` package. This forces you to confront every design decision we've discussed.

**What the server will do**: Handle `tools/list` (returns one tool: `echo`) and `tools/call` for the `echo` tool (returns whatever string argument was passed). This is the low-level equivalent of the patterns you'll find in the official Python SDK[^5], implemented without any abstraction so every design choice is visible.

**Complete implementation**:

```python
#!/usr/bin/env python3
"""
Minimal MCP server over stdio. No SDK. Raw JSON-RPC 2.0.
Run: python server.py
Test: echo '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | python server.py
"""
import sys
import json

PROTOCOL_VERSION = "2025-03-26"

TOOLS = [
    {
        "name": "echo",
        "description": "Returns the input string unchanged. Useful for testing.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "Text to echo back"}
            },
            "required": ["message"]
        }
    }
]

def send(obj: dict) -> None:
    """Write a JSON-RPC message to stdout. stderr only for logs."""
    line = json.dumps(obj, separators=(",", ":"))
    sys.stdout.write(line + "\n")
    sys.stdout.flush()

def error_response(req_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}

def handle(msg: dict) -> None:
    method = msg.get("method")
    req_id = msg.get("id")  # None for notifications
    params = msg.get("params", {})

    if method == "initialize":
        send({
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "echo-server", "version": "0.1.0"}
            }
        })
        # The server stops here. The CLIENT then sends notifications/initialized
        # to signal readiness — never the other way around.

    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}})

    elif method == "tools/call":
        tool_name = params.get("name")
        args = params.get("arguments", {})
        if tool_name == "echo":
            message = args.get("message", "")
            send({
                "jsonrpc": "2.0", "id": req_id,
                "result": {"content": [{"type": "text", "text": message}], "isError": False}
            })
        else:
            send(error_response(req_id, -32601, f"Unknown tool: {tool_name}"))

    elif req_id is not None:
        # Unknown method with an id: return method-not-found error
        send(error_response(req_id, -32601, f"Method not found: {method}"))
    # Unknown notifications are silently ignored (no id, no response expected)

def main():
    print("echo-server starting", file=sys.stderr)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            send(error_response(None, -32700, f"Parse error: {e}"))
            continue
        handle(msg)

if __name__ == "__main__":
    main()
```

**Testing it from the terminal** (sequence matters — you need the initialize handshake first):

```bash
# Save as echo_server.py, then:
python3 echo_server.py << 'EOF'
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello MCP"}}}
EOF
```

Expected output (one JSON object per line on stdout):

```json
{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"echo-server","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"echo","description":"Returns the input string unchanged. Useful for testing.","inputSchema":{"type":"object","properties":{"message":{"type":"string","description":"Text to echo back"}},"required":["message"]}}]}}
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"hello MCP"}],"isError":false}}
```

**What to verify**:
- Every response has the same `id` as its corresponding request
- The client's `notifications/initialized` (line 2 of the input) produces **no server output** — it's a notification with no id, so the server correctly produces no response
- stderr shows "echo-server starting" (logs stay off stdout)
- A call to an unknown tool returns a JSON-RPC `error` object, not `isError:true` in result

**Estimated time**: 20 minutes to type/copy, run, and understand the output.

<RunPromptCell
  model="claude-sonnet-4-6"
  system="You are a senior Python engineer reviewing an MCP server implementation."
  prompt="Review this Python MCP server implementation and identify three specific improvements that would make it production-ready. Focus on: error handling edge cases, logging, and correctness of the JSON-RPC lifecycle. Be specific — cite line numbers or code patterns.\n\n```python\ndef main():\n    for line in sys.stdin:\n        line = line.strip()\n        if not line:\n            continue\n        try:\n            msg = json.loads(line)\n        except json.JSONDecodeError as e:\n            send(error_response(None, -32700, f'Parse error: {e}'))\n            continue\n        handle(msg)\n```"
  expectedOutput="The reviewer identifies: (1) No handling for stdin closing (EOF) — the for loop exits silently when stdin closes; a production server should log the shutdown and call sys.exit(0) for clean process termination. (2) No validation that the 'jsonrpc' field equals '2.0' — a malformed client could send a JSON object that passes json.loads but is not a valid JSON-RPC envelope, and the server would attempt to process it. (3) No handshake state machine — the server accepts tools/call or tools/list before the initialize handshake completes, violating the MCP spec's sequencing requirement; a robust implementation should track whether notifications/initialized has been received and return -32600 for premature requests."
/>

<KnowledgeCheck
  question="Your MCP server is crashing but you see no error in the client. You add print() statements to debug. After adding them, the client starts receiving parse errors on every response. What is the most likely cause?"
  options={[
    "The JSON encoder is broken by the print() call",
    "print() writes to stdout by default, corrupting the JSON-RPC message stream with debug text",
    "The client is too strict about whitespace in JSON",
    "print() adds a BOM (byte order mark) that breaks JSON parsing"
  ]}
  correctIdx={1}
  explanation="This is the single most common MCP debugging mistake. print() in Python writes to stdout by default. Since stdout is the protocol channel, any non-JSON text (including debug prints) will corrupt the message stream and cause the client to get parse errors. Always use print(..., file=sys.stderr) or a logging handler configured to write to stderr or a file. Never write anything to stdout except valid JSON-RPC messages."
/>

---

## Error codes reference

JSON-RPC 2.0 defines standard error codes[^1] that MCP uses for protocol-level errors:

| Code | Name | When to use |
|---|---|---|
| -32700 | Parse error | Invalid JSON received |
| -32600 | Invalid Request | Valid JSON but not a valid JSON-RPC message |
| -32601 | Method not found | Unknown method name |
| -32602 | Invalid params | Method exists but params are wrong type/missing required |
| -32603 | Internal error | Server-side bug during processing |

MCP-specific error codes start at -32000 and go down. Application-specific errors (your tool's domain errors) go in `result.isError:true`, not in the `error` field.

---

## What's next

In Chapter 3, we zoom out from the wire protocol to the three semantic primitives: Tools, Resources, and Prompts. You now understand how any MCP message travels from client to server and back. Chapter 3 teaches you *what* to put in those messages — specifically, which primitive is the right abstraction for any given integration requirement. This is where most developers make wrong choices that are expensive to fix later.

---

## References cited

[^1]: [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification) — Defines the message envelope format, error codes, notification semantics, and batch requests that MCP uses verbatim.

[^2]: [MCP Transports Specification](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/) — Defines stdio transport (newline-delimited JSON over subprocess pipes) and HTTP Streaming transport for remote servers.

[^3]: [JSON Schema Specification](https://json-schema.org/specification) — The `inputSchema` field in MCP tool definitions is a JSON Schema object. Familiarity with draft 2020-12 is useful for writing precise tool definitions.

[^4]: [MCP Core Specification (2025-03-26)](https://spec.modelcontextprotocol.io/specification/2025-03-26/) — The authoritative specification for the Model Context Protocol, covering the full message lifecycle, capability negotiation, and the initialize handshake sequencing requirements. URLs verified 200 OK as of 2026-04-30.

[^5]: [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) — The official Python SDK for MCP servers and clients; the `mcp` package this chapter intentionally avoids to make the raw wire protocol visible.

- [MCP 2026 Roadmap — Transport Evolution](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/) — The roadmap priority on HTTP streaming and `.well-known` metadata directly affects how remote MCP servers are discovered and connected.
