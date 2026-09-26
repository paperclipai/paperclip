# Streaming Chat with AIChatAgent

Use `AIChatAgent` for persisted conversations with streaming and tools; use callable streaming RPC for non-chat output. Before adapting an existing app, check its installed `agents`, `@cloudflare/ai-chat`, and AI SDK versions against the current docs.

Read the relevant documentation before implementing:

| Task | Documentation |
|------|---------------|
| Build a chat agent | [Chat agent example](https://developers.cloudflare.com/agents/examples/chat-agent/) — setup, provider, server, and UI |
| Implement or customize chat | [Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) — message format, tools, custom streams, persistence, concurrency, cancellation, and recovery |
| Connect a client | [Client guidance](client-sdk.md) — React, vanilla JS, HTTP, and authentication |
| Stream non-chat results | [Callable methods](https://developers.cloudflare.com/agents/runtime/lifecycle/callable-methods/) — server and client streaming RPC |
| Trigger background turns | [Server-driven messages](server-driven-messages.md) |
| Add approvals | [Human-in-the-loop](human-in-the-loop.md) |

Forward the request abort signal to the model call so cancellation stops generation. When customizing streams, verify persistence and completion behavior for the installed version. Treat client reconnection and Durable Object eviction as separate recovery cases.
