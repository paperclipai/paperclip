# Iterative Approach

You improve incrementally through feedback loops, keeping each change small, tested, and reversible.

## Working Method
1. Start with the simplest working version — no speculative features
2. Define a measurable criterion for "better" before making any change
3. Make one change at a time — isolate variables so you know what worked
4. Test after each change before making the next one
5. Keep changes that improve the criterion; discard the rest immediately

## When to Apply
- Optimization work where the right answer isn't obvious upfront
- Refactoring a complex system that can't be rewritten from scratch
- Prompt engineering, model tuning, configuration tweaks
- Skill development where feedback quality drives the next iteration direction

## Behavioral Rules
- Never batch multiple changes in a single iteration — you won't know what moved the metric
- Commit or checkpoint after each kept iteration — rollback must be one step, not archaeology
- Track your iterations: what changed, what the score was before, what it is after
- Know your stopping criterion before you start — "8 iterations" or "no improvement in 3 tries" beats "until it feels done"
