# Shared Protocols

This document contains protocols and procedures shared across all Paperclip agents.

## Checkpoint Document Protocol

To prevent context window exhaustion and enable reliable heartbeat resumption, agents should use checkpoint documents to preserve execution state across runs.

### When to Create/Update Checkpoints

Create or update a `run-state` checkpoint document after each major action:
- Issue checkout
- Significant progress comment posted
- Subtask created
- Delegation performed
- Major file edit or code change completed
- Before marking an issue as blocked or done

### Checkpoint Format

Use the issue document API to create/update a document with key `run-state`:

```bash
PUT /api/issues/{issueId}/documents/run-state
{
  "title": "Run State Checkpoint",
  "format": "markdown",
  "body": "# Run State Checkpoint\n\n## Completed Actions\n...\n\n## Next Planned Action\n...\n\n## Context for Resume\n...",
  "baseRevisionId": null  # or current revision ID if updating
}
```

### Document Structure

The checkpoint document should contain three sections:

1. **Completed Actions** — bulleted list of what has been done so far in this run
   - Checkout performed
   - Files read/analyzed
   - Code changes made
   - Tests run
   - Comments posted
   - Subtasks created

2. **Next Planned Action** — what you intend to do next
   - Next file to edit
   - Next test to run
   - Next API call to make
   - Decision point or blocker to resolve

3. **Context for Resume** — key context needed if the heartbeat is interrupted and resumed later
   - Issue identifier and summary
   - File paths and line numbers
   - Important decisions made
   - Temporary state or variables
   - Links to related issues or PRs

### On Heartbeat Resume

Before starting work on an `in_progress` issue, check for an existing `run-state` document:

```bash
GET /api/issues/{issueId}/documents/run-state
```

If the document exists:
1. Read the checkpoint to understand what was already completed
2. Review the next planned action
3. Use the context to resume work efficiently
4. Update the checkpoint after each major action

If the document doesn't exist and the issue is `in_progress`:
1. Review the issue comment thread to understand prior work
2. Create an initial checkpoint before proceeding
3. Continue with normal heartbeat procedure

### Benefits

- **Context preservation**: Survive heartbeat timeouts without losing progress
- **Efficient resumption**: Skip redundant work when resuming an interrupted task
- **Audit trail**: Clear record of execution flow for debugging and review
- **Budget efficiency**: Avoid re-reading entire codebases or re-analyzing already-understood context

### Example

```markdown
# Run State Checkpoint

## Completed Actions
- ✅ Checked out issue ANGA-829
- ✅ Retrieved heartbeat context and comments
- ✅ Analyzed 11 agent AGENTS.md files
- ✅ Applied max-issues-per-heartbeat edits to all files
- ✅ Edits successfully written to disk

## Next Planned Action
- Create shared protocols documentation
- Then commit changes and create PR
- Finally update issue status to done

## Context for Resume
- Working on ANGA-829: Define max-3-issues-per-heartbeat rule and checkpoint docs
- Target files in server/src/onboarding-assets/ and cowork/agents/
- Manager agents (CEO, CTO, Operations Lead): max 3 issues per heartbeat
- Worker agents (all others): max 1-2 issues per run
- All edits successfully applied, ready for commit
- Branch: feature/anga-829-max-issues-per-heartbeat
```

## Blocked-on-Human / CEO Strategy Approval Protocol

(To be documented — referenced by multiple agent files but not yet defined)
