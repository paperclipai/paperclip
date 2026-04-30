---
course_slug: mcp-from-first-principles-to-production
chapter_num: 3
chapter_slug: tools-resources-prompts
title: "Tools, Resources, Prompts — the three primitives and the decision rule"
status: draft-for-review
author: course-author
date: 2026-04-30
duration_min: 40
prerequisites_chapters: [1, 2]
learning_objectives:
  - "Define each of the three MCP primitives in one precise sentence"
  - "Apply the 'who initiates, who controls, what mutates' decision rule to classify any integration requirement"
  - "Design a Resources schema for a multi-document knowledge base with URI templating"
  - "Write a Prompt template with arguments that a model can invoke by name"
key_concepts: [Tools, Resources, Prompts, URI templating, inputSchema, resource subscriptions, control flow ownership, side effects, semantic classification]
hands_on_exercise: "Given a GitHub integration spec, classify each operation as Tool/Resource/Prompt with reasoning, then implement the Resources endpoint for file reading with URI templating"
sources:
  - https://spec.modelcontextprotocol.io/specification/2025-03-26/server/tools/
  - https://spec.modelcontextprotocol.io/specification/2025-03-26/server/resources/
  - https://spec.modelcontextprotocol.io/specification/2025-03-26/server/prompts/
  - https://json-schema.org/specification
---

# Tools, Resources, Prompts — the three primitives and the decision rule

> **Prerequisites**: [[01-why-mcp-exists|Chapter 1]] (the N×M problem and host/client/server triad) and [[02-wire-protocol|Chapter 2]] (the wire protocol). You should have the echo-server from [[02-wire-protocol|Chapter 2]] working.
>
> **Time**: 40 minutes
>
> **What you'll be able to do**: By the end of this chapter, you can classify any integration requirement as Tool, Resource, or Prompt without hesitation, understand the protocol messages for each, and implement the Resources primitive with URI templating. This decision fluency is what separates an MCP server that's easy to maintain from one that gradually becomes an incoherent mess.

---

## The mistake almost every developer makes

Ask a developer to build an MCP server for their internal knowledge base. Nine out of ten will build a Tool called `search_docs` that takes a query string and returns matching documents. Fast to write. Reasonable API. Completely wrong primitive.

The knowledge base is read-only data the model should be able to *access*, not a query the model should *execute*. The correct primitive is a Resource — possibly many Resources, one per document, with a URI scheme like `docs://handbook/engineering/onboarding`. The model reads resources; the host decides which resources to surface. Conflating these means you're burning tokens on tool invocations when you could be injecting context directly, and you're losing the host's ability to pre-load commonly-needed documents before the model even asks.

Understanding the three primitives at the level of their *design intent* — not just their API shape — is the difference between an MCP server that works and one that works well.

---

## Tools — what the model executes

**One-sentence definition**: A Tool is an operation the *model* initiates that may have side effects and returns a result.

The keyword is *may have side effects*. Tools are the only MCP primitive where mutation is expected and permitted. Creating a Jira ticket, running a SQL query, sending a Slack message, executing a shell command — all of these are Tools because they change something outside the conversation.

### Wire format

Tools are declared via `tools/list` and invoked via `tools/call`. You've seen both in [[02-wire-protocol|Chapter 2]]. The critical field is `inputSchema` — a JSON Schema object that the host passes to the model to describe what arguments the tool accepts.[^1]

A well-designed `inputSchema` is worth spending time on. It directly shapes the quality of model-generated tool calls:

```json
{
  "name": "create_github_issue",
  "description": "Create a new issue in a GitHub repository. Use when the user explicitly asks to create or file a bug report or feature request.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "owner": {
        "type": "string",
        "description": "GitHub org or username that owns the repository"
      },
      "repo": {
        "type": "string",
        "description": "Repository name (without the owner prefix)"
      },
      "title": {
        "type": "string",
        "description": "Issue title. Should be concise and descriptive (under 80 characters)."
      },
      "body": {
        "type": "string",
        "description": "Issue body in GitHub-flavored Markdown. Include: description, steps to reproduce (if bug), expected vs actual behavior."
      },
      "labels": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Label names to apply. Must match existing labels in the repo.",
        "default": []
      }
    },
    "required": ["owner", "repo", "title"]
  }
}
```

