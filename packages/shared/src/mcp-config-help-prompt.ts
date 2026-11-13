/**
 * The static prompt an operator copies and hands to an agent to get a
 * paste-ready MCP config back (PAP-17087, plan section 3A).
 *
 * This is a constant on purpose. It must never interpolate the textarea's
 * contents, the company, an endpoint, or a secret: the operator pastes it into
 * whatever chat surface they like, so anything folded in here leaves Paperclip.
 * Keeping it a constant is also what makes "opening or copying help makes no
 * connection or import request" true by construction rather than by review.
 *
 * The instructions are ordered so the *first* thing in the reply is the JSON the
 * operator has to paste, because that is the only part Paperclip's config
 * preview parser reads. Everything else is prose for the human.
 */
export const MCP_CONFIG_HELP_PROMPT = `I want to connect an MCP (Model Context Protocol) server to Paperclip, and I need a paste-ready config.

Target server: <name the server, or ask me if I have not said>

Please:

1. Confirm which MCP server this is. If I have not named one, or you are unsure which product I mean, ask me for its name or a link to its documentation before answering. Then consult the current official documentation for that server (the vendor's own docs or the server's own repository), not your memory of it.

2. Reply with one valid, paste-ready JSON object FIRST, before any prose. It must have a single top-level "mcpServers" key containing exactly one remote server entry, using:
   - the exact HTTP(S) endpoint as "url", including any required query parameters
   - the exact required header names, spelled the way the server expects them
   Example of the shape (not the values):

   {
     "mcpServers": {
       "example": {
         "url": "https://mcp.example.com/mcp",
         "headers": { "Authorization": "Bearer <YOUR_TOKEN>" }
       }
     }
   }

3. Use an obvious placeholder for every credential, like <YOUR_API_KEY>. Do not ask me to paste a real token into this conversation, do not repeat one back to me, and do not embed one in the JSON.

4. After the JSON, add short setup notes covering:
   - how I obtain each credential, step by step
   - which scopes or permissions the credential needs
   - which fields are optional and what they change
   - whether this server requires browser sign-in (OAuth) instead of headers, in which case say so plainly
   - the official documentation links you actually used

5. Do not invent fields, header names, or URLs. If you are not certain about something, say which part you are unsure about instead of guessing. If this server only runs locally as a command (stdio) and has no remote HTTP endpoint, say that the paste-a-config path does not apply, and give me the verified local command separately.`;

/**
 * What the operator needs to know about the hand-off, shown above the prompt.
 * Kept next to the prompt so the two cannot drift apart.
 */
export const MCP_CONFIG_HELP_INSTRUCTIONS = [
  "Copy this prompt and send it to an agent or assistant that can look up the server's documentation.",
  "Paste only the JSON block it replies with back into the box on this page.",
  "Paperclip reads the header names from that JSON and asks you for the values, then stores them as Paperclip secrets — so the config you paste should contain placeholders, not live credentials.",
] as const;
