# Human-in-the-Loop

Choose the approval layer based on where execution must pause, then fetch its current documentation:

| Need | Documentation |
|------|---------------|
| Approve chat tool execution or run a browser-side tool | [Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) — `needsApproval`, approval responses, client tools, and custom denial messages |
| Pause a durable background task or collect MCP input | [Human-in-the-loop patterns](https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/) — workflow approval, timeout handling, and elicitation |

Distinguish approval responses from client tool outputs. When returning a custom tool error, check whether an explicit continuation is needed. Handle workflow approval timeouts before executing the gated action. Check installed SDK versions before adapting examples.
