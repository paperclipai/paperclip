# Quality Gate Automation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a mixed CLI-first quality gate system that makes publish-ready a machine-readable fail-closed decision surface inside Paperclip.

**Architecture:** Keep Paperclip as the control plane, add deterministic JSON-emitting CLI evaluators for repeatable quality checks, and reserve agents for exception handling and final approval. Wire these CLI outputs into routines, draft workflows, and publish-ready review instead of relying on repeated full-draft agent passes.

**Tech Stack:** Python CLIs, existing Paperclip issue/routine services, existing mac-pipeline artifacts, NotebookLM MCP/CLI, Obsidian RSS dashboard cache, JSON artifact contracts.

---

### Task 1: Add `publish_ready_preflight.py`

**Files:**
- Create: `/Users/daehan/Documents/persona/paperclip/scripts/publish_ready_preflight.py`
- Test: `/Users/daehan/Documents/persona/paperclip/tests/scripts/test_publish_ready_preflight.py`

**Step 1: Write the failing test**

Add tests that feed synthetic gate results and expect:
- merged `ok=false` when any gate fails
- `failed_gates` ordering is stable
- `owner_routing` matches failed gates

**Step 2: Run test to verify it fails**

Run: `python3 -m pytest /Users/daehan/Documents/persona/paperclip/tests/scripts/test_publish_ready_preflight.py -q`

**Step 3: Write minimal implementation**

Implement a CLI that accepts multiple JSON paths and prints a merged JSON result with:
- `ok`
- `failed_gates`
- `owner_routing`
- `warnings`
- `next_action_hint`

**Step 4: Run test to verify it passes**

Run: `python3 -m pytest /Users/daehan/Documents/persona/paperclip/tests/scripts/test_publish_ready_preflight.py -q`

**Step 5: Commit**

```bash
git -C /Users/daehan/Documents/persona/paperclip add scripts/publish_ready_preflight.py tests/scripts/test_publish_ready_preflight.py
git -C /Users/daehan/Documents/persona/paperclip commit -m "feat: add publish ready preflight cli"
```

### Task 2: Add `research_grounding_precheck.py`

**Files:**
- Create: `/Users/daehan/Documents/persona/paperclip/scripts/research_grounding_precheck.py`
- Test: `/Users/daehan/Documents/persona/paperclip/tests/scripts/test_research_grounding_precheck.py`

**Step 1: Write the failing test**

Cover:
- missing notebook reference fails
- missing uncertainty ledger fails
- complete artifact passes

**Step 2: Run test to verify it fails**

Run: `python3 -m pytest /Users/daehan/Documents/persona/paperclip/tests/scripts/test_research_grounding_precheck.py -q`

**Step 3: Implement minimal checker**

Read a JSON artifact or explicit file paths and emit:
- `ok`
- `missing_artifacts`
- `largest_evidence_gap`
- `notebook_reference`

**Step 4: Run test to verify it passes**

Run: `python3 -m pytest /Users/daehan/Documents/persona/paperclip/tests/scripts/test_research_grounding_precheck.py -q`

**Step 5: Commit**

```bash
git -C /Users/daehan/Documents/persona/paperclip add scripts/research_grounding_precheck.py tests/scripts/test_research_grounding_precheck.py
git -C /Users/daehan/Documents/persona/paperclip commit -m "feat: add research grounding precheck"
```

### Task 3: Add `topic_alignment_precheck.py`

**Files:**
- Create: `/Users/daehan/Documents/persona/paperclip/scripts/topic_alignment_precheck.py`
- Test: `/Users/daehan/Documents/persona/paperclip/tests/scripts/test_topic_alignment_precheck.py`

**Step 1: Write the failing test**

Cover:
- numbered title promise missing from body structure fails
- ending answering a different question fails
- aligned draft passes

**Step 2: Run test to verify it fails**

Run: `python3 -m pytest /Users/daehan/Documents/persona/paperclip/tests/scripts/test_topic_alignment_precheck.py -q`

**Step 3: Implement minimal checker**

Read `draft.json` plus approved topic/title and emit:
- `ok`
- `drift_type`
- `broken_section`
- `ending_alignment`

**Step 4: Run test to verify it passes**

Run: `python3 -m pytest /Users/daehan/Documents/persona/paperclip/tests/scripts/test_topic_alignment_precheck.py -q`

**Step 5: Commit**

```bash
git -C /Users/daehan/Documents/persona/paperclip add scripts/topic_alignment_precheck.py tests/scripts/test_topic_alignment_precheck.py
git -C /Users/daehan/Documents/persona/paperclip commit -m "feat: add topic alignment precheck"
```

### Task 4: Add `visual_preflight.py`

**Files:**
- Create: `/Users/daehan/Documents/persona/paperclip/scripts/visual_preflight.py`
- Test: `/Users/daehan/Documents/persona/paperclip/tests/scripts/test_visual_preflight.py`

**Step 1: Write the failing test**

Cover:
- duplicate support image fails
- missing quick-scan block fails on dense draft
- missing role separation fails

**Step 2: Run test to verify it fails**

Run: `python3 -m pytest /Users/daehan/Documents/persona/paperclip/tests/scripts/test_visual_preflight.py -q`

**Step 3: Implement minimal checker**

Use image artifact hashes and draft structure to emit:
- `duplicate_assets`
- `support_roles_ok`
- `quick_scan_present`
- `toc_present`

**Step 4: Run test to verify it passes**

