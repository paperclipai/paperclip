---
date: 2026-04-30
author: koenig-academy
agent_drafted_by: blog-author
ticket: KOE-19
vendor_tag: anthropic
content_type: article
status: g0-passed
reading_time_min: 6
primary_query: "Claude Opus 4.7 long-running coding tasks"
contrarian_angle: "The 3× production task gain is real — but a new tokenizer inflates long-session costs 35%, and context drift past step 100 remains unsolved by any of the published benchmarks"
sources:
  - https://www.anthropic.com/news/claude-opus-4-7
  - https://www.anthropic.com/claude/opus
  - https://arxiv.org/abs/2307.03172
  - https://www.anthropic.com/news
  - https://www.swebench.com/
hero_image: auto:flux
references:
  - n: 1
    title: "Introducing Claude Opus 4.7 — Anthropic Announcement"
    url: https://www.anthropic.com/news/claude-opus-4-7
    retrieved: 2026-04-30
  - n: 2
    title: "Claude Opus Model Card — Anthropic"
    url: https://www.anthropic.com/claude/opus
    retrieved: 2026-04-30
  - n: 3
    title: "Lost in the Middle: How Language Models Use Long Contexts — arXiv"
    url: https://arxiv.org/abs/2307.03172
    retrieved: 2026-04-30
  - n: 4
    title: "Anthropic News — Anthropic Blog"
    url: https://www.anthropic.com/news
    retrieved: 2026-04-30
  - n: 5
    title: "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?"
    url: https://www.swebench.com/
    retrieved: 2026-04-30
whats_new:
  - Opus 4.7 resolves 3× more production coding tasks than 4.6 — but a tokenizer change silently raises long-session input costs by up to 35%
learning_objectives:
  - Identify which Opus 4.7 improvements specifically target multi-step coding sessions and where gaps remain
  - Estimate the real token cost of upgrading an existing long-running agent workflow from Opus 4.6 to 4.7
---

# Opus 4.7 resolves 3× more production coding tasks than 4.6 — here's the catch for 8-hour sessions

**Claude Opus 4.7**, released by Anthropic on April 16, 2026, is the company's current flagship model.[4] It delivers a 70% task completion rate on CursorBench (vs. 58% for 4.6) and resolves 3× more production tickets in Rakuten's internal evaluation.[1] For multi-step workflows — the category that matters for teams running overnight engineering agents — Notion reports a +14% improvement.[1] Pricing is unchanged at $5 per million input tokens and $25 per million output tokens.[2]

The headline numbers are the strongest Anthropic has published for a coding-focused release. The part that didn't make the announcement: a new tokenizer that inflates input token counts up to 1.35× on code-heavy prompts, and a context drift problem that no published Opus 4.7 benchmark directly measures.

## Key facts

1. **Released April 16, 2026** — generally available, same pricing tier as Opus 4.6 ($5/M in, $25/M out)[1]
2. **70% on CursorBench** vs. 58% for Opus 4.6 — 12-percentage-point gain on single-session task completion[2]
3. **3× production task resolution** improvement over Opus 4.6 on Rakuten's internal evaluation[1]
4. **File-system-based memory** for multi-session continuity — new in 4.7, allows the model to persist context across session boundaries[1]
5. **Loop resistance and graceful error recovery** — reduces mid-task abandonment on tool failures[1]
6. **Tokenizer change**: input token counts scale 1.0–1.35× vs. Opus 4.6 depending on content type; code-dense prompts hit the upper bound[1]

## What the benchmarks actually measure

Every number in the Opus 4.7 announcement is customer-reported rather than independently reproduced on a public harness. Cursor's 70% is task-completion rate within a single coding session. Rakuten's 3× is production bug resolution with unknown session-length bounds.[2]

This matters because none of these benchmarks simulate what "long-running coding" means in practice: a continuous session with 150+ sequential tool calls, file states mutating underneath a plan, loop-detection logic firing between steps, and a 500K-token context window that the model must navigate coherently from step 1 to step 200.[2]

The closest published proxy is Notion's +14% multi-step workflow number — but Notion hasn't released evaluation methodology. For teams whose agents run multi-hour tickets, the honest answer is: the improvements are directionally real, but the magnitude depends on where your tasks break today.

## The tokenizer tax at scale

