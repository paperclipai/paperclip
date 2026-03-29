---
name: iterative-optimization
description: Use when a task requires multiple rounds of refinement with measurable improvement — prompt engineering, documentation, protocol validation, content optimization. Implements a structured iterate-evaluate-decide cycle.
---

# Iterative Optimization Skill

Based on agent-digivolve-harness patterns for structured iteration.

## Core Principle

> "The first draft is not the hard part. The hard part is iteration."

This skill prevents optimization work from degrading into unstructured trial-and-error.

## The Cycle

```
DEFINE → BASELINE → MUTATE → EVALUATE → DECIDE → (repeat)
```

### 1. DEFINE Success Criteria
Before any iteration, establish:
- **Binary checks**: Pass/fail gates (e.g., "output must contain X", "latency < 200ms")
- **Rubric**: Weighted scoring criteria (e.g., clarity: 30%, accuracy: 40%, tone: 30%)
- **Calibration examples**: Known-good and known-bad outputs for reference

### 2. BASELINE
- Record the current state as version 0
- Score it against all criteria
- This score is the bar to beat

### 3. MUTATE (Bounded)
- Make ONE focused change per iteration
- Document what changed and why
- Keep mutations small enough to attribute results

### 4. EVALUATE (Independent)
- Score the new version against the same criteria
- Compare to baseline AND previous best
- Use objective measures where possible

### 5. DECIDE
- **Keep**: New version scores higher → becomes new baseline
- **Discard**: New version scores lower → revert, try different mutation
- **Stop**: Improvement < threshold for 3 consecutive rounds

## Evaluation Template

```yaml
# evals/checks.yaml
checks:
  - name: "Basic validity"
    test: "output is not empty"
    required: true
  - name: "Format compliance"
    test: "output matches expected structure"
    required: true

# evals/rubric.yaml
criteria:
  - name: "Accuracy"
    weight: 0.4
    scale: 1-5
    description: "Factual correctness"
  - name: "Clarity"
    weight: 0.3
    scale: 1-5
    description: "Easy to understand"
  - name: "Completeness"
    weight: 0.3
    scale: 1-5
    description: "Covers all requirements"
```

## Best Use Cases
- Prompt optimization
- Documentation refinement
- API response format tuning
- Agent instruction improvement
- Content generation quality
- Configuration optimization

## Anti-Patterns
- Do NOT use for discovery tasks (when you don't know what success looks like)
- Do NOT use for highly subjective criteria
- Do NOT make multiple changes per iteration
