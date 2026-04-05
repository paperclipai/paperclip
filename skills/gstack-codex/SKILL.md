---
name: gstack-codex
description: >
  OpenAI Codex CLI wrapper — three modes. Code review: independent diff review via
  codex review with pass/fail gate. Challenge: adversarial mode that tries to break
  your code. Consult: ask codex anything with session continuity for follow-ups.
  The "200 IQ autistic developer" second opinion. Use when asked to "codex review",
  "codex challenge", "ask codex", "second opinion", or "consult codex".
---

# /gstack-codex — Multi-AI Second Opinion

You are running the `/gstack-codex` skill. This wraps the OpenAI Codex CLI to get an independent, brutally honest second opinion from a different AI system.

Codex is the "200 IQ autistic developer" — direct, terse, technically precise, challenges assumptions, catches things you might miss. Present its output faithfully, not summarized.

---

## Step 0: Check codex binary

```bash
CODEX_BIN=$(which codex 2>/dev/null || echo "")
[ -z "$CODEX_BIN" ] && echo "NOT_FOUND" || echo "FOUND: $CODEX_BIN"
```

If `NOT_FOUND`: stop and tell the user:
"Codex CLI not found. Install it: `npm install -g @openai/codex`"

---

## Step 1: Detect mode

Parse the user's input to determine which mode to run:

1. `codex review` or `codex review <instructions>` — **Review mode** (Step 2A)
2. `codex challenge` or `codex challenge <focus>` — **Challenge mode** (Step 2B)
3. `codex` with no arguments — **Auto-detect:**
   - Check for a diff against base branch
   - If a diff exists, ask what to do (review, challenge, or consult)
   - If no diff, check for plan files and offer to review
4. `codex <anything else>` — **Consult mode** (Step 2C)

---

## Step 2A: Review Mode

Run Codex code review against the current branch diff.

1. Detect base branch:
   ```bash
   gh pr view --json baseRefName -q .baseRefName 2>/dev/null || \
   gh repo view --json defaultBranchRef -q .defaultBranchRef.name
   ```

2. Run the review:
   ```bash
   codex review --base <base> -c 'model_reasoning_effort="high"' --enable web_search_cached
   ```

3. Determine gate verdict:
   - If output contains `[P1]` — **FAIL**
   - If no `[P1]` markers — **PASS**

4. Present the output:
   ```
   CODEX SAYS (code review):
   ════════════════════════════════════════════════════════════
   <full codex output, verbatim — do not truncate>
   ════════════════════════════════════════════════════════════
   GATE: PASS (or FAIL with N critical findings)
   ```

5. **Cross-model comparison:** If `/gstack-review` was already run earlier, compare findings:
   ```
   CROSS-MODEL ANALYSIS:
     Both found: [overlapping findings]
     Only Codex found: [unique to Codex]
     Only Claude found: [unique to Claude]
     Agreement rate: X%
   ```

---

## Step 2B: Challenge (Adversarial) Mode

Codex tries to break your code — finding edge cases, race conditions, security holes, and failure modes.

Default prompt:
"Review the changes on this branch against the base branch. Your job is to find ways this code will fail in production. Think like an attacker and a chaos engineer. Find edge cases, race conditions, security holes, resource leaks, failure modes, and silent data corruption paths. Be adversarial. Be thorough. No compliments — just the problems."

With focus (e.g., "security"):
"Review the changes on this branch against the base branch. Focus specifically on SECURITY. Your job is to find every way an attacker could exploit this code. Be adversarial."

Run:
```bash
codex exec "<prompt>" -s read-only -c 'model_reasoning_effort="xhigh"' --enable web_search_cached
```

Present the full output.

---

## Step 2C: Consult Mode

Ask Codex anything about the codebase. Supports session continuity.

1. **Check for existing session:**
   ```bash
   cat .context/codex-session-id 2>/dev/null || echo "NO_SESSION"
   ```

2. If session exists, ask user: "You have an active Codex conversation. Continue it or start fresh?"

3. **Plan review auto-detection:** If user's prompt is about reviewing a plan, prepend:
   "You are a brutally honest technical reviewer. Review this plan for: logical gaps, missing error handling, overcomplexity, feasibility risks, and missing dependencies. Be direct. Be terse. No compliments."

4. Run codex exec and capture session ID for follow-ups.

5. Save session ID to `.context/codex-session-id`

6. Present the output:
   ```
   CODEX SAYS (consult):
   ════════════════════════════════════════════════════════════
   <full output, verbatim>
   ════════════════════════════════════════════════════════════
   Session saved — run /gstack-codex again to continue this conversation.
   ```

---

## Error Handling

- **Binary not found:** Detected in Step 0. Stop with install instructions.
- **Auth error:** Tell user: "Codex authentication failed. Run `codex login`."
- **Timeout:** If 5 min timeout, suggest smaller scope.
- **Session resume failure:** Delete session file and start fresh.

---

## Important Rules

- **Never modify files.** This skill is read-only.
- **Present output verbatim.** Do not truncate or summarize.
- **5-minute timeout** on all Bash calls to codex.
- **No double-reviewing.** If user ran `/gstack-review`, Codex provides second opinion.
