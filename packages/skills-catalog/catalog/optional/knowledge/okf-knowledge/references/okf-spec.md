# Open Knowledge Format (OKF) v0.1 — condensed

Source of truth: `GoogleCloudPlatform/knowledge-catalog`, file `okf/SPEC.md`.
This is a working summary; when in doubt, read the upstream spec.

OKF is a tool-neutral way to share knowledge as **a directory tree of markdown
files**. The recommended distribution is a **git repository** (history,
attribution, diffs come for free).

## Bundle layout

```
bundle/
├── okf.yaml          # optional bundle-root metadata (okf_version, title, …)
├── index.md          # optional directory listing (progressive disclosure)
├── log.md            # optional chronological change history
└── <concept>.md      # concept documents (markdown + YAML frontmatter)
    └── subdir/        # concepts may be organised hierarchically
```

`index.md` and `log.md` are **reserved filenames** with special meaning. Every
other `.md` file is a concept document.

## Concept documents

A concept is a UTF-8 markdown file with two parts: YAML frontmatter, then a
markdown body.

### Frontmatter

- **`type`** *(required)* — short string naming the kind of concept
  (e.g. `memory`, `skill`, `decision`, `document`, `source`, `table`). This is
  the only hard requirement.
- `title` *(recommended)* — human-readable display name.
- `description` *(recommended)* — single-sentence summary.
- `resource` *(recommended)* — a URI uniquely identifying the underlying asset.
- `tags` *(recommended)* — YAML list for categorisation.
- `timestamp` *(recommended)* — ISO-8601 datetime of last change.
- Producers MAY add any additional keys.

### Body

Standard markdown. Conventional sections producers may use:

- `# Schema` — structured description of the asset.
- `# Examples` — usage examples.
- `# Citations` — numbered external sources or bundle-relative references.

## Cross-linking

Two link forms, both standard markdown:

- **Bundle-absolute** (starts with `/`): `[customers](/tables/customers.md)` —
  resolved from the bundle root.
- **Relative**: `[neighbour](./other.md)`.

Consumers **MUST tolerate broken links** — a link to a target that is not in
the bundle is *not* malformed.

## Reserved files

- **`index.md`** may appear in any directory. It contains one or more sections,
  each a heading grouping concepts as title→description pairs (typically a
  bulleted list of links).
- **`log.md`** records changes. Date headings **MUST** use ISO-8601
  `YYYY-MM-DD` form.

## Bundle metadata & versioning

A bundle MAY declare its target version in root metadata:

```yaml
okf_version: "0.1"
```

This skill writes that into `okf.yaml`. Future revisions follow semantic
versioning (minor = backward-compatible, major = breaking).

## Conformance

A conformant bundle requires only:

1. Every non-reserved `.md` file has a parseable YAML frontmatter block.
2. Every frontmatter block has a non-empty `type` field.
3. Reserved files follow the structures above.

A consumer **must NOT reject** a bundle for: missing optional frontmatter
fields, unknown `type` values, unknown extra frontmatter keys, or broken
cross-links. `scripts/okf-validate.mjs` implements exactly this: the two rules
above are errors; everything tolerable is at most a warning.
