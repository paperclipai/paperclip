# Auto-Unblock Plugin

Automatically unblocks a parent issue when all its child issues are resolved (done or cancelled).

## How It Works

The plugin listens for `issue.updated` events. When a child issue's status changes to `done` or `cancelled`:

1. Checks if the child issue has a parent
2. Checks if the parent issue is currently `blocked`
3. Finds all sibling issues (other children of the same parent)
4. If all siblings are `done` or `cancelled`, updates the parent status to `todo` and adds a comment
5. If some siblings are still pending, adds a comment noting the resolved dependency and remaining blockers

## Configuration

No configuration required. Install and enable the plugin — it works automatically.
