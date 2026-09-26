---
name: "source-command-spartan-context-save"
description: "Manage context window — first tries /compact to free space, then saves full handoff if needed. Auto-triggered when Codex detects context pressure, or run manually anytime."
key: "paperclipai/optional/agency-agents/source-command-spartan-context-save"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "source"
  - "command"
  - "spartan"
  - "context"
  - "save"
defaultInstall: false
---
# source-command-spartan-context-save

Use this skill when the user asks to run the migrated source command `spartan-context-save`.

## Command Template

# Context Save — Smart Context Management

## Step 0: Triage — Compact or Full Save?

Assess the situation before doing a full handoff:

**Option A: Compact (stay in same session)**
If the session has useful remaining capacity and user wants to keep working:
1. Summarize the conversation so far into key decisions + current state
2. Run `/compact` to free context space
3. Continue working in the same session

Use compact when: mid-task, still productive, just need to free space.

**Option B: Full Save (end session, resume in new one)**
If the session is too deep to recover, or user is done for now:
1. Save everything to `.handoff/` file
2. Update `.memory/` with new knowledge
3. User starts fresh session and reads the handoff file

Use full save when: session > 60%, quality visibly degrading, end of work day, switching to different task.

**Auto-triggered?** When Codex detects its own context pressure (forgetting earlier context, slow responses, repeating itself), it should:
1. First try compact (Option A)
2. If already compacted once this session → go to full save (Option B)
3. Tell the user what's happening: "Context getting heavy — compacting to stay productive."

---

## Full Save Process (Option B)

## Step 1: Capture Current State

Answer these by reviewing the conversation and codebase:

**1. What was being worked on?**
(Feature name, ticket, etc.)

**2. What was completed in this session?**
(List commits made, tasks finished)

**3. What is the current status?**
(In-progress task, where exactly we stopped)

**4. What are the immediate next steps?**
(Exactly what to do next — be specific enough that a fresh agent can start without asking)

**5. What context is critical to carry forward?**
(Key decisions made, tradeoffs chosen, things tried that didn't work)

**6. What are the known risks / things to watch out for?**

---

## Step 2: Check Git State

```bash
# Uncommitted changes?
git status
git diff --stat

# Last commits this session
git log --oneline -5

# Current branch
git branch --show-current
```

If there are uncommitted changes:
- Stash them: `git stash save "wip: [description]"`
- Or commit as WIP: `git commit -m "chore: wip - [what's in progress]"`

---

## Step 3: Write Handoff File

Save as `.handoff/[YYYY-MM-DD-HH]-[feature-slug].md`:

```markdown
# Session Handoff: [feature/task name]
Created: [timestamp]
Branch: [current branch]
Author: [git user.name]

## What We Were Building
[1-2 sentences on the feature/task]

## Session Progress
### Completed ✅
- [task 1 — commit hash if available]
- [task 2]

### In Progress 🔨
- [exactly what was being done when session ended]
- Current file being edited: [path]
- Stopped at: [line/function/what was next]

## Resume Instructions
To pick up immediately:
1. `git checkout [branch]`
2. [specific command or action to run first]
3. [next step]
4. Goal: [what "done" looks like for the next session]

## Key Decisions Made This Session
- [decision 1 and why]
- [decision 2 and why]

## Things Tried That Didn't Work
- [approach X] — didn't work because [reason], don't try again
- [approach Y] — causes [problem]

## Critical Context
[Any important information that isn't obvious from the code:
- Business rules that affected implementation
- Gotchas discovered
- Dependencies or constraints to be aware of]

## Blockers / Risks
- [any outstanding questions or blockers]

## Files Modified This Session
[list of key files changed]

## Tests Status
- All tests passing: [yes/no]
- Tests added: [list]
- Known failing tests: [list if any, why]
```

---

## Step 4: Write Transcript (Layer 3 Archive)

Save a session transcript to `.memory/transcripts/[YYYY-MM-DD]-[feature-slug].md`.

This is an append-only archive. **Transcripts are never loaded into context** — they exist so future sessions can grep for past decisions, failed approaches, and context.

```markdown
# Transcript: [feature/task name]
Date: [YYYY-MM-DD]
Branch: [current branch]
Duration: [approximate session length]

## Summary
[2-3 sentences: what was attempted, what was achieved]

## Key Decisions
- [decision] — because [reason]

## Failed Approaches
- [approach] — failed because [reason]

## Discoveries
- [non-obvious fact learned during this session]

## Search Keywords
[comma-separated terms a future grep would use to find this transcript]
```

**Rules for transcripts:**
- Keep under 50 lines. This is a log, not a novel.
- The "Search Keywords" line is critical — it makes grep work. Include: feature names, file paths, error messages, library names, patterns tried.
- Never duplicate content already in `.memory/` topic files. Transcripts capture session-specific context that doesn't rise to permanent memory level.

---

## Step 5: Verify Handoff is Complete

Read back the handoff file you just wrote and confirm:
- [ ] Someone could resume without asking any questions
- [ ] The "Resume Instructions" are specific enough to act on immediately
- [ ] Git state is clean (committed or stashed)
- [ ] No context is locked in this conversation that isn't in the file
- [ ] Transcript written to `.memory/transcripts/`

---

## How to Resume in Next Session

Start the new session with:
```
Read .handoff/[filename].md and resume where we left off.
```

The fresh Codex session will have full 200k context and all the state from this file.
