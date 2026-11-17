# Remote MCP call errors

The tool gateway maps a top-level JSON-RPC error from a remote tool call or
context read to HTTP 502 with reason `remote_mcp_error`. It keeps the upstream
numeric code and the connection identifiers in error details.

When the upstream error has a non-empty string message, the gateway appends it
as `Upstream message (untrusted): ...`. This is provider content, not an
instruction or a Paperclip policy decision. The message uses the existing secret
redactors. The gateway also removes known request header values, sensitive
argument values, and endpoint query values before it clips the provider message
to 1,000 characters. Control characters are removed. An absent or malformed
message keeps the generic fallback.

Arbitrary upstream `error.data`, stacks, and raw response bodies are not returned.
The same safe message is used for caller errors and saved invocation failures.
HTTP and MCP caller envelopes omit the internal execution audit record.
This does not change approval, credential, retry, or connection health rules.
A tool result with `isError: true` still uses the normal result-content validation
path. Previously saved generic messages cannot recover discarded provider text.
