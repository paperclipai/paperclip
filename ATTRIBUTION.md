# Attribution

This repository (`yong076/paperclip-ko`) is a **Korean translation fork** of [paperclipai/paperclip](https://github.com/paperclipai/paperclip).

## Upstream

- **Project**: Paperclip — Open-source orchestration for zero-human companies
- **Repository**: https://github.com/paperclipai/paperclip
- **Original License**: MIT (see [`LICENSE`](./LICENSE))
- **Original Copyright**: © 2025 Paperclip AI

The original MIT license is preserved in full. All rights, credits, and copyright notices for the original software remain with the upstream authors.

## Purpose of this Fork

This fork exists to maintain a Korean-localized version of Paperclip — UI strings, documentation, CLI prompts, and accompanying materials — so that Korean-speaking developers can use Paperclip more comfortably.

The intent is **not** to diverge functionally from upstream. We track upstream closely and aim to contribute the underlying i18n infrastructure back to upstream as a clean PR (see [`docs/translation/PLAN.md`](./docs/translation/PLAN.md)).

## Translation Methodology

Translations are produced by a combination of:

1. **Human review** by the maintainer.
2. **Automated translation pipelines** using LLMs (Claude / Codex), orchestrated by Paperclip itself (recursive dogfooding — Paperclip's first hired employee in this fork is its own translator).

Every translated string passes through human review before merging. Machine translations are clearly labeled in commit history.

## Maintainers

- **Korean Locale Maintainer**: [@yong076](https://github.com/yong076) (Trappist)
- **Translation Bot**: Paperclip-managed routine (see `routines/`)

## How to Contribute Translations

1. Open an issue describing the string / section to fix
2. Submit a PR against the relevant locale file (`i18n/ko/*.json`) or `README.ko.md`
3. Include the English source for context

For larger structural changes, please discuss in an issue first so we can coordinate with upstream sync cadence.

## Reporting Issues

- **Translation issues** → file in this repo (`yong076/paperclip-ko`)
- **Bugs in Paperclip itself** → file upstream at [paperclipai/paperclip](https://github.com/paperclipai/paperclip/issues)

## Trademarks

"Paperclip" and related marks belong to their respective owners. This fork uses the name to identify what it translates and does not claim any trademark interest.
