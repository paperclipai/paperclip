---
title: Brand and Compatibility
summary: Public Orchestrero branding with Paperclip compatibility identifiers preserved
---

Orchestrero is the public brand for this control plane. The website, app shell, onboarding copy, exported README text, and docs site should present the product as Orchestrero and link to [https://www.orchestrero.ai](https://www.orchestrero.ai).

## Public Source of Truth

The `docs/` folder is the canonical public documentation source for the website. New public-facing product copy, brand guidance, and migration notes should live here first.

The `doc/` folder remains contributor-facing and operational. It can mention the public brand where helpful, but it is not the website source of truth.

## Compatibility Identifiers That Stay

This rebrand does not rename compatibility-critical technical identifiers. Expect these names to remain in commands, packages, and config until a later migration pass:

- `paperclipai` CLI commands
- `@paperclipai/*` package scopes
- `PAPERCLIP_*` environment variables
- `paperclip:*` local storage keys
- `~/.paperclip` local state paths

## Public Link Policy

Public-facing surfaces should:

- use `https://www.orchestrero.ai` as the canonical product URL
- avoid linking to the upstream Paperclip GitHub repository
- avoid linking to the legacy product domain

Rendered public export content should follow the same rule even if machine-readable provenance metadata still contains compatibility-era identifiers.
