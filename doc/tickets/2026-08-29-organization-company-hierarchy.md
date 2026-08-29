# Clarify organization, company, and project semantics

Date: 2026-08-29
Status: open — product copy and onboarding semantics need alignment

## Problem

This fork has a real hierarchy:

```text
Organization
└── Company
    └── Project
        └── Tasks / Epics / AI execution
```

The data model and APIs support it: organizations have memberships and companies carry `organization_id`; organization management uses `/organizations`; operational work uses `/companies`. However, the self-hosted UI currently opens company creation from a menu item labeled “Create new organization...” and the onboarding wizard says “Name your organization” while calling `POST /companies`. That makes users believe a company is being created under another company or that the two concepts are interchangeable.

## Canonical meaning

- **Organization** — the parent group used for people, membership, governance, and a portfolio of companies.
- **Company** — the operational AI business/workspace. Agents, goals, issues, projects, budgets, credentials, and execution state belong here.
- **Project** — a bounded body of work inside one company. Tasks, Epics, and AI execution work can be grouped here.

Creating a company from the self-hosted onboarding flow must create the company and then attach it to the selected organization. It must not silently create a second organization.

## Required changes

- Label `/organizations` actions as “Create organization” and “Manage organizations”.
- Label self-hosted company onboarding as “Create company” and “Name your company”.
- Explain the attach-to-organization step after company creation.
- Keep cloud tenant/stack terminology separate where the hosted product intentionally calls a tenant an organization.
- Add route, copy, and create/attach regression coverage.

## Acceptance criteria

1. A user can create an organization without creating a company.
2. A user can create a company from a selected organization and see the company in that organization.
3. A project can be created only inside a company.
4. No self-hosted button that calls `POST /companies` says “create organization”.
5. Existing stored organization/company records and routes remain compatible.
