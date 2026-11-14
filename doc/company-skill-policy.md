# Company skill policy

This document describes the company skill policy contract. The code and its tests
are the source of truth; see `server/src/services/company-skill-policy.ts`
and its tests.

## Product default

An authenticated agent may perform normal company-skill work without a skill-specific grant when the target company has no explicit skill policy. This includes creating, importing, installing, editing, updating, testing, resetting, and removing skills. Core MUST NOT introduce a `skills:author` prerequisite, a draft-only default, or an activation-approval default.

Authorization order is fixed:

1. Enforce non-configurable platform invariants.
2. Evaluate the company's explicit skill policy when one exists.
3. Otherwise allow the authenticated company agent.

Non-configurable invariants include authenticated actor identity, exact company scoping, source and workspace path containment, package and frontmatter validation, secret redaction/non-export, immutable audit attribution, and any hard runtime isolation rule. A policy rule, legacy grant, plugin, or EE configuration cannot override these invariants.

For avoidance of doubt:

- Local-path imports, updates, resets, and project scans MUST resolve under a Paperclip-known local workspace root or a Paperclip-managed skill root. Arbitrary host filesystem paths are invalid even when the caller is otherwise authorized. Caller-supplied `source`, `sourceLocator`, or similar path strings are descriptive input only; they MUST NOT expand authority beyond those approved roots.
- Remote imports and updates MUST normalize to a known source category, require validated HTTPS or catalog sources, and resolve immutable content before install (for example pinned Git commit/content hash or pinned package version). Unknown schemes, unknown source categories, symlink escapes, and out-of-tree files fail closed before persistence.
- Unsafe executable content, fetch-and-exec patterns, and secret exfiltration or non-redacted secret material are platform safety failures. Policy cannot waive them; the route MUST reject the operation before any new skill version, install, update, or reset is persisted.
- Mandatory activity attribution is part of the invariant boundary. If the required audit record for a skill mutation or policy mutation cannot be persisted, the mutation MUST fail or roll back; do not return success with missing auditability.

## Canonical actions and resources

The version 1 evaluator uses these stable action identifiers:

- `skills.create`: create or fork a company-authored skill and create skill versions
- `skills.import`: import or scan skills from a workspace, Git source, URL, or package
- `skills.install`: install a catalog or externally sourced skill into the company
- `skills.edit`: change skill metadata, name, files, test inputs, or test templates
- `skills.update`: install a newer upstream revision
- `skills.test`: start, cancel, or remove a skill test run and run a skill audit
- `skills.reset`: restore the installed/upstream revision
- `skills.remove`: delete a company skill

Policy resources may include `skillId`, stable `skillKey`, `sourceType`, and `sourceLocator`. The stable source categories are `workspace`, `catalog`, `git`, `external_package`, `generated`, and `unknown`; adapters may preserve a more specific source value as metadata, but policy evaluation MUST normalize it to one of these categories. Core derives actor and company identity from authentication and derives known resource fields from stored data; a mutation client cannot authorize itself by supplying actor or resource identity fields.

## Version 1 policy document

