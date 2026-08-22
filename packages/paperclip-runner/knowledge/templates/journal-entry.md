---
type: Engineering Journal Template
title: Engineering journal entry template
description: Copyable OKF v0.2 template for native-runner phase entries.
tags: [native-runner, template, journal]
status: stable
generated: { by: codex/gpt-5, at: 2026-08-07T00:00:00Z }
---

# Template

Copy the following block into a dated file under `knowledge/journal/`, replace
every angle-bracket placeholder, link the file from the journal index, and run
the package documentation validator.

```markdown
---
type: Engineering Journal Entry
title: <Phase and topic>
description: <One-sentence summary>
tags: [native-runner, phase-N]
status: draft
generated: { by: <producer>/<version>, at: <YYYY-MM-DDTHH:MM:SSZ> }
entry_kind: phase
phase: "<N>"
---

# Context

<Why this work exists and which contract controls it.>

# Decisions

1. <Decision and rationale.>

# Evidence

<Exact commands, tool versions, results, and links.>

# Failures

<Observed failures and their resolution, or an explicit none-observed statement.>

# Known gaps

- <Intentional omission.>

# Follow-up questions

- <Question that belongs to a later checkpoint.>
```

See the [journal guide](../../docs/journal.md) for actor conventions, queries,
and validation commands.
