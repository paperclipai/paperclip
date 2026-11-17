# Greptile configuration

This directory tracks the supported review configuration for
`paperclipai/paperclip`. It was prepared from a read-only dashboard inventory
on 2026-10-13. No dashboard settings or custom context were changed.

- `config.json` records the observed review settings supported by Greptile's
  documented file schema.
- `files.json` loads repository context and scopes architectural rule files.
- `rules.md` explains how to apply the canonical Markdown rules in `rules/`.

## Settings migrated to Git

| Dashboard setting | Repository configuration |
| --- | --- |
| Automatic reviews on all events | `autoReview: ["open", "push", "rebase"]` |
| Exclude `dependabot[bot]`; remaining reviews use Base | `excludeAuthors`, `effort: "base"` |
| High strictness (dashboard says it does not comment on P2s) | `strictness: 3` |
| Do not replace the PR description | `shouldUpdateDescription: false` |
| Include PR summary, confidence score, and findings; no sequence diagram | The four section settings in `config.json` |
| Summary is not collapsible; default-open option is off | `summarySection.collapsible` and `defaultOpen` are `false` |
| Include a prompt to fix findings | `fixWithAI: true` |
| Status checks and status comments enabled | `statusCheck` and `statusCommentsEnabled` are `true` |
| Auto-approval disabled; stored risk ceiling is Low | `autoApprove.enabled: false`, `riskCeiling: "low"` |

The existing PR-description and 1,000-line growth guidance is in
`rules/pull-request-review.mdc`. That file also preserves the active,
repository-specific rule not to request UI screenshots. This resolves the
contradiction with the older organization instruction asking for screenshots.

The active dashboard pattern `**/[Aa][Gg][Ee][Nn][Tt][Ss].md` reported two files:
`AGENTS.md` and `docs/api/agents.md`. Both are explicit references in
`files.json`; the latter remains API context, not contributor policy. Future
context files need explicit manifest entries. The inactive Contribution
guidelines context remains inactive; it is not added as a separate context
file. Rules scoped to other repositories are not copied here.

## Settings still managed in Greptile

The following observed controls do not have equivalents in the published
`.greptile/` schema used for this migration. They remain dashboard settings:

- Review draft pull requests: enabled.
- Required confidence to pass the status check: 5/5.
- Image badges: enabled.
- Comment header: empty.
- Default coding-agent badges: no agents shown.

Repository enablement, provider authentication, billing, integrations, and
learned memory also remain service settings. Auto-approval risk instructions,
if used later, are explicitly dashboard-only in Greptile's reference. Do not
invent config keys for unsupported controls.

## Cutover and maintenance

Greptile reads committed configuration from the reviewed branch. No reindex is
required. Local changes alone are not visible to the hosted reviewer.

File-based review settings override dashboard defaults, but dashboard rules
and instructions are additive. The existing dashboard copies are still active.
This is a staged migration, not a completed dashboard cleanup. After a hosted
review verifies the configuration, an authorized maintainer can retire duplicate
dashboard context scoped to this repository. Do not remove shared organization
instructions while other repositories still depend on them.

Keep each policy's body in `rules/`; update the `files.json` scope together with
the rule's MDC frontmatter. The chat-channel rule includes both the directory
and its sibling service entry point. See `rules/README.md` for authoring steps.

References: [configuration and precedence](https://www.greptile.com/docs/code-review/greptile-config),
[supported fields and file references](https://www.greptile.com/docs/code-review/greptile-config-reference).
