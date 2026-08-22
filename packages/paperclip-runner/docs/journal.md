# Engineering Journal Guide

The `knowledge/` directory is a package-local Google Open Knowledge Format
(OKF) v0.2 bundle. It uses ordinary Markdown concept files with YAML
frontmatter, progressive-disclosure indexes, and a chronological `log.md`.

## Bundle layout

```text
knowledge/
  index.md
  log.md
  journal/
    index.md
    YYYY-MM-DD-phase-NN.md
  evidence/
    index.md
    YYYY-MM-DD-phase-NN-verification.md
  templates/
    index.md
    journal-entry.md
```

## Add an entry

1. Open the [journal entry template](../knowledge/templates/journal-entry.md).
2. Copy the fenced template into `knowledge/journal/YYYY-MM-DD-topic.md`.
3. Set a descriptive `type`; phase journals use
   `Engineering Journal Entry` plus `phase` and `entry_kind` extension fields.
4. Record `generated` with the OKF actor convention and an ISO 8601 UTC instant.
5. Include decisions, evidence, failures, known gaps, and follow-up questions.
6. Link the entry from `knowledge/journal/index.md` and update
   `knowledge/log.md`.
7. Run `pnpm --filter @paperclipai/paperclip-runner docs:validate`.

OKF v0.2 requires only `type`, but this bundle also requires `title`,
`description`, and `generated` so engineering entries remain searchable and
auditable. Unknown producer-defined fields remain valid.

## Query entries

List journal concepts:

```sh
rg -l '^type: Engineering Journal Entry$' packages/paperclip-runner/knowledge
```

Find Phase 0 entries:

```sh
rg -l '^phase: "0"$' packages/paperclip-runner/knowledge
```

Find unresolved questions or failures:

```sh
rg -n '^## (Failures|Follow-up questions)$' packages/paperclip-runner/knowledge/journal
```

Find concepts by tag:

```sh
rg -l '^tags: .*boundary' packages/paperclip-runner/knowledge
```

Indexes are the human and agent entry point; `rg` is the deterministic local
query path. No database or Paperclip service is required.

## Validation contract

The OKF validator enforces:

- root `okf_version: "0.2"` and reserved index/log rules;
- required concept frontmatter and valid lifecycle values;
- OKF actor and UTC timestamp syntax in `generated`;
- typed phase journal extension fields;
- ISO date headings in `log.md`;
- index coverage for concepts and child directories.

The [OKF v0.2 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
remains authoritative; the local requirements only tighten authoring quality.