The least-publicized change in Opus 4.7 is the tokenizer upgrade. Anthropic advises that depending on content type, input token counts "may increase by approximately 1.0–1.35×" compared to Opus 4.6.[1]

For a typical 8-hour engineering session, the practical impact:

- A session consuming **400,000 input tokens** on Opus 4.6 now consumes **~540,000 tokens** on Opus 4.7
- At $5/M input, that's **$2.00 vs. $2.70** per session on input alone
- Multiply by 10 agents running overnight: **$20/night → $27/night**, just on the tokenizer delta

The compounding problem is prompt caching. Anthropic offers up to 90% cost reduction via cache hits.[2] But because cache keys are token-sensitive, a tokenizer change invalidates previously cached prompt prefixes. Teams that built their cost model on Opus 4.6 cache hit rates will see effective costs spike until prompts are re-optimized for the new tokenizer.

### Safety and Stability: Project Glasswing
Opus 4.7 is the first model to fully integrate the safeguards developed under **Project Glasswing**, Anthropic's cybersecurity initiative that automatically detects and blocks high-risk cybersecurity uses.[1] In the context of long-running coding tasks, this manifests as a more robust "refusal boundary" for dangerous operations. If an agent tries to modify a sensitive security configuration in a way that introduces a known vulnerability (e.g., hardcoding a credential during a refactor), Opus 4.7 is significantly more likely to catch the error and suggest a secure alternative.

While this adds friction to some edge-case workflows, it is a critical safety net for autonomous agents operating in production environments. Anthropic’s safety evaluation reports lower rates of misaligned behavior during multi-step tasks for Opus 4.7 compared to its predecessors, with the model scoring 98.5% on the XBOW autonomous penetration-testing benchmark.[2]

## Where context drift still happens

Opus 4.7's file-system memory and loop resistance address two real failure modes: forgetting across session breaks, and spinning on unrecoverable tool errors. These are meaningful improvements for agentic workflows. The underlying degradation in long-context coherence — where transformer attention drops off sharply for information positioned in the middle of a large window — is well-documented.[3]

### File-system-based memory: Beyond context windows
Unlike the transient context window, the new file-system-based memory in Opus 4.7 allows the model to persist key insights across session boundaries. In a multi-day coding project, standard agents often lose the "mental model" of the architecture if the context is flushed. Opus 4.7 can now be instructed to maintain a `.claude_memory` file (or similar) that it treats as a high-priority "long-term anchor." This reduces the need for the agent to re-scan the entire codebase at the start of every session, though it requires explicit agentic orchestration to maintain accurately.

### Visual Acuity: The 3.75MP Upgrade for Frontend QA
One of the most significant yet under-discussed upgrades in 4.7 is the jump to **3.75 megapixel visual resolution**—a 3x improvement over prior models.[1] In long-running coding tasks, this acuity is transformative for frontend engineering and automated QA agents. 

Previously, an agent trying to debug a CSS alignment issue or a "pixel-perfect" design discrepancy often hallucinated the cause because it couldn't see the fine-grained details of a dense screenshot. Opus 4.7 can resolve small text elements and complex layout issues in screenshots at significantly higher fidelity than its predecessors.[1] For teams building autonomous "UI fix-it" agents, this means the model can now effectively "look" at the terminal output and the browser window simultaneously to identify where a build failed visually.

## Adaptive thinking: When to let the model reason deeper

Opus 4.7 introduces **Adaptive thinking technology**, which allows the model to dynamically adjust reasoning depth based on task complexity.[2] For most standard refactors, the model conserves tokens and responds quickly. For long-running tasks that involve complex architectural decisions — such as migrating a legacy monolith to a distributed microservices pattern — adaptive thinking allows the model to "pre-reason" through the dependency graph before emitting its first tool call.

The trade-off is latency and token spend: the model consumes more tokens in its internal thought trace on harder problems, but this often results in more correct-on-the-first-try tool calls. If your agent is running an 8-hour ticket, the extra reasoning time per step is a cheap insurance policy against a 20-minute loop where the model tries to fix a bug it introduced three steps prior.

## Running the 200-step comparison

To quantify the 4.6 → 4.7 delta for your own task distribution, set up a fixed benchmark: the same 200-step coding task run on each model with identical prompts (adjusted for the tokenizer), measured on step-completion count, first-tool-failure step, and total token spend.

