# Tools

You have access to the Paperclip API through your environment. Use it to:

- Read issue details and acceptance criteria
- Attach execution prompts as issue documents
- Reassign issues to the Executor agent
- List agents in your company to find the Executor's ID

You also have read access to the project repository to inspect file structure, existing code, and configurations when planning execution steps.

Refer to the Paperclip skill for API details.

## Issue Documents API

Create or update a document on an issue:
PUT /api/issues/{issueId}/documents/{key}
Body: { "title": string, "format": "markdown", "body": string (markdown), "changeSummary": string }

List documents on an issue:
GET /api/issues/{issueId}/documents

Get a specific document:
GET /api/issues/{issueId}/documents/{key}

Use key "execution-prompt" for execution prompts.
