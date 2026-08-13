# @paperclipai/adapter-claude-local

## 0.3.3

### Patch Changes

- Fix the pre-merge gate (Control 3, MGC-2350) so the parser and bash hook extractor accept `gh pr merge <NUMBER>` regardless of flag position (`--squash`, `--delete-branch`, `--merge`, `--rebase`, `--admin`, `--auto` may precede or follow the number), and so Gate #2's race-condition check hits the documented `/api/companies/:companyId/heartbeat-runs?agentId=…` endpoint instead of the non-existent `/api/agents/:id/runs`. Resolve two Greptile review findings (1/5 confidence blocked merge) and one server-side sandbox probe assertion that previously failed because it could not see the `__paperclipManaged: true` hook injected after sanitization.
- Updated dependencies
  - @paperclipai/adapter-utils@0.3.3

## 0.3.2

### Patch Changes

- Add a Paperclip-managed `PreToolUse` hook (`/.paperclip-hooks/pre-merge-gate.sh`) to the seeded Claude config so any `gh pr merge <PR>` invocation issued by an agent runs through the pre-merge gates (ticket in_review + cto assignee, no concurrent run race, no hold signal in the last comment) before Claude Code allows the Bash tool call. Defense-in-depth for the PR #454 bypass documented in MGC-2348 §5 (Control 3, MGC-2350). The hook is auto-injected, idempotent and survives snapshot reuse.
- Updated dependencies
  - @paperclipai/adapter-utils@0.3.2

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1
- Updated dependencies
  - @paperclipai/adapter-utils@0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

### Patch Changes

- Updated dependencies
  - @paperclipai/adapter-utils@0.3.0

## 0.2.7

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.7

## 0.2.6

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.6

## 0.2.5

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.5

## 0.2.4

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.4

## 0.2.3

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.3

## 0.2.2

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.2

## 0.2.1

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.1
