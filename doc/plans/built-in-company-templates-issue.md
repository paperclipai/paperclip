# GitHub Issue Draft: Built-in Company Templates

## Title

Add built-in company templates to the OSS repo using the existing portability system

## Summary

Paperclip already supports portable company import/export, but it does not yet support first-party, built-in templates inside the open-source repo.

This issue proposes a V1 for built-in company templates that:

- stores curated templates in-repo under `templates/`
- exposes a template catalog to the UI
- lets onboarding create a company from a built-in template
- reuses the existing portability preview/import system rather than introducing a second template pipeline

## Why

The repo already has the low-level pieces:

- portability manifest + markdown-based company bundle format
- import preview and collision handling
- import from local path, URL, or GitHub

What is missing is the product layer:

- no built-in template registry
- no template list API
- no onboarding picker
- no stable in-repo format for first-party templates

This would move the project closer to the README/ClipHub direction while staying small enough for the OSS repo.

## Proposed V1 Scope

- Add `builtin` as a portability source type
- Add repo-native template format under `templates/<template-id>/`
- Add server-side template registry
- Add UI support in onboarding for "Start from template"
- Ship one or two neutral example templates

## Explicit Non-Goals

- full ClipHub marketplace
- paid templates
- publishing flow
- import/export of goals, projects, issues, or seed tasks
- template version marketplace semantics

## Implementation Notes

### Suggested repo format

```text
templates/
  solo-founder-lite/
    template.json
    paperclip.manifest.json
    COMPANY.md
    agents/
      ceo/AGENTS.md
      operator/AGENTS.md
```

### Suggested contract change

Extend portability source union with:

```ts
{ type: "builtin"; templateId: string }
```

### Suggested implementation path

1. Add server template registry that scans `templates/*/template.json`
2. Resolve built-in templates into the same internal `ResolvedSource` shape used by company portability
3. Reuse existing preview/import logic
4. Add onboarding template picker

## Acceptance Criteria

- built-in templates can be listed from the server
- onboarding can create a company from a built-in template
- built-in template import uses the same collision preview/import semantics as other portability sources
- at least one first-party example template imports successfully in dev

## Relevant Files

- `packages/shared/src/validators/company-portability.ts`
- `server/src/services/company-portability.ts`
- `ui/src/components/OnboardingWizard.tsx`
- `cli/src/commands/client/company.ts`

## Follow-up

Once the generic framework exists, downstream template packs can add opinionated templates such as safety/governance-first orgs without coupling the upstream feature to any one use case.
