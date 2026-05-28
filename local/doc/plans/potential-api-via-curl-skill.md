# Control Plane curl Instructions for `openrouter-local`

The `openrouter-local` adapter supports models that may lack native OpenAI tool-calling support. When they do, agents waste tokens discovering how to interact with the Paperclip API. Pre-injecting explicit `curl` instructions eliminates that overhead.

## Scope

This instruction injection should be **conditional**: apply only to models that do not advertise native tool-calling support. The adapter already fetches model metadata from the OpenRouter `/models` API, so the capability check is available at request time. Injecting these instructions for all models wastes tokens and risks confusing capable models that already have proper tool definitions.

## Recommended Approach: Conditional Workspace Bundle

Add a `CONTROL_PLANE.md` file to the agent workspace and update `DEFAULT_BUNDLE_FILENAMES` in `instructions.ts` to include it — but load it only when the selected model lacks tool support.

This is preferred over adapter-level system-prompt injection (prepending in `execute.ts`) because:
- The workspace bundle is observable and editable per-deployment without touching adapter source.
- It keeps infrastructure (the adapter) free of business logic.
- Conditional loading ensures capable models are unaffected.

## Instruction Content

The following should be the content of `CONTROL_PLANE.md`:

---

### Paperclip Control Plane Integration
You are a Paperclip Agent. You can interact with the Paperclip Control Plane API using `curl` via the `run_command` tool.

**Environment Variables:**
- `PAPERCLIP_API_URL`: Base URL for the API.
- `PAPERCLIP_API_KEY`: Your authentication token (use in `Authorization: Bearer` header).
- `PAPERCLIP_AGENT_ID`: Your unique agent identifier.
- `PAPERCLIP_COMPANY_ID`: Your company identifier.

**Common API Operations:**

1. **List your assigned issues:**
   ```bash
   curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?assignee_agent_id=$PAPERCLIP_AGENT_ID"
   ```

2. **Checkout an issue (start work):**
   ```bash
   curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     -H "Content-Type: application/json" \
     -d "{\"agentId\": \"$PAPERCLIP_AGENT_ID\", \"expectedStatuses\": [\"todo\", \"backlog\", \"blocked\", \"in_review\"]}" \
     "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/checkout"
   ```

3. **List comments on an issue:**
   ```bash
   curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/comments"
   ```

4. **Add a comment to an issue:**
   ```bash
   curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     -H "Content-Type: application/json" \
     -d "{\"body\": \"Your comment here.\"}" \
     "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/comments"
   ```

5. **Complete an issue (set status to done):**
   ```bash
   curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     -H "Content-Type: application/json" \
     -d "{\"status\": \"done\"}" \
     "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID"
   ```

---

## Verification Plan

1. Deploy an agent using the `openrouter-local` adapter with a model that lacks native tool support (e.g., a small Llama model). Confirm the adapter detects this and loads `CONTROL_PLANE.md`.
2. Observe the initial turns: the agent should use `curl` immediately rather than attempting API discovery.
3. Verify the `curl` commands succeed and the agent can progress its tasks.
4. Deploy with a model that has native tool support (e.g., a GPT-4-class model). Confirm `CONTROL_PLANE.md` is **not** loaded and tool calls work normally.
