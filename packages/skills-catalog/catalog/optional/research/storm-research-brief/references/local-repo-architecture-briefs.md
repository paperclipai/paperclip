# Local repo architecture STORM briefs

Use this reference when the brief is about an existing local software/data product and the user provides both a PRD/knowledge note and a repo path.

## Pattern

1. **Treat local context as evidence, not background color.** Read the PRD/narrative note and the repo docs/code before external research.
2. **Inspect the implementation shape directly.** Minimum useful pass:
   - root README / project docs
   - package/dependency files
   - core modules that own the architecture
   - tests around the risky layer
   - dashboard/UI pages if the decision touches reporting
   - canonical data headers/counts when the question is about data systems
3. **Respect repo guardrails.** If the repo is in a read-only mirror, do not run write-producing builds/tests there. Recommend or create a worktree for later execution instead.
4. **Use external research to judge tradeoffs, not to overwrite local reality.** Primary docs for candidate tools should support stack-choice claims; the brief should still center on the user's actual system.
5. **Run lenses in tension.** For local architecture decisions, useful default lenses are:
   - operator/builder
   - data-quality/trust boundary
   - dashboard/user workflow
   - stack/architecture tradeoff
   - skeptic/failure mode
6. **Map contradictions before recommendations.** Look for gaps between stated architecture and actual implementation: direct writes bypassing review, formulas duplicated outside the metric layer, dashboard labels overstating precision, automation before manual trust, etc.
7. **Save the artifact where requested and verify it exists.** Report path, size/line count, and whether the source repo stayed clean when relevant.

## Output bias

Keep the final artifact concise and decision-oriented. For William, the best brief usually says:

- keep/change the stack;
- what risk matters most;
- what not to do yet;
- the smallest high-leverage next move;
- what evidence would make the recommendation flip.

Avoid dumping subagent reports. Synthesize and make the call.