---
name: pr
description: >
  Write structured PR bodies using visual evidence, merge-danger framing,
  and concise before/after evidence.
---

# PR Skill

Write the body of a pull request using the show-me template: a small visual summary, concrete before/after evidence, and merge-danger framing. Skip preambles and keep prose brief, using the domain language from `GLOSSARY.md`.

## When to Use

- You are writing a PR body and want a consistent structure
- You need to show what changed, how it was verified, and the merge risk

**When NOT to use:** Simple commits with no review body, or internal-only changes with no PR process.

## Prerequisites

- A changeset to describe (diff, screenshots, test output)

## How to Run

Invoke the pr skill while working on the branch, or ask the agent to draft the PR body. The agent fills the template sections from the actual change.

## Quick Reference

- Summary — smallest view (pseudocode, call tree, component tree, file tree, Mermaid, diff, or whole block)
- Evidence — before/after screenshots or test output
- Merge Danger — one-way vs two-way door, blast radius

## Procedure

1. Pick the smallest view that makes the key point clear for the Summary.
2. Add Evidence: show Before and After, preferring execution-based results over prose.
3. Add Merge Danger: label the door one-way or two-way, then give the blast radius in one word.
4. Skip all preambles; keep prose brief; use domain language.

## Pitfalls

- Dumping the whole diff instead of choosing the smallest view
- Writing a long preamble before the template sections
- Omitting Evidence, leaving reviewers unsure the change works

## Verification

- The PR body contains Summary, Evidence, and Merge Danger sections
- Evidence shows a concrete before/after comparison
- Merge Danger states the door type and a one-word blast radius
