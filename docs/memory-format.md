# Agent Memory File Format

Agent memory files live in a `memory/` directory under the agent's home directory.
Each file is a Markdown document with a YAML frontmatter block followed by the memory body.

## File Structure

```markdown
---
name: <short identifier, no spaces>
description: <one-line summary used for relevance matching>
type: feedback | user | project | reference
trigger: always-check | triggered | optional
---

<memory body — free-form markdown>

**Why:** <reason this memory exists>

**How to apply:** <concrete guidance for the agent>
```

## Frontmatter Fields

| Field         | Required | Values                                     | Default    |
|---------------|----------|--------------------------------------------|------------|
| `name`        | yes      | short slug (e.g. `feedback_chinese_only`)  | —          |
| `description` | yes      | one-line relevance summary                 | —          |
| `type`        | yes      | `feedback` / `user` / `project` / `reference` | —       |
| `trigger`     | no       | `always-check` / `triggered` / `optional`  | `optional` |

### `trigger` Values

| Value          | Behaviour                                                              |
|----------------|------------------------------------------------------------------------|
| `always-check` | Injected into every heartbeat system prompt. Agent must verify before acting. |
| `triggered`    | Loaded only when the agent explicitly retrieves it (reserved for future use). |
| `optional`     | Surfaced only when the model recalls it via semantic search (default). |

## Memory Index (`MEMORY.md`)

Every memory directory must contain a `MEMORY.md` index file. The Active Memory reader
discovers files by parsing Markdown links of the form `[display text](filename.md)`.

```markdown
# Memory Index

- [Short title](feedback_chinese_only.md) — one-line description
- [Another rule](feedback_no_deploy.md) — another description
```

## Governance Rules (VOG-5838)

### Marking Ownership
Each agent marks **only their own** memory files. The CEO marks CEO memories,
the CTO marks CTO memories, and so on. No agent may add `trigger: always-check`
to another agent's files.

### Always-check Limit
A single agent should have **at most 15** `always-check` entries. Exceeding this
limit emits a runtime warning but is not hard-blocked. Agents are responsible
for keeping their always-check list focused on critical rules, not convenience reminders.

### Monthly Review (implemented in Fix1-C)
A monthly cron job counts actual violations per always-check memory over the past month.
Entries with fewer than 1 violation per month are candidates for downgrade to `optional`
to prevent prompt bloat. Review is advisory; the agent owner makes the final call.

## Backward Compatibility

Files that use the legacy `enforcement` field (written before VOG-5838) are still
recognized. The reader accepts `enforcement: always-check` as equivalent to
`trigger: always-check`. New files should use `trigger`.

## Examples

### Feedback memory (always-check)
```markdown
---
name: 凭据传递不重复明文
description: 凭据 hand-off 时引用来源 issue，不在新 issue 正文重复明文值
type: feedback
trigger: always-check
---

凭据传递时，不要在 issue 正文 / 评论里重复明文密码值。

**Why:** 明文密码写进 issue 会扩大审计暴露面。

**How to apply:** 需要传递凭据来源时，只写「源：VOG-xxxx」，不重复 `KEY=value` 明文。
```

### Project memory (optional, default)
```markdown
---
name: project_sprint_freeze
description: Merge freeze in effect until 2026-05-15 for release cut
type: project
---

All non-critical merges are frozen from 2026-05-10 through 2026-05-15.

**Why:** Mobile team is cutting a release branch.

**How to apply:** Flag any non-critical PR scheduled in this window.
```
