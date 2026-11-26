# Repository rules

Keep architectural guidance in focused `.mdc` files here. Each file is Markdown
with YAML frontmatter containing a `description` and an `alwaysApply` boolean.
For scoped rules, set `alwaysApply: false` and provide comma-separated,
repository-relative `globs`. For repository-wide rules, set `alwaysApply: true`
and omit `globs`. Use `**` for all descendants of a directory. Include sibling
entry points explicitly when needed.

Root `AGENTS.md` tells coding agents to read matching rules before editing or
reviewing code. This directory is a repository convention: Cursor does not
automatically load it as `.cursor/rules/`, and the `.mdc` extension alone does not
make a tool apply a rule.

Greptile reads matching rule files through `.greptile/files.json` and receives
loading instructions from `.greptile/rules.md`. The rule body remains here as
the single source of truth. Repository configuration takes effect when the
files are available on the reviewed branch; local files alone are not visible
to the hosted reviewer.

When adding or changing a rule:

1. State the scope, required behavior, examples, exceptions, and review criteria.
2. Add its path to `.greptile/files.json`. Copy its `globs` into that entry's
   `scope` array, one pattern per element. For `alwaysApply: true`, omit `scope`.
3. Keep the rule's frontmatter and the Greptile scope synchronized. Verify that
   the scope covers representative files and excludes unrelated directories.
4. Keep detailed policy in the rule file instead of copying it into tool settings.

Product behavior is covered by
[`product-harness-responsibility.mdc`](product-harness-responsibility.mdc): routine
work belongs to the harness, and user-facing detail must support an outcome or a
real decision. This applies to orchestration as well as UI.

See the [Greptile file-reference documentation](https://www.greptile.com/docs/code-review/greptile-config-reference)
for the manifest format.
