# Example: Research and Gate a Notion MCP Connection

## Input

> Research Notion's hosted MCP server and prepare it for Paperclip. Start from
> the vendor documentation URL. Do not build the connector until I approve the
> research.

## Application

1. Read the current `paperclip-content/integrations/README.md` and integration
   harness from the content target commit.
2. Research the official Notion MCP, OAuth, scopes, tools, limits, and admin
   setup. Record URLs and access dates, and mark unknowns rather than guessing.
3. Reconcile existing Notion integration artifacts and open PRs before adding
   or changing catalog content.
4. Open a research-only `paperclip-content` PR containing the planning package
   required by the integrations playbook.
5. Record the research PR head SHA and proposed connection set in an issue
   document, then request confirmation against that exact revision.
6. Stop with the issue in review. No Paperclip App branch exists yet.

## Gate Output

```text
Research PR: https://github.com/paperclipai/paperclip-content/pull/123
Research head: 0123456789abcdef0123456789abcdef01234567
Content source: 89abcdef0123456789abcdef0123456789abcdef
App source: fedcba9876543210fedcba9876543210fedcba98
Proposed connection set:
- notion-mcp: one OAuth credential owner, hosted MCP endpoint, and independently
  reviewable Notion action catalog
Known limitations:
- Production OAuth consent still requires credentialed QA after approval.
Next action:
- Human confirms or rejects this exact research revision.
```

After acceptance, create one isolated Paperclip App worktree and PR for
`notion-mcp`, reread the current Connector Playbook, and follow its current
implementation and validation requirements. If research reveals a reusable
OAuth or documentation rule, update the owning upstream playbook in the
appropriate PR before declaring the connector merge-ready.
