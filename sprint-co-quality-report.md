# Sprint-Co Skills: Quality and Integration Readiness Report

## Summary

I reviewed all five skills against each other for internal consistency, against the Paperclip skill platform (paperclip/SKILL.md), and against the integration questions you posed. The skills are well-structured and show deliberate design thinking. However, there are meaningful gaps that will cause agent confusion, failed handoffs, or broken integrations if left unaddressed before hooking in release-changelog and pr-report.

---

## Per-Skill Assessment

### sprint-protocol/SKILL.md

**Overall quality: High. The foundational layer is solid.**

**Strengths:**
- The universal handoff artifact format is the best-designed piece across the entire suite. The explicit "Context Reset Protocol" section (section 6) is architecturally important and correctly placed here.
- Time-budget table is clear and actionable.

**Issues:**

**Issue 1 — Paperclip API integration is completely absent** (Confidence: 95)

The skill defines handoff artifacts as markdown files in `./sprints/[sprint-id]/` on disk. The Paperclip skill (`paperclip/SKILL.md`) establishes that the canonical communication layer is the Paperclip issue comment system with `POST /api/issues/{issueId}/comments`, status updates via `PATCH /api/issues/{issueId}`, and checkout/release flows. There is zero mention of Paperclip anywhere in sprint-protocol. This means agents following sprint-protocol will write artifacts to disk and signal each other via direct messages, completely bypassing the platform's audit trail, heartbeat wake system, and coordination primitives.

When these skills run inside a Paperclip heartbeat, every phase transition needs to both write the disk artifact AND update the Paperclip issue. Right now they do neither — the Paperclip skill tells agents to use the heartbeat procedure, but sprint-protocol defines a parallel coordination model that ignores it.

**Fix:** Add a "Paperclip Integration" section that maps each phase transition to the equivalent Paperclip API action: checkout at phase start, comment with handoff artifact path or content at phase end, status update to `done` or `blocked`, create subtask if next phase needs its own agent.

---

**Issue 2 — "Signal Sprint Orchestrator" is never defined** (Confidence: 90)

Sections 3 and 5 repeatedly instruct agents to "Signal Sprint Orchestrator" or "message Sprint Lead" but never define what signaling means mechanically. Is it a Paperclip comment? A subtask creation? A direct assignment? Without a concrete definition, an LLM agent will improvise — and will likely do nothing, or do the wrong thing.

**Fix:** Define "Signal [role]" as: post a comment on the current sprint task `@`-mentioning the role's agent slug, or as a PATCH to reassign the issue, depending on the Paperclip workflow pattern in use.

---

**Issue 3 — Workspace path assumption is hard-coded without fallback** (Confidence: 80)

The skill assumes `./sprints/[sprint-id]/` but there is no guidance on what to do if the agent's cwd is not the project root, or if no sprint ID has been assigned yet. The paperclip/SKILL.md notes that workspace `cwd` is configured per-agent, but sprint-protocol assumes a relative path that may not resolve correctly.

---

### sprint-planner/SKILL.md

**Overall quality: High. The brief expansion methodology is thorough and well-structured.**

**Strengths:**
- V-label rules with the anti-scope-creep checklist are excellent for preventing common LLM failure modes.
- Estimation rules with explicit budget cap (100 min total) are clear.

**Issues:**

**Issue 4 — Output artifact has no Paperclip issue linkage** (Confidence: 85)

The `sprint-plan.md` format has no field for the Paperclip issue ID that triggered the sprint. When a downstream agent reads the file, it has no way to know which Paperclip task to check out, comment on, or update. This breaks the entire heartbeat loop integration.

**Fix:** Add a `**Paperclip Sprint Issue**: [issue-id]` field at the top of the sprint-plan.md template, populated from `PAPERCLIP_TASK_ID` at planning time.

---

**Issue 5 — "Handoff to Sprint Lead" section has no definition of Sprint Lead's agent slug** (Confidence: 82)