<RunPromptCell
  model="claude-sonnet-4-6"
  system="You are an expert MCP server designer reviewing tool definitions for quality and correctness."
  prompt="Here is a poorly-written `inputSchema` for a `send_slack_message` tool. Identify 3 specific problems and rewrite it.\n\n```json\n{\n  \"name\": \"send_slack_message\",\n  \"description\": \"Send a message\",\n  \"inputSchema\": {\n    \"type\": \"object\",\n    \"properties\": {\n      \"channel\": { \"type\": \"string\" },\n      \"message\": { \"type\": \"string\" },\n      \"urgent\": { \"type\": \"boolean\" }\n    }\n  }\n}\n```"
  expectedOutput="A good answer identifies: (1) Description is too vague — 'Send a message' gives the model no signal about when to call it, which platform, or how channel should be formatted (Slack channel ID like C01234567 vs display name). (2) No required fields — both channel and message should be required; the model could omit them and produce an invalid call. (3) No property descriptions — the model doesn't know the channel must be a Slack channel ID, or that message supports Slack markdown, or that urgent defaults to false. The rewrite should add a useful tool description with a usage trigger, mark channel/message as required, add property descriptions with format hints, and add a default of false for urgent."
/>

Three principles for good tool schemas:
1. **The `description` field is a prompt.** The model reads it to decide when and how to call the tool. Vague descriptions produce vague calls.
2. **Required vs optional matters.** Put the minimum viable set in `required`. Optional fields with sensible defaults make the model's job easier.
3. **Enum constraints reduce hallucination.** If a field has a fixed set of valid values, use `"enum": [...]`. The model is more likely to pass valid values when it knows the allowed set.

### Control flow: model-initiated

This is the distinguishing property. The model decides *when* to call a tool, *whether* to call it at all, and *what arguments* to pass. The host can show the model a list of available tools and can execute tool calls on the model's behalf, but it cannot force the model to use a specific tool or prevent the model from calling a tool it's already seen.

This means Tools have a different security posture than Resources: any user who can talk to the model can potentially trigger any Tool in the server's list. [[04-oauth-and-auth|Chapter 4]] covers how OAuth scopes and gateway RBAC address this.

<Callout type="warn">
**Tool description is not a security boundary.** Writing "only call this tool if the user explicitly asks" in a tool description reduces inadvertent calls, but a determined prompt injection attack can cause the model to call tools regardless of description wording. The security boundary is auth (Chapter 4) and gateway RBAC (Chapter 5) — not tool description text.
</Callout>

---

## Resources — what the model reads

**One-sentence definition**: A Resource is read-only data identified by a URI that either the model or the application can inject into context.

The "either the model or the application" part is why Resources exist as a separate primitive. With Tools, only the model initiates. With Resources, the *host application* can also proactively inject resource content into context without the model asking. Claude Desktop can decide to load the contents of `file:///Users/alice/project/README.md` into context before the conversation starts. The model never had to "call" anything; the host made an editorial decision about what context to provide.

### Wire format

