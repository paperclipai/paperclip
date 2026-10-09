# Issue documents through the API

Use this procedure for requested Paperclip task documents in API-based runtimes.
Honor a destination explicitly chosen by the requester. Native Runner runtimes
use their document tool and its contract. Downloadable files follow
[artifacts.md](artifacts.md).

## Create a document

Use the injected `PAPERCLIP_API_URL` and bearer `PAPERCLIP_API_KEY`. Include
`X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on the write and send JSON with
`Content-Type: application/json`.

Choose a descriptive document key such as `report`; keys use lowercase letters,
numbers, underscores, or hyphens and are at most 64 characters. Plans use `plan`.

```text
PUT /api/issues/{issueId}/documents/{key}
```

```json
{
  "title": "Task report",
  "format": "markdown",
  "body": "# Task report\n\nThe requested findings.",
  "baseRevisionId": null
}
```

A successful write returns HTTP `201` for creation or `200` for an update,
with the saved document JSON. Check its `key`, `body`, and `latestRevisionId`
before claiming delivery. This receipt is sufficient; another GET is unnecessary
when it confirms the intended content and a saved revision.

Construct a clickable Markdown link from the current issue and successful write
receipt, then add it to the completion comment or response:

```javascript
const issuePath = issue.identifier
  ? `/${issue.identifier.split("-")[0]}/issues/${issue.identifier}`
  : `/issues/${issue.id}`;
const documentUrl = `${issuePath}#document-${saved.key}`;
const comment = `Saved [Task report](${documentUrl}).`;
```

Use the returned key: a locked document can redirect an agent's write to a new
document. Unnumbered issues use their ID; the board resolves their company.

## Update or resolve an unclear write

For an existing document, first `GET /api/issues/{issueId}/documents/{key}`
and read its body and `latestRevisionId`. Send the updated body with
`baseRevisionId` set to that revision. On `409`, fetch the latest document and
reconcile changes before retrying; preserve the skill's bounded-write retry rule.

If a write's status or receipt is unclear, GET the document to check the saved
content and revision before retrying. If delivery cannot be confirmed, report
that limitation instead of claiming the requested document was saved.