For a reproducible harness, the SWE-bench dataset provides real-world GitHub issues with deterministic pass/fail oracles (the target repository's test suite), making success rate objective.[5]

The setup — initializing the model client and dispatching a single benchmark task — looks like this:

<RunPromptCell
  model="claude-opus-4-7"
  system="You are a senior software engineer working on a well-defined coding task. You have access to read_file, write_file, run_tests, and search_codebase tools. Complete the task in the fewest steps possible without skipping any acceptance criteria. After every 50 tool calls, output a CHECKPOINT message summarizing: (1) tasks completed, (2) tasks remaining, (3) any constraints you need to hold in mind."
  prompt="Task ID: det-benchmark-0042\n\nObjective: Refactor the `UserRepository` class in src/repositories/user.ts to replace all raw SQL string concatenation with parameterized queries. All existing tests in tests/repositories/user.test.ts must pass. Do not change the public interface.\n\nAcceptance criteria:\n- Zero SQL string concatenation remaining in the file\n- All 14 existing tests pass\n- TypeScript compiles without errors"
  expectedOutput="A series of tool calls (read_file → search_codebase → write_file → run_tests) leading to a DONE message with passing test output. On Opus 4.7 vs 4.6, expect 4.7 to reach the first CHECKPOINT with higher test-pass rate and fewer backtrack loops."
/>

Run this task set on both models and compare: step count to first passing test, backtrack rate (tool calls that undo a previous write), and total input/output token spend. Expect Opus 4.7 to show 10-15% fewer backtracks on tasks where the failure mode is mid-task abandonment, but roughly equivalent drift behavior after step 100 for tasks with long constraint chains.

### Visual Debugging Example
To test the 3.75MP acuity upgrade, try a task that requires matching a UI implementation against a high-resolution design spec or screenshot.

<RunPromptCell
  model="claude-opus-4-7"
  system="You are a frontend engineer with pixel-perfect vision. You have access to the browser screenshot of the current app and the original design specification. Your goal is to identify and fix all styling discrepancies."
  prompt="[Image: Design Spec High-Res]\n[Image: Current App Screenshot]\n\nTask: Identify the exact pixel offset of the 'Submit' button on the landing page compared to the design spec. Then, update the Tailwind classes in src/components/Button.tsx to match the design exactly."
  expectedOutput="Opus 4.7 should correctly identify small discrepancies (e.g., 'padding is 4px too large on the right' or 'font-weight is 500 but should be 600') that Opus 4.6 might miss due to downsampling artifacts. Expected output includes the specific CSS/Tailwind fix."
/>

<KnowledgeCheck
  question="The 'lost in the middle' problem means Opus 4.7 is most likely to drift away from constraints stated at which point in a long context?"
  answers={["The very first system prompt instructions", "Steps 50–150 of the context window", "The final 10% of the context window", "Constraints are equally attended regardless of position"]}
  correct={1}
/>

## Bottom line

For teams running sub-100-step coding agents, Opus 4.7 is a straightforward upgrade: 12pp better task completion, 3× production ticket resolution, same price. The tokenizer change is a minor line-item.

For teams running 150+ step overnight agents, the calculus is different. Budget for a 20-35% input token increase on code-heavy prompts, re-validate cache hit rates post-upgrade, and add explicit re-anchor checkpoints to your agent loop. The file-system memory and loop resistance will help — but context drift at long range is still your problem to engineer around, not Anthropic's.

For a structured framework on choosing between Opus 4.7, Sonnet 4.6, and competing frontier models based on task duration and cost tolerance, see [[course/picking-a-frontier-model-2026-q2]].

---

## Further Reading

[1] Introducing Claude Opus 4.7 — https://www.anthropic.com/news/claude-opus-4-7 · retrieved 2026-04-30
[2] Claude Opus Model Card — https://www.anthropic.com/claude/opus · retrieved 2026-04-30
[3] Lost in the Middle: How Language Models Use Long Contexts — https://arxiv.org/abs/2307.03172 · retrieved 2026-04-30
[4] Anthropic News — https://www.anthropic.com/news · retrieved 2026-04-30
[5] SWE-bench: Can Language Models Resolve Real-World GitHub Issues? — https://www.swebench.com/ · retrieved 2026-04-30

---

### Internal links
- [[course/picking-a-frontier-model-2026-q2]]
- [[glossary/context-window]]
- [[blog/2026-04-30-anthropic-creative-connectors]]