The handoff instruction references `Sprint Lead` but provides no Paperclip mention, no `@slug`, no issue update instruction. This handoff will silently disappear if the agent doesn't have a defined signaling mechanism.

---

**Issue 6 — No fallback for brief that is already a detailed spec** (Confidence: 80)

The methodology assumes a 1-4 sentence brief. If the input is already a detailed spec (which is common in practice), the expansion steps will produce redundant or contradictory content. There is no "brief is already detailed — validate and pass through" branch.

---

### sprint-generator/SKILL.md

**Overall quality: High. The implementation standards section is the most practically useful content across the suite.**

**Strengths:**
- The TypeScript and error handling code examples are concrete and directly usable.
- The self-evaluation checklist is the right mechanism to reduce QA churn.
- The refine-budget rule (two QA cycles max) prevents infinite loops — critical for agentic systems.

**Issues:**

**Issue 7 — Handoff artifact format closes its own code fence incorrectly** (Confidence: 100)

The handoff artifact template opens a fenced code block with triple backticks, then includes another triple-backtick block for bash commands. This means the outer code block is terminated early by the inner fence. Any agent using a parser that respects markdown nesting will see a malformed template. The inner bash block needs to be escaped (e.g., using four backticks for the outer block, or escaping the inner fences with `\`).

**Fix:** Use four backticks for outer block or escape inner backticks.

---

**Issue 8 — "Signal QA" in the feature lifecycle is undefined** (Confidence: 88)

Same problem as sprint-protocol. No Paperclip comment, no reassignment, no subtask creation is specified. Agents will improvise.

---

**Issue 9 — Self-evaluation scoring rubric uses different criteria than the QA rubric** (Confidence: 85)

The self-evaluation table lists: Functionality, Visual Design, Edge Cases, Code Quality. The QA evaluator rubric has: Functionality, Product Depth, Visual Design, Code Quality. "Edge Cases" (generator) vs "Product Depth" (evaluator) are different concepts — edge cases are a subset of what product depth measures. This mismatch means engineer self-scores will not be comparable to QA scores, and agents doing self-evaluation may dismiss product depth issues they are not looking for.

**Fix:** Align the self-evaluation table criteria to match the four official QA criteria exactly (Functionality, Product Depth, Visual Design, Code Quality).

---

**Issue 10 — No guidance on where to write the handoff artifact** (Confidence: 80)

The format is defined but there is no instruction about the file path. Sprint-protocol says `./sprints/[sprint-id]/` but a generator agent reading only sprint-generator/SKILL.md won't know this. The skill should either reference sprint-protocol explicitly or include the path rule inline.

---

### sprint-evaluator/SKILL.md

**Overall quality: High. The rubric is the clearest and most operational piece of writing in the suite.**

**Strengths:**
- Concrete fail/pass examples with specific scores are exactly what LLM evaluators need to avoid grade inflation.
- The "leniency traps" section explicitly addresses known LLM failure modes.
- The "REQUIRED vs OPTIONAL" tagging system is clean and actionable.

**Issues:**

**Issue 11 — "Signal Delivery Engineer" and "Signal Engineer [Alpha/Beta]" are undefined** (Confidence: 90)

The eval report format's "Next Action" section references both delivery and engineer signals with no Paperclip API action defined. This is the same unresolved signaling problem pattern across the entire suite.

---

**Issue 12 — eval-report.md is consumed by sprint-delivery but no path convention is specified** (Confidence: 85)

Sprint-delivery section 1 checks for `QA eval-report.md status is PASS` but neither sprint-evaluator nor sprint-delivery specifies the canonical path where this file lives. If the evaluator writes to `./eval-report-TASK-001.md` and delivery looks for `./eval-report.md`, the pre-deployment check silently passes on a missing file.

**Fix:** Define the canonical path explicitly as `./sprints/[sprint-id]/eval-[TASK-ID].md` in both skills, and add a file-existence check to the delivery pre-deployment checklist.

---

**Issue 13 — No guidance on what to do when the app under test cannot be started** (Confidence: 80)

The test protocol assumes the app is reachable at a URL from the handoff artifact. There is no protocol branch for "app cannot be started" or "handoff artifact URL is missing." In that scenario, an agent will either fail silently or fabricate test results.

**Fix:** Add a fail-fast rule: "if the app cannot be reached at the URL in the handoff artifact within 2 attempts, return FAIL with Functionality 0 and a specific blocker note."

---

### sprint-delivery/SKILL.md

**Overall quality: Good. The deployment mechanics are thorough. The reporting is well-structured.**

**Strengths:**
- Fallback deployment table (section 8) is a practical and important safety net.
- Git tagging format is detailed enough to be unambiguous.
- Smoke test fail protocol (section 5) has a good "5 minute rule" that prevents unlimited retriage.

**Issues:**

**Issue 14 — `wrangler.toml` `compatibility_date` is hardcoded to 2024-01-01** (Confidence: 82)

Hardcoding a date from two years ago means any sprint agent who copies this template will be running with outdated compatibility flags. This is especially risky for any sprint using `nodejs_compat`.

**Fix:** Use a current date placeholder like `[YYYY-MM-DD — use today's date]`.

---

**Issue 15 — Pre-deployment checklist item 5 will silently pass if the file exists but is wrong** (Confidence: 80)

The check is boolean (exists/doesn't exist) but the actual failure mode in practice is a malformed or stale wrangler.toml. The check should be "wrangler.toml is valid and references the correct project name and worker entry."

**Fix:** Add a one-line `wrangler.toml | grep name` validation step to catch this class of error before deployment.

---

**Issue 16 — No Paperclip issue update at deployment completion** (Confidence: 88)

Sprint-delivery has the most complete artifact format, but it contains zero Paperclip API interaction. After delivery, the canonical Paperclip task representing the sprint should be updated to `done` with a comment linking the production URL and the sprint report. Without this, the Paperclip issue stays `in_progress` indefinitely.

---

## Cross-Cutting Issues

### The Signaling Problem (Affects All Five Skills) — CRITICAL

The suite defines a coordination model ("signal Sprint Lead", "signal QA", "signal Delivery") but never maps it to Paperclip API operations. The paperclip/SKILL.md defines the correct mechanism (Paperclip issue comments with `@slug` for notification, subtask creation for delegation, PATCH for status). Every skill needs a brief "Paperclip Coordination" section that maps its outbound signals to specific API calls with the required `X-Paperclip-Run-Id` header.

**This is the highest-risk gap in the suite. Without it, the skills work correctly in a human-supervised context but break entirely when running as autonomous Paperclip agents.**

### release-changelog and pr-report Hook-In Assessment

Neither skill exists yet in `/Volumes/JS-DEV/paperclip/skills/`. Based on the current structure:

**Where release-changelog should hook in:** sprint-delivery section 6 (Git Release Tagging) is the natural integration point. After `git push origin --tags`, the delivery agent should invoke release-changelog, passing the tag name, the commit hash, and the list of shipped features from sprint-report.md. The sprint-report.md "Features Shipped" table already has the right structure to be an input to a changelog generator.

**Minimal change for release-changelog:**
```
Add a step 6e to sprint-delivery section 6:
# After push
# Generate changelog
invoke-skill release-changelog \
  --tag sprint-[ID]-v1.0 \
  --features-from ./sprints/[sprint-id]/sprint-report.md
```

**Where pr-report should hook in:** sprint-evaluator is the right integration point. At the end of a PASS eval, before signaling the delivery engineer, the QA agent should invoke pr-report to generate a summary of what changed. Alternatively, sprint-delivery could invoke it after successful smoke tests as part of the sprint-report.md generation. The delivery placement is lower risk because it only fires on confirmed-shipped work.

**Minimal change for pr-report:**
```
Add a step to sprint-evaluator section 5 "Next Action" block:
[PASS → Invoke pr-report with handoff artifact path, then signal Delivery Engineer]
```

**What modifications are needed before integration:**
1. The path convention for artifacts (`./sprints/[sprint-id]/`) must be standardized across all five skills so release-changelog and pr-report know where to find inputs. Currently only sprint-protocol defines this path.
2. The Paperclip issue ID must be threaded through the artifact chain (see Issue 4) so downstream skills can post their outputs back to the correct issue.
3. The signaling problem must be resolved so the hook-in points can actually trigger the new skills.

---

## Risk Assessment Summary

| Risk Level | Issue | Impact | Mitigation |
|-----------|-------|--------|-----------|
| **CRITICAL** | Signaling problem (all skills) | Sprint hangs indefinitely, agents don't wake up | Fix sprint-protocol "Signal X" definition first |
| **HIGH** | Paperclip API integration missing | No audit trail, no heartbeat coordination | Add Paperclip sections to all skills |
| **HIGH** | Missing issue ID in artifacts | Downstream agents can't find the task | Add PAPERCLIP_TASK_ID to templates |
| **HIGH** | Eval criteria mismatch | Engineers over-pass, QA churn increases | Align sprint-generator to QA criteria |
| **MEDIUM** | Missing file paths | Silent failures on missing artifacts | Standardize paths across all skills |
| **MEDIUM** | wrangler.toml date hardcoded | Outdated runtime behavior | Use placeholder date |
| **LOW** | Code fence nesting bug | Parser confusion | Fix markdown escaping |

---

## Recommended Integration Sequence

1. ✅ **Fix the signaling problem in sprint-protocol first.** Define "Signal X" as a Paperclip API operation. This unblocks everything else.
2. ✅ **Add Paperclip issue ID to sprint-plan.md template** (Issue 4). This gives all downstream artifacts a shared reference.
3. ✅ **Standardize artifact paths across all five skills** to reference the sprint-protocol canonical path.
4. ✅ **Fix the eval criteria mismatch** (Issue 9) — a one-line change in sprint-generator.
5. ✅ **Fix the eval-report.md path convention** (Issue 12) — two-line change across evaluator and delivery.
6. ✅ **Fix the wrangler.toml compatibility_date placeholder** (Issue 14).
7. ✅ **Fix the code fence nesting bug in sprint-generator** (Issue 7).
8. ✅ **Add Paperclip issue close/update to sprint-delivery completion** (Issue 16).

**Steps 1-3 are blockers for release-changelog and pr-report integration.** Steps 4-8 are important but do not block the hook-in work.

---

## Testing Strategy Per Skill

**sprint-protocol**: Test with a simulated session reset — write a handoff artifact mid-sprint, start a new session with only that artifact available, and verify the new session can reconstruct full sprint state. The test should fail today because the Paperclip issue ID is not in the artifact.

**sprint-planner**: Run against three brief types: (a) minimal 1-sentence brief, (b) ambiguous brief with scope creep potential, (c) already-detailed spec. Verify V-label assignments and estimate totals stay within the 100-minute cap.

**sprint-generator**: Test the refine budget explicitly — submit a feature that fails QA twice, verify the agent signals Sprint Lead rather than continuing to iterate. This is the infinite loop prevention test.

**sprint-evaluator**: Test the auto-fail conditions explicitly (500 errors, SQL injection patterns, .env in git). These should score 0 regardless of other criteria. Test the "on the fence" scenario to verify the "fail if in doubt" bias holds against grade inflation.

**sprint-delivery**: Test the smoke test fail protocol with a deliberately broken deployment. Verify the "5 minute then report" rule fires rather than indefinite retry. Test the fallback deployment path (Vercel) with a deliberate Cloudflare failure.

---

## Conclusion

The five skills are well-designed for their domain (3-hour sprint execution), but they are not yet ready to integrate into Paperclip's heartbeat and API system. The work required is not large (most fixes are 1-5 lines), but it is critical. The highest priority is resolving the signaling problem — without that, the entire coordination model breaks.

Once the blocking issues (1-3) are resolved, release-changelog and pr-report can be integrated with minimal changes to the existing skills.

