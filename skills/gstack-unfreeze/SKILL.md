---
name: gstack-unfreeze
description: >
  Remove the edit restriction set by /gstack-freeze. Allows edits to any file
  again. Use when asked to "unfreeze", "remove restriction", "unlock edits",
  or "allow all edits".
---

# /gstack-unfreeze — Remove Edit Restrictions

Remove the freeze boundary set by `/gstack-freeze`. After running this, edits are allowed to any file in the project.

## Usage

Simply inform the user: "Edit restrictions removed. You can now edit files anywhere in the project."

## Notes

- If no freeze was active, this is a no-op — just inform the user "No freeze boundary was set."
- The freeze is session-scoped, so ending the conversation also removes it.
