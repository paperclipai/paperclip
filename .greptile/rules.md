# Repository rule loading

The `.mdc` files under `rules/` are repository review requirements.
`.greptile/files.json` identifies the rule files to read for matching source
paths. Read their full Markdown bodies and apply their review criteria and
allowed exceptions to the affected code.

Each rule's YAML frontmatter declares its scope with repository-relative
`globs`, or `alwaysApply: true` for a repository-wide rule. Respect that scope;
do not apply a channel rule to unrelated subsystems. Keep the policy in the
referenced file as the source of truth rather than maintaining a separate copy
in dashboard instructions.

Do not add package.json scripts for new utilities, checks, benchmarks, or specialized tests.
