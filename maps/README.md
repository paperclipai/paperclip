# Paperclip maps

The maps describe the same capabilities from two perspectives:

- [Feature map](feature-map/README.md): what a person can do, where to reach it,
  and how to verify the user journey. Preserve its Poteto format.
- [Agent access map](agent-access-map/README.md): the APIs and agent entry points
  for those capabilities, their permission boundaries, and access verification.

These are sibling directories under `maps/`. Each feature file has a same-named
agent access companion. Reuse the product map's sub-feature IDs, so `tasks/create`
identifies the same capability in both maps. Product behavior remains governed by
[the implementation spec](../doc/SPEC-implementation.md); a map cannot grant
authority or redefine a permission denial as success.

## Capability identifiers

The feature ID is the recipe filename without `.md`, such as `onboarding`.
The full capability ID joins that feature ID and a Sub-features key with `/`:
the `company` key in `feature-map/onboarding.md` is `onboarding/company`.
Its `agent-access-map/onboarding.md` companion uses the same local `company` key.
[The feature-map index](feature-map/README.md#browse-features) lists the existing
feature and full capability IDs.

Each child page states ``Feature ID: `onboarding`.`` after its introduction or
product-map link. In feature recipes, show the full ID beside the parsed local
key: ``- `company`: `onboarding/company` — create a company``. In access
companions and Storybook verification guidance, keep the existing local heading
and put ``Capability ID: `onboarding/company`.`` beneath it. These labels make
the existing identifiers visible without changing keys, anchors, or ID generation.

Use full capability IDs in cross-feature references, Storybook annotations,
tests, issues, PRs, and verification evidence. Both segments use lowercase
letters, digits, and hyphens. Keep filenames and keys stable when display titles
or navigation labels change; renaming either changes the capability ID.

Entry-point IDs describe a surface, such as `web-wizard`, and are scoped to their
recipe. Reference them with a recipe link, such as
[onboarding.md#web-wizard](feature-map/onboarding.md#web-wizard), and record the
capability exercised separately. Navigation section labels are not capability IDs.
See [IDs and references](feature-map/README.md#ids-and-references) for examples.

## Access contract

Every business operation needs both an API and a usable agent entry point for an
actor authorized to perform it. A dedicated tool is optional when REST, the CLI,
an assigned MCP client, or native `search_api` / `call_api` already provides the
operation. Record which agent surfaces actually have that path; an installed CLI
or optional MCP package cannot be assumed available to every native/remote run.

Track these independently:

| Dimension | Values and meaning |
| --- | --- |
| API | `present`, `missing`, `not-applicable`, or `unreviewed`. Use exact methods/paths; distinguish protocols from REST. |
| Agent access | `available`, `partial`, `missing`, `restricted`, `operator-only`, `not-applicable`, or `unreviewed`. Name the supported surface and actual entry point. |
| Policy | Actor, action/grant, company/resource/ownership scope, responsible-user intersection, run requirements, work modes, and gates relevant to the operation. |
| Evidence | `source-only`, `verified`, `failed`, `blocked`, or `not-run`. Source presence and successful board calls are not agent verification. |
| Review depth | `baseline` records representative operations and known gaps; `operation-reviewed` enumerates the capability's meaningful operations and their individual access contracts. |

Broad capabilities such as task properties must be split into operations before
they count as operation-reviewed: renaming, metadata edits, assignment,
dependencies, and lifecycle changes can use different tools and permission rules.
An available read path cannot certify a write path. List/get/create/update/delete,
execution/control, credential handling, and resolution are separate where their
authority or transport differs. Do not duplicate request schemas from OpenAPI.

### Exceptions and restrictions

Presentation-only state, static developer fixtures, and pre-start/local operator
work may use `not-applicable` for a domain API, with a concrete reason and the
existing local path. When a capability combines shared data with presentation,
split the operations: browser recents do not exempt resource lookup from API
coverage. Promoting local state to a shared feature requires revisiting the entry.

A board-only endpoint is `restricted` for agent identity, not an automatic
exception or a missing API. Cite the enforced policy and record whether the
agent can request the authorized human's action and observe its result. An
unresolved delegation question remains in **Gaps**. Company access, a job title,
a personal assistant's OAuth grant, or an accepted interaction does not grant
board identity. Keep budget, approval, secret and execution authority intact.

Check actual route/service authorization and production tool admission. OpenAPI
actor labels and scenario/evaluation tool declarations are supporting metadata;
record disagreements rather than using them as proof of access. Native API
fallback restrictions, tool field/scope limits, and rollout settings are part of
the agent path, even when a legacy agent can call the REST endpoint directly.

## Companion file format

Each `agent-access-map/<area>.md` has an H1, a relative link to its product file,
and its feature ID, followed by one H2 backticked local key per product
sub-feature. Each capability starts with its full capability ID and contains
these fields:

- **Review:** `baseline` or `operation-reviewed`.
- **API:** presence state and exact operation IDs, or a reasoned exception.
- **Agent access:** availability state and concrete entry points by surface.
- **Policy:** relevant permission and runtime boundaries, with source references.
- **Evidence:** evidence state, reviewed commit and sources or executed proof.
- **Verification:** allowed/denied assertions and observable result; record what
  has actually run separately from the proposed recipe.
- **Gaps:** missing APIs/paths, discovery drift, unreviewed operations or policy
  decisions; use `none` only for the enumerated scope that was reviewed.

For an operation-reviewed capability, use H3 backticked operation IDs and repeat
API, Agent access, Policy, Evidence, Verification and Gaps for each operation.
Use small operation names such as `create`, `update`, `read`, or `run-now`.
The enclosing capability has `Review: operation-reviewed` only after its
meaningful operations have been enumerated. The following excerpt shows one
operation; include the others before using that review label:

```markdown
## `definition`

Review: `operation-reviewed`.

### `create`

API: `present` — POST /api/companies/{companyId}/routines.
Agent access: `available` — agent REST, CLI routine create and native call_api
under the enabled rollout and active-run/mode gates.
Policy: same company; assigneeAgentId must be the calling agent; cite the
routine authorization and native API policy sources.
Evidence: `source-only` — reviewed commit and source links; no live proof.
Verification: `not-run` — create an owned routine; reject assignment to another
agent; inspect saved configuration, attribution and retry behavior.
Gaps: verify ownership and responsible-user resolution with a permitted agent
context; source presence alone does not qualify this operation.
```

## Keeping the maps synchronized

When a change adds/removes a capability or changes its behavior, API, permission,
tool binding, CLI support, or work mode, update the affected companion and product
recipe as appropriate in the same change. Preserve IDs across renames where the
capability is unchanged; update the affected cross-links together. Indexes discover recipes automatically. An API-only
change may update the companion without rewriting unchanged user instructions.

[maintain-verification-skill](../.agents/skills/maintain-verification-skill/SKILL.md)
owns reconciliation of both maps. It follows changed source and authorization,
checks real agent reachability, and records product gaps without implementing
them during a maintenance pass. The creation skill uses this structure.
[verify-paperclip](../.agents/skills/verify-paperclip/SKILL.md) consumes the relevant
recipes and reports evidence/drift; map editing belongs to maintenance.

Run the structural check after map changes:

```sh
node scripts/check-maps.mjs
```

It checks paired areas/IDs, navigation metadata, required fields, and local references. It
does not certify endpoint authorization, production bindings, operation
completeness, or live behavior. Source audits must check those against the
existing API and tool contracts; avoid a second schema catalog or runtime.

For live access proof, use Paperclip's existing API/runner/MCP fixtures or an owned
isolated instance. Use the actual agent identity, target and work mode. Assert the
allowed result and relevant denial (another company/private resource, wrong
owner, missing grant, invalid run, restricted mode or resolver). Mutations also
need persisted state/attribution and retry behavior. Capture evidence using the
[existing artifact workflow](../doc/AGENT-ARTIFACTS.md); keep executed run results
separate from generated `maps/generated/coverage.json`, which lists page references.

## Local authorship and generated indexes

Change only the recipes, access contracts and stories whose behavior or intent
changed. Feature recipes own navigation metadata; stories own small
`parameters.paperclip` annotations. Keep the feature-map README's readable ID
index aligned with those sources; it does not register entries for generation.
Do not refresh counts in shared READMEs, inventories, fingerprints or review
journals.

`node scripts/storybook-catalog.mjs` validates and generates aggregate navigation,
Storybook data, verification routes and the page inventory. All outputs live in
ignored `maps/generated/`, `ui/storybook/generated/`, and the ignored Storybook
`preview.tsx` wrapper. Start/build and UI typechecking generate their own inputs.
A clean merged checkout therefore assembles both branches' changes automatically.

Git provides history and diffs. PRs, issues and CI artifacts retain review/run
evidence for the named revision. Capability associations do not create whole-file
review dependencies. Keep durable scenario limits in the affected recipe or story.