Resources are listed via `resources/list` and read via `resources/read`.[^2] Each resource has a URI and a MIME type:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "resources": [
      {
        "uri": "docs://handbook/engineering/onboarding",
        "name": "Engineering Onboarding Guide",
        "description": "Step-by-step guide for new engineers joining the team",
        "mimeType": "text/markdown"
      },
      {
        "uri": "docs://handbook/engineering/incident-response",
        "name": "Incident Response Runbook",
        "mimeType": "text/markdown"
      }
    ]
  }
}
```

To read a resource:

```json
→ {"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"docs://handbook/engineering/onboarding"}}

← {
    "jsonrpc":"2.0",
    "id":5,
    "result":{
      "contents":[
        {
          "uri":"docs://handbook/engineering/onboarding",
          "mimeType":"text/markdown",
          "text":"# Engineering Onboarding Guide\n\n## Week 1\n..."
        }
      ]
    }
  }
```

The content can be `text` (for text/markdown, text/plain, application/json) or `blob` (base64-encoded binary, for images, PDFs, etc.).[^2]

### URI templating: the power feature

Static URIs are fine for a fixed set of resources. Real-world resources are dynamic: files in a repo, rows in a database, objects in S3. For these, MCP supports **resource templates** — URI patterns with variable placeholders:[^2]

```json
{
  "uriTemplate": "github://{owner}/{repo}/blob/{branch}/{path}",
  "name": "GitHub file content",
  "description": "Read the content of any file in any GitHub repository at any branch",
  "mimeType": "text/plain"
}
```

The `{owner}`, `{repo}`, `{branch}`, and `{path}` placeholders follow RFC 6570 URI Template syntax.[^4] The host expands the template with actual values (either model-generated or app-provided) and sends the expanded URI in `resources/read`.

This enables a single resource template to represent billions of concrete resources — every file, in every repo, at every branch — without the server having to enumerate them.

### Resource subscriptions

For resources that change (a live config file, a database view, real-time metrics), the server can support subscriptions. The client sends `resources/subscribe` with a URI; the server sends `notifications/resources/updated` when the content changes. The client then re-reads the resource.

This is the pull-on-push pattern: notifications tell you something changed; you fetch the new content yourself. The server never pushes large payloads proactively.

<RunPromptCell
  model="claude-sonnet-4-6"
  system="You are an MCP server designer. Give concrete, specific answers."
  prompt="I'm building an MCP server for a company's internal documentation system (Confluence-like). The system has: 10,000 pages, 500 spaces, real-time page updates when editors save. Design the Resources schema: (1) What URI scheme would you use? (2) Would you use static resources, resource templates, or both? (3) Would you enable subscriptions? Justify each decision with specific reasoning about the production implications."
  expectedOutput="A good answer: (1) URI scheme like docs://{space}/{page-id} or docs://{space}/{page-slug} — page-slug is human-readable but can have conflicts; page-id is stable. (2) Resource templates for individual pages (can't enumerate 10k pages statically), plus static resources for space/index pages. (3) Yes subscriptions — editors saving pages should push updates to clients that have loaded the page into context; otherwise stale content is injected. The answer should also flag that 10k pages is too many for a full static list — pagination via cursor is needed."
/>

---

## Prompts — what the user selects

**One-sentence definition**: A Prompt is a user-initiated, parameterised message template that the host exposes as a selectable option in its UI.

This is the least-understood primitive. Many developers skip Prompts entirely because they look optional — and they're wrong.

The key distinction: **Tools are model-initiated; Prompts are user-initiated.** The user looks at a menu of available Prompts in their host application, selects one (like selecting a Slash Command), fills in the arguments, and the host renders the Prompt template into a message that kicks off the conversation.

### Wire format

Prompts are listed via `prompts/list` and fetched via `prompts/get`:[^3]

```json
{
  "prompts": [
    {
      "name": "code_review",
      "description": "Generate a thorough code review for a pull request",
      "arguments": [
        {
          "name": "pr_url",
          "description": "GitHub pull request URL",
          "required": true
        },
        {
          "name": "focus",
          "description": "What to focus on: security, performance, style, or all",
          "required": false
        }
      ]
    }
  ]
}
```

When the user selects this prompt and provides arguments, the host sends `prompts/get`:

```json
→ {
    "jsonrpc":"2.0","id":6,"method":"prompts/get",
    "params":{
      "name":"code_review",
      "arguments":{
        "pr_url":"https://github.com/anthropics/sdk-python/pull/847",
        "focus":"security"
      }
    }
  }

← {
    "jsonrpc":"2.0","id":6,
    "result":{
      "description":"Code review prompt for PR #847",
      "messages":[
        {
          "role":"user",
          "content":{
            "type":"text",
            "text":"Please review this pull request with a focus on security vulnerabilities:\n\nhttps://github.com/anthropics/sdk-python/pull/847\n\nFor each issue found:\n1. Describe the vulnerability\n2. Assess the severity (critical/high/medium/low)\n3. Suggest a specific fix\n4. Note any positive security practices you observe"
          }
        }
      ]
    }
  }
```

The server returns rendered messages — the actual text that will be injected into the conversation. The Prompt is the template; `prompts/get` with arguments is the render step.

<RunPromptCell
  model="claude-sonnet-4-6"
  system="You are an MCP server designer. Give concrete, specific wire-format examples."
  prompt="Design a `prompts/list` response for a customer-support MCP server. Then show the `prompts/get` response for one of those prompts with realistic arguments filled in."
  expectedOutput="A good answer: prompts/list should have 2-4 prompts such as 'draft_reply' (arguments: ticket_id, tone), 'summarise_ticket' (arguments: ticket_id), 'escalation_template' (arguments: ticket_id, reason). The prompts/get response should show a realistic messages array — the actual rendered text with argument values substituted in — not just a template string. The rendered message should be something a support agent would actually send, with the ticket context embedded."
/>

### When Prompts beat system prompts

Prompts have a structural advantage over static system prompt text: they're discoverable, named, and parameterised at runtime. A host application can show users a searchable library of available Prompts across all connected MCP servers. This is the equivalent of Slash Commands in Slack or Linear — a user interface for structured intent.

Use a Prompt when:
- The task is user-initiated and repeatable (code review, draft an email, analyse a document)
- The task has well-known arguments that vary per invocation
- You want the task to appear as a named, discoverable option in the host UI

<KnowledgeCheck
  question="A developer wants users to be able to generate a weekly status report by filling in 'team name' and 'date range'. Should this be a Tool, Resource, or Prompt?"
  options={[
    "Tool — the model decides when to generate it",
    "Resource — the report data is read-only",
    "Prompt — user-initiated, parameterised, repeatable template",
    "None of the above"
  ]}
  correctIdx={2}
  explanation="Prompts are the right primitive for user-initiated, parameterised, repeatable tasks. The user selects 'Weekly Status Report', fills in team and date range, and the host renders the template. A Tool would put the model in charge of initiating it. A Resource is for data the host injects, not conversation templates."
/>

---

## The decision rule

Every integration requirement can be classified with three questions:

**Who initiates?**
- Model decides autonomously → **Tool**
- User selects from a menu → **Prompt**
- App pre-loads into context (or model requests by URI) → **Resource**

**What does it do?**
- May write, create, delete, or trigger side effects → **Tool** (not Resource, never Prompt)
- Reads data, produces output → could be Tool or Resource; continue to next question
- Provides a structured conversation template → **Prompt**

**Who should control the access policy?**
- App/platform makes a policy decision about what data is available → **Resource**
- Model decides dynamically based on conversation context → **Tool**

As a quick-reference table:

| Requirement | Primitive | Why |
|---|---|---|
| Search internal Slack messages | Tool | Model-initiated, returns results on demand |
| Current on-call schedule (read-only, changes daily) | Resource | App can pre-load; model reads by URI; no side effects |
| Create a Jira ticket | Tool | Side effects (creates an object); model-initiated |
| "Draft incident post-mortem" template | Prompt | User-selected; parameterised by incident ID |
| List all employees in HR system | Resource (template) | Read-only data; URI scheme `hr://employees` |
| Provision a cloud VM | Tool | Irreversible side effect; model-initiated with confirmation |
| Coding style guidelines document | Resource | Static content; app pre-loads into context |
| "Explain this error" workflow | Prompt | User-initiated; arguments: error message, language |

<RunPromptCell
  model="claude-sonnet-4-6"
  system="You are an MCP server designer applying the three-question decision rule rigorously."
  prompt="A team wants to add 'get recent alerts from PagerDuty (last 24 hours)' to their MCP server. Apply the three-question decision rule and classify it as Tool, Resource, or Prompt. Justify each answer."
  expectedOutput="A good answer works through all three questions: (1) Who initiates? — This is ambiguous; could be model-initiated on demand (Tool) or app-pre-loaded (Resource). The 'last 24 hours' filter makes it dynamic. (2) What does it do? — Read-only, no side effects — could be Tool or Resource. (3) Who controls access policy? — The on-call team's tooling (app) decides what alert data is available; the model doesn't need to decide dynamically. Best classification: Resource with a URI like pagerduty://alerts/recent and a subscription for live updates. The model or host can read it by URI. A Tool would be correct only if the query needs dynamic parameters (e.g. arbitrary time ranges the model decides on). The answer should flag the tradeoff between static Resource (simpler, cacheable) and dynamic Tool (flexible query)."
/>

<KnowledgeCheck
  question="Your team's MCP server has a tool called get_current_user_profile that takes no arguments and returns the authenticated user's profile JSON. It's called at the start of almost every conversation. What's wrong with this design and what's the better primitive?"
  options={[
    "Nothing is wrong — a zero-argument Tool is valid MCP",
    "It should be a Resource at a URI like user://me/profile, so the host can pre-load it without a tool call",
    "It should be a Prompt that renders the profile into a system message",
    "Tools must have at least one argument; zero-argument tools are invalid MCP"
  ]}
  correctIdx={1}
  explanation="A zero-argument Tool that returns static (per-session) data is a Resource in disguise. Every time the model calls this Tool, it's spending an LLM inference turn and a round-trip to the server just to fetch data that the host could have pre-loaded. The correct design is a Resource at a URI like user://me/profile. The host loads it at session start and injects it into context. The model never has to 'ask' for it."
/>

---

## Hands-on exercise: classify and implement a GitHub integration

**Part 1 — Classification (10 min)**

Given this GitHub integration requirements list, classify each as Tool, Resource, or Prompt with one sentence of justification:

1. List all open pull requests for a repository
2. Read the content of any file at any commit SHA
3. Create a new pull request
4. Get the authenticated user's GitHub profile (read-only, stable per session)
5. Search code across all repos by keyword
6. "Write a release announcement" template that takes version number and changelog
7. Get the CI/CD status for a specific commit SHA
8. Subscribe to PR review notifications

**Reference answers**:
1. **Tool** — model-initiated, read-only but dynamic (PRs change constantly); needs to be on-demand
2. **Resource** — URI template `github://{owner}/{repo}/blob/{sha}/{path}`, read-only, model or app can load by URI
3. **Tool** — creates a new object (side effect), model-initiated with arguments
4. **Resource** — URI `github://user/profile`, stable per session, host pre-loads
5. **Tool** — model-initiated search across a dynamic corpus; results change; side-effect-free but dynamic
6. **Prompt** — user-selected template, arguments: version and changelog text
7. **Resource** — URI `github://{owner}/{repo}/commit/{sha}/status`, read-only status object
8. **(Trick question)** — notification subscriptions are not a primitive; they're a transport feature of Resources that support `subscribe`. This is a Resource with subscription enabled.

**Part 2 — Implement the Resources endpoint (10 min)**

Add a `resources/list` and `resources/read` handler to the echo server from Chapter 2. Implement the GitHub file resource with URI templating.

```python
import re

# Add to RESOURCE_TEMPLATES list:
RESOURCE_TEMPLATES = [
    {
        "uriTemplate": "github://{owner}/{repo}/blob/{branch}/{path}",
        "name": "GitHub file content",
        "description": "Read a file from a GitHub repository at a specific branch",
        "mimeType": "text/plain"
    }
]

# URI pattern for matching
GITHUB_FILE_RE = re.compile(r"^github://(?P<owner>[^/]+)/(?P<repo>[^/]+)/blob/(?P<branch>[^/]+)/(?P<path>.+)$")

def handle_resource_read(uri: str, req_id) -> None:
    m = GITHUB_FILE_RE.match(uri)
    if not m:
        send(error_response(req_id, -32602, f"Unsupported resource URI: {uri}"))
        return
    owner, repo, branch, path = m.group("owner"), m.group("repo"), m.group("branch"), m.group("path")
    # In a real server: fetch from GitHub API with auth
    # For this exercise: return a simulated response
    content = f"# Simulated content\nowner={owner}, repo={repo}, branch={branch}, path={path}"
    send({
        "jsonrpc": "2.0", "id": req_id,
        "result": {
            "contents": [{"uri": uri, "mimeType": "text/plain", "text": content}]
        }
    })

# Add to handle():
elif method == "resources/list":
    send({"jsonrpc":"2.0","id":req_id,"result":{"resources":[],"resourceTemplates":RESOURCE_TEMPLATES}})
elif method == "resources/read":
    handle_resource_read(params.get("uri",""), req_id)
```

**Verification**: Test with:
```bash
echo '{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"github://anthropics/sdk-python/blob/main/README.md"}}' | python3 echo_server.py
```

Confirm you get a valid `result.contents` response, not an error.

<KnowledgeCheck
  question="In your own words: describe a real integration from your work (or a tool you use daily) where the wrong choice between Tool and Resource would cause a measurable quality problem — either wasted tokens, stale context, or missed capability. Be specific about what the right choice is and why."
  options={["self-check"]}
  correctIdx={0}
  explanation="Strong answers are concrete and specific. Example of a strong answer: 'Our team's MCP server has a tool called get_company_policy that returns a 3000-word document. Every conversation starts with the model calling it. Using Tool instead of Resource means: (1) a tool call round-trip at the start of every conversation (~1 second latency), (2) the model has to explicitly decide to call it rather than the host injecting it. Changing to Resource lets the host pre-load it; the model doesn't waste a turn fetching context it always needs.'"
/>

---

## What's next

In [[04-oauth-and-auth|Chapter 4]], we address the question that security teams ask immediately: "Who is allowed to call these tools?" You've built a server that responds to any client. Chapter 4 wires up OAuth 2.1 with DPoP token binding so your server can verify the identity of callers, reject unauthorized requests with properly structured errors, and emit an audit trail that names who called what.

---

## References cited

[^1]: [MCP Tools Specification](https://spec.modelcontextprotocol.io/specification/2025-03-26/server/tools/) — Defines the `tools/list`, `tools/call` protocol, `inputSchema` (JSON Schema), and the `isError` vs JSON-RPC error distinction.

[^2]: [MCP Resources Specification](https://spec.modelcontextprotocol.io/specification/2025-03-26/server/resources/) — Defines `resources/list`, `resources/read`, resource templates (RFC 6570 URI Templates), subscriptions, and MIME type handling.

[^3]: [MCP Prompts Specification](https://spec.modelcontextprotocol.io/specification/2025-03-26/server/prompts/) — Defines `prompts/list`, `prompts/get`, argument specification, and the rendered message format.

[^4]: [RFC 6570 — URI Template (IETF)](https://www.rfc-editor.org/rfc/rfc6570) — Defines the URI template syntax used by MCP resource templates.

- [JSON Schema Specification](https://json-schema.org/specification) — The schema format used for `inputSchema` in tool definitions.