Absence of a policy record is semantically equivalent to the following document, but core SHOULD avoid materializing records for untouched companies:

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "defaultEffect": "allow",
  "rules": []
}
```

An explicit policy has a monotonically increasing `revision`, a `defaultEffect` of `allow` or `deny`, and ordered rules. Each rule contains a stable `id`, integer `priority`, `effect` (`allow` or `deny`), a subject selector (`all_agents`, agent ids, or role names), one or more canonical actions, and optional resource selectors for skill ids/keys and normalized source types/locators. An omitted resource selector matches every resource for the listed action.

Rules are evaluated by ascending `priority`, then stable rule id; the first matching rule decides. If no rule matches, `defaultEffect` decides. This supports both the normal open policy with targeted deny rules and an opt-in restricted preset with default deny plus explicit allow rules. Core MUST validate policy documents atomically and reject ambiguous, unknown-version, unknown-action, cross-company, or malformed selectors with `422`.

Every decision returned by the evaluator has this stable shape:

```json
{
  "allowed": false,
  "action": "skills.install",
  "reason": "explicit_rule",
  "policyRevision": 7,
  "matchedRuleId": "deny-external-packages",
  "remediation": "Contact a company administrator to change the skill policy."
}
```

`reason` is one of `platform_invariant`, `no_policy_default`, `explicit_rule`, `policy_default`, or `legacy_compatibility`. Mutation routes MUST use this evaluator and return `403` with code `skill_policy_denied` and the non-sensitive decision fields when an explicit restriction denies an operation. Denials must identify the action and remediation without exposing hidden rule data, secrets, or another company's policy.

Platform-invariant failures are not policy denials and MUST use stable machine-readable error codes so clients can distinguish non-overridable safety failures from optional administrative restrictions. Version 1 requires a finite code set covering at least:

- `skill_authentication_required`
- `skill_company_boundary_denied`
- `skill_workspace_boundary_denied`
- `skill_source_validation_failed`
- `skill_unsafe_content_blocked`
- `skill_secret_handling_blocked`
- `skill_policy_admin_required`

Core Skill Studio and Paperclip EE MUST treat those codes as hard platform failures, not as prompts to loosen policy.

## Core API and ownership boundary

Core owns and ships these company-scoped endpoints:

- `GET /companies/:companyId/skill-policy` returns the effective versioned policy, its revision, and whether it is materialized or the open default.
- `PUT /companies/:companyId/skill-policy` atomically replaces the policy and requires the caller's expected revision; stale writes return `409`.
- `DELETE /companies/:companyId/skill-policy` removes explicit configuration and restores the open default.
- `POST /companies/:companyId/skill-policy/evaluate` simulates decisions for administrative tooling without performing a skill mutation.

Policy reads, writes, deletion, and simulation enforce company access. Policy mutation and cross-principal simulation require board administration authority or the existing `users:manage_permissions` capability; ordinary skill access does not. Every policy mutation writes an activity event containing the actor, previous revision, new revision, and a redacted change summary. Skill mutation activity logging remains required independently of the policy decision.

Paperclip EE owns the detailed editor, presets, protected-skill management, policy simulation UX, and policy-specific audit views. EE consumes the core endpoints and does not implement a second evaluator. Core may expose a concise effective-policy summary and denial state, but MUST NOT depend on EE for enforcement or make EE installation a prerequisite for normal skill work.

## Compatibility and availability

- Existing companies with no explicit restriction adopt the open default, including companies that previously depended on missing grants to deny skill changes. Release notes and upgrade guidance MUST call out this behavior change.
- Existing explicit restriction policies remain effective after migration.
- Legacy `skills:create` and `skills:suggest-changes` positive grants remain accepted in APIs and portability packages. Historically either positive grant authorized the broad company-skill mutation surface, so in an explicit restricted policy either grant remains a compatibility allow fallback for all eight canonical skill actions only when no explicit rule matched. They never override an explicit deny or a platform invariant. With no explicit policy they are redundant because the default already allows the action.
- Legacy `skills:suggest-changes` consent state is not a platform invariant for company skills and does not add a second mutation gate under the open-default policy. Companies that require approval or consent before skill changes must express that restriction through explicit skill-policy rules; authentication, company boundaries, source containment, validation, auditability, and runtime safety remain non-configurable invariants.
- Import preview MUST report whether a package contains an explicit skill policy or legacy grants and how each will map. Import apply MUST preserve explicit policies, normalize supported legacy grants, and reject unknown policy versions rather than silently weakening them.
- Export MUST include explicit skill policy configuration and retained legacy grants in `.paperclip.yaml`, never secret values or environment-specific paths. An unconfigured company exports no synthetic restriction.
- If Paperclip EE is unavailable or removed, core continues to enforce stored policies and expose the policy API. Normal skill work remains available under the open default; explicit denials use core remediation text rather than a broken EE-only link.
