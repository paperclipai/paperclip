# Quality Gate Automation Design

## Goal

Shift Fluxaivory from agent-heavy review loops to a mixed control-plane architecture where deterministic CLI evaluators do almost all repeatable quality checking and Paperclip aggregates the results into a fail-closed publish-ready decision.

## Current Context

Paperclip already owns:

- agent roster, routines, issues, and executive focus
- publish boundary, public verify, incident routing, and resume review
- NotebookLM-first research policy and Obsidian RSS topic scout policy

The current gap is not missing roles. The gap is that many repeated checks still live as implicit agent judgment instead of explicit machine-readable gate outputs.

## Design Choice

Use a mixed architecture:

- `Paperclip` is the control plane
- `CLI tools` are repeatable evaluators and artifact producers
- `Agents` handle exceptions, ambiguous failures, and final approval

Do not create new long-lived agents for preflight work. Put repetitive checks into small CLIs with JSON output and wire them into routines and publish-ready review.

## System Shape

### Discovery and Grounding

1. `obsidian_rss_topic_scout.py`
   - chooses what is worth investigating
   - outputs scored topic candidates
2. `NotebookLM-first grounding`
   - produces notebook reference, fact pack, source registry, uncertainty ledger

### Draft and Quality Preflight

3. draft generation continues in the existing pipeline
4. preflight CLIs evaluate:
   - research grounding
   - topic alignment
   - reader experience
   - explainer quality
   - visual quality
5. `publish_ready_preflight.py`
   - merges all gate outputs into one final preflight result

### Publish and Truth Gate

6. publish boundary executes only when preflight passes and final owners approve
7. public verify remains the final truth gate

## State Machine

- `topic_selected`
- `grounded`
- `draft_ready`
- `quality_preflight_failed`
- `quality_preflight_passed`
- `publish_ready_review`
- `publish_ready`
- `published`
- `public_verify_failed`
- `public_verified`

`published` is not success. Only `public_verified` is success.

## Responsibility Boundaries

### CLI

- reads artifacts
- applies deterministic rules
- emits `pass/fail`, reasons, warnings, next action hints
- never grants exceptions

### Agents

- interpret ambiguous failures
- decide between conflicting specialist lanes
- approve or reject final publish-ready state
- never redo deterministic checks by hand unless debugging the checker itself

### Paperclip

- runs routines
- stores artifacts
- aggregates gate outputs
- routes failures
- manages state transitions

## Required CLI Contracts

Every preflight CLI must output structured JSON with:

- `ok`
- `gate`
- `status`
- `reasons`
- `warnings`
- `next_action_hint`
- `artifacts_used`
- `summary`

## Build Order

1. `publish_ready_preflight.py`
2. `research_grounding_precheck.py`
3. `topic_alignment_precheck.py`
4. `visual_preflight.py`
5. `explainer_precheck.py`
6. `reader_experience_precheck.py`
7. wire routine and draft pipeline execution to these CLIs

## Operating Rules

- NotebookLM-first remains the default grounding path
- RSS scout is allowed to choose what to investigate, not what is publishable
- editorial final ownership remains with `Editor-in-Chief`
- publish boundary final ownership remains with `Publisher`
- truth gate final ownership remains with `Verifier`

## Success Criteria

The design succeeds when:

- publish-ready can be explained from machine-readable gate outputs
- repeated editorial checks are mostly preflight CLIs, not repeated LLM reasoning
- token usage drops because deterministic checks move out of agent loops
- failed gates route directly to the right owner without inbox ambiguity
