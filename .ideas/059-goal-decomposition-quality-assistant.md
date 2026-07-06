# 059 — Goal Decomposition Quality Assistant

## Suggestion

Paperclip's core invariant is that work decomposes from the company goal down through a tree of
sub-tasks (`goals.ts`, parent/sub-issues). But the *quality* of that decomposition is left entirely
to agents, and bad decomposition is a silent, upstream cause of waste: a goal broken into chunks
that are too coarse (an agent "owns" something far too big to execute), too fine (death by a
thousand trivial sub-issues), overlapping (two branches doing the same thing), or *incomplete*
(a goal whose children don't actually add up to achieving it). The Goal-Drift Auditor (idea 026)
checks whether existing work still *traces* to a goal; nothing checks whether a goal was *broken
down well in the first place*. A flawed plan executed flawlessly still fails.

Add a **decomposition quality assistant**: analyze a goal's breakdown for structural problems and
help agents/operators produce well-formed task trees before execution pours money into a bad plan.

## How it could be achieved

1. **Structural checks (cheap, deterministic).** Over the goal/issue tree: flag leaf tasks that are
   suspiciously large (by estimate, idea 055, or scope), branches far deeper/shallower than siblings,
   single-child chains (pointless nesting), and goals with no children (undecomposed). Pure graph
   analysis over existing data.
2. **Completeness check (semantic tier).** Use a cheap model (local, idea 008) to judge "do these
   sub-tasks, if all completed, plausibly achieve the parent?" and surface likely *gaps* — the
   missing workstream nobody scoped. This is the highest-value and hardest check.
3. **Overlap detection.** Flag sibling/cross-branch tasks that look redundant (semantic similarity),
   catching two agents about to build the same thing — complements workspace conflict coordination
   (idea 042) at the planning layer rather than the file layer.
4. **Assistive, at plan time.** Run when a goal is decomposed (or a big issue is broken down) and
   offer suggestions — split this, merge those, you're missing X — so the plan improves *before*
   execution, when fixing it is nearly free. Pairs with the Dry-Run Estimator (idea 004).
5. **Score + trend.** A decomposition-quality score per goal, tracked over time, so operators can
   see whether their company plans well and improving — feeding the operator digest (idea 029).

## Perceived complexity

**Medium.** The structural checks are a straightforward tree analysis over existing data and deliver
immediate value. The semantic tiers — completeness and overlap — are more involved: they need
careful, cheap prompting and tuning to avoid noisy or wrong "you're missing something" flags that
erode trust, and they're inherently judgment calls. No execution-engine changes; it's an analyzer +
assistive suggestions. Ship the deterministic structural checks first (cheap, high-signal), then
layer in the semantic completeness/overlap analysis behind confidence thresholds.
