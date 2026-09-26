---
name: "source-command-spartan-magic-doc"
description: "Auto-update a single documentation file based on current codebase state. A scoped agent reads the target doc, analyzes the code, and rewrites it to stay current. Use when docs drift from reality."
key: "paperclipai/optional/agency-agents/source-command-spartan-magic-doc"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "source"
  - "command"
  - "spartan"
  - "magic"
  - "doc"
defaultInstall: false
---
# source-command-spartan-magic-doc

Use this skill when the user asks to run the migrated source command `spartan-magic-doc`.

## Command Template

# Magic Doc — Self-Updating Documentation

Inspired by the "Magic Docs" pattern: a scoped agent updates ONE documentation file to match the current state of the codebase. The agent can only edit that one file — nothing else.

## Usage

```
/spartan:magic-doc <file-path>           # Update a specific doc
/spartan:magic-doc                        # Auto-detect stale docs
```

## Process

### Step 1: Identify the Target Doc

If a file path is provided, use it. If not, scan for common doc files and ask:

**Auto-detect candidates:**
- `AGENTS.md` (project instructions)
- `README.md` (project readme)
- `.planning/design-config.md` (design system config)
- `.memory/index.md` (memory index)
- Any `.md` file in the project root

Present the list and ask: "Which doc should I update?"

### Step 2: Read Current Doc State

Read the target file completely. Note:
- What sections exist
- What facts/claims it makes about the codebase
- What code paths, files, or features it references
- When it was last modified (via `git log -1 <file>`)

### Step 3: Verify Claims Against Code

For each factual claim in the doc:

1. **File references** — Does the file still exist? Has it moved?
2. **Code patterns** — Does the code still work this way?
3. **Command references** — Do the commands still exist?
4. **Feature descriptions** — Are features still implemented as described?
5. **Config examples** — Do config files match the examples shown?

Use Glob, Grep, and Read to verify. Keep a list of:
- Verified (still accurate)
- Stale (outdated or wrong)
- Missing (exists in code but not documented)

### Step 4: Detect Undocumented Changes

Look for things that should be in the doc but aren't:

- New files/directories created since the doc was last updated
- New commands or skills added
- Changed patterns or conventions
- Removed features still mentioned in the doc

```bash
# Files changed since doc was last updated
git log -1 --format="%H" -- <doc-file>
git diff --name-only <that-hash>..HEAD
```

### Step 5: Rewrite the Doc

Apply updates to the target file ONLY:

**Rules:**
- Keep the existing structure and tone
- Fix stale references with current info
- Add new sections for undocumented features
- Remove sections for deleted features
- Do NOT change the doc's purpose or scope
- Do NOT add sections the original author didn't intend
- Do NOT touch any other file

### Step 6: Show the Diff

Present a summary of changes:

```markdown
## Magic Doc Update: <filename>

### Fixed (stale → current)
- [what changed and why]

### Added (undocumented → documented)
- [new content added]

### Removed (no longer exists)
- [content removed]

### Unchanged
- [N sections verified and still accurate]
```

Ask the user: "Apply these changes?"

### Step 7: Apply

Edit the file with the approved changes.

## Scope Restriction (CRITICAL)

The agent updating the doc MUST NOT:
- Edit any file other than the target doc
- Create new files
- Run any destructive commands
- Modify code to match the doc (the doc matches the code, never the reverse)

This is a READ-code, WRITE-one-doc operation. Nothing else.

## Gotchas

- **Don't rewrite the whole file.** Only change what's actually stale. Preserve the author's voice and structure.
- **Don't add boilerplate.** If the original doc is terse, keep it terse. Don't pad with generic descriptions.
- **Don't document internal implementation details.** Only document what the original doc's audience needs. A README doesn't need internal class names.
- **git log is your source of truth for "what changed."** Don't guess — check the actual diff since last doc update.
- **AGENTS.md has special rules.** It's assembled from multiple sources. Only update the project-specific sections, not the assembled output.