Run: `python3 -m pytest /Users/daehan/Documents/persona/paperclip/tests/scripts/test_visual_preflight.py -q`

**Step 5: Commit**

```bash
git -C /Users/daehan/Documents/persona/paperclip add scripts/visual_preflight.py tests/scripts/test_visual_preflight.py
git -C /Users/daehan/Documents/persona/paperclip commit -m "feat: add visual preflight"
```

### Task 5: Add `explainer_precheck.py`

**Files:**
- Create: `/Users/daehan/Documents/persona/paperclip/scripts/explainer_precheck.py`
- Test: `/Users/daehan/Documents/persona/paperclip/tests/scripts/test_explainer_precheck.py`

**Step 1: Write the failing test**

Cover:
- opening missing one of `what changed / why it matters / who should care` fails
- jargon-heavy first screen fails
- clear opening passes

**Step 2: Run test to verify it fails**

Run: `python3 -m pytest /Users/daehan/Documents/persona/paperclip/tests/scripts/test_explainer_precheck.py -q`

**Step 3: Implement minimal checker**

Emit:
- `opening_complete`
- `jargon_risk`
- `analogy_risk`
- `uncertainty_loss_risk`

**Step 4: Run test to verify it passes**

Run: `python3 -m pytest /Users/daehan/Documents/persona/paperclip/tests/scripts/test_explainer_precheck.py -q`

**Step 5: Commit**

```bash
git -C /Users/daehan/Documents/persona/paperclip add scripts/explainer_precheck.py tests/scripts/test_explainer_precheck.py
git -C /Users/daehan/Documents/persona/paperclip commit -m "feat: add explainer precheck"
```

### Task 6: Add `reader_experience_precheck.py`

**Files:**
- Create: `/Users/daehan/Documents/persona/paperclip/scripts/reader_experience_precheck.py`
- Test: `/Users/daehan/Documents/persona/paperclip/tests/scripts/test_reader_experience_precheck.py`

**Step 1: Write the failing test**

Cover:
- weak ending payoff fails
- numbered promise not surfaced early fails
- basic scan path pass case

**Step 2: Run test to verify it fails**

Run: `python3 -m pytest /Users/daehan/Documents/persona/paperclip/tests/scripts/test_reader_experience_precheck.py -q`

**Step 3: Implement minimal heuristic checker**

Emit:
- `first_dropoff_zone`
- `keep_reading_hook_present`
- `ending_payoff_present`
- `scan_path_ok`

**Step 4: Run test to verify it passes**

Run: `python3 -m pytest /Users/daehan/Documents/persona/paperclip/tests/scripts/test_reader_experience_precheck.py -q`

**Step 5: Commit**

```bash
git -C /Users/daehan/Documents/persona/paperclip add scripts/reader_experience_precheck.py tests/scripts/test_reader_experience_precheck.py
git -C /Users/daehan/Documents/persona/paperclip commit -m "feat: add reader experience precheck"
```

### Task 7: Wire research routine to scout + grounding precheck

**Files:**
- Modify: `/Users/daehan/.paperclip/instances/default/companies/a900f7fe-3219-4afb-8fc2-6f55dedd5fe8/agents/7fb4a11b-ecf6-449a-aa25-a76599a626e5/instructions/AGENTS.md`
- Modify: `/Users/daehan/.paperclip/instances/default/projects/a900f7fe-3219-4afb-8fc2-6f55dedd5fe8/fe8b7e7e-67c9-4670-9722-04ca0e10cc2b/_default/notebooklm-research-playbook.md`
- Modify routine metadata via a small tsx script in `/Users/daehan/Documents/persona/tmp/`

**Step 1: Write a small verification script**

Assert the routine description still contains:
- topic scout pre-step
- stale warning rule
- NotebookLM-first grounding requirement

**Step 2: Update routine wiring**

Make sure research execution writes:
- `topic-scout.json`
- grounding precheck result

**Step 3: Verify**

Run the scout CLI and grounding precheck against a known sample.

### Task 8: Wire draft pipeline to the preflight bundle

**Files:**
- Modify the draft/publish orchestration layer in `/Users/daehan/Documents/persona/paperclip/server/src/services/`
- Add tests under `/Users/daehan/Documents/persona/paperclip/server/src/__tests__/`

**Step 1: Add failing orchestration tests**

Assert:
- publish-ready review cannot start without required preflight JSONs
- a failed gate prevents publish-ready

**Step 2: Implement minimal orchestration**

Store preflight outputs and pass them into the merged preflight step.

**Step 3: Verify**

Run targeted `vitest` for the touched orchestration tests.

### Task 9: Adopt merged preflight in `FLU-91` flow

**Files:**
- Modify the publish-ready flow documentation and any routing scripts under `/Users/daehan/Documents/persona/tmp/` or Paperclip issue docs

**Step 1: Update blocker mapping**

`FLU-104` through `FLU-107` must be readable as direct gate inputs to `publish_ready_preflight.py`.

**Step 2: Verify**

Check that each blocker maps to one deterministic preflight result.

### Task 10: Update docs and executive board references

**Files:**
- Modify: `/Users/daehan/.paperclip/instances/default/companies/a900f7fe-3219-4afb-8fc2-6f55dedd5fe8/EXECUTIVE-FOCUS.md`
- Modify playbooks only if behavior changed

**Step 1: Add the new merged preflight surface to the focus board language**

**Step 2: Verify**

Make sure the top blocker and top quality bottleneck still point to concrete gates, not vague commentary.
