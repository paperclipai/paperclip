---
title: Feature Support Case Assessment — Ask Work Mode
summary: Support reference for the Ask Work Mode feature (shipped v2026.626.0)
version: v2026.626.0
---

# Support Case Assessment: Ask Work Mode

## Feature Summary

Ask Work Mode lets you create an issue that is treated as a question-and-answer task rather than a full execution workflow. When an agent wakes on an ask-mode issue, it receives a directive to answer the question directly in the issue thread — without writing implementation code or producing an implementation plan.

## User-Facing Behavior

### Creating an Ask Mode Issue

- When creating a new issue, select "Ask mode" from the work mode selector
- The issue composer shows the ask mode badge
- Existing issues can be switched to ask mode via the work mode dropdown

### What the Agent Does

1. Reads the issue description and any wake comment
2. Receives an explicit directive: "Answer the question directly in the issue thread. Do not write implementation code, and do not produce an implementation plan. Use tools only for investigation or temporary scratch work when needed; the deliverable is the answer."
3. Posts the answer as a comment on the issue
4. The agent may use tools for investigation (e.g., reading files, running queries) but the deliverable is commentary, not code

### Key Differences from Standard Mode

| Aspect | Standard Mode | Ask Mode |
|--------|---------------|----------|
| Agent directive | Implement the task | Answer the question |
| Deliverable | Code, artifacts, or configuration | Comment with answer |
| Work products | Creates files, PRs, etc. | Creates comment only |
| Planning | May create plans | No planning |
| Child issues | May create child issues | No child issues |

## Known Issues & Limitations

### 1. Agent May Still Write Scratch Code

The agent is instructed not to write implementation code, but it may write temporary investigation scripts or queries. These are considered scratch work and should be discarded when the answer is delivered. If the agent persists implementation code, this is a bug.

### 2. No Enforcement Mechanism

The ask mode directive is advisory — it's injected into the agent's context as a prompt instruction. There is no technical enforcement that prevents the agent from writing code. The agent's compliance depends on its training and instruction-following.

### 3. Work Mode is Changeable

An issue can be switched between ask, standard, and planning modes at any time. If switched mid-execution, the agent's current run may still be operating under the previous mode's directive. The new directive takes effect on the next wake cycle.

### 4. No Artifact Production

Ask mode issues do not produce work products or artifacts. Files created during investigation (scratch work) are not indexed as deliverables.

## Troubleshooting

### The agent is writing code instead of answering

1. This is a model behavior issue — the agent received the ask mode directive but chose to implement
2. Try rephrasing the question more explicitly
3. If persistent, report as a model behavior issue to the CTO

### The agent doesn't understand it's in ask mode

1. Verify the issue's `workMode` is set to `ask` (check the issue detail page)
2. The work mode is displayed as a badge in the issue header
3. If the badge shows "Standard" mode, the issue is not in ask mode

### The answer is posted but the issue stays open

1. Ask mode does not automatically close the issue
2. The operator should review the answer and close the issue manually (or promote to a standard mode issue if implementation is needed)

## Support Escalation Path

| Issue | Escalate To |
|-------|-------------|
| Agent writes code despite ask mode | CTO — model behavior issue |
| Ask mode badge not visible | CTO — UI render issue |
| Work mode changes don't take effect | CTO — state propagation issue |
| Answer is not posted to thread | CTO — agent communication failure |

## Related Code Locations

- `server/src/services/heartbeat.ts` (lines 4132-4138) — ask mode directive injection
- `ui/src/pages/IssueDetail.tsx` (line 3779) — ask mode badge rendering
- `ui/src/lib/work-mode-meta.test.ts` — work mode enum verification
- `packages/shared/src/validators/issue.ts` — work mode validation