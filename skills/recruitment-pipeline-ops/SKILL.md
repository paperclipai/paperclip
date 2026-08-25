---
name: recruitment-pipeline-ops
description: ThinkStack Recruitment procedures for the candidate pipeline and the $29 CV-polish wedge. Use for candidate issues ("Onboard first candidate", "intake follow-up", "questionnaire nudge", "job market scan", "Route ... questionnaire reply") and PHASE-0-WEDGE CV-polish orders. Encodes the intake questionnaire flow, the profile gate, the SLA clock rules, the least-privilege comment-routing pattern, and the delivery-SOP stage owners for paid orders.
---

# Recruitment Pipeline Ops

Two revenue lanes: the **candidate pipeline** (place candidates; currently first candidate = Davin McGrath, who is also the board user) and the **PHASE-0-WEDGE** ($29 CV polish, Stripe-fed). Both run on documents-of-record plus strict issue-ownership routing — most wasted heartbeats in history came from agents trying to comment on issues they don't own.

## Candidate pipeline (THIAA-14/15 pattern)

Each candidate gets a **parent issue** ("<Name> — recruitment") holding the `candidate-profile` document, with stage children under it.

1. **Intake**: read the CV in full, pre-fill the profile against the `candidate-profile-schema` (THIAA-7), and document every gap. Draft the intake questionnaire (Book-of-record shape: 22 questions / 6 parts — eligibility & logistics, preferences, career goals in the candidate's own words, per-role STAR deepening on top 3 roles, two narrative framings; don't re-ask CV-obvious facts; no DOB / government IDs).
2. **CEO spot-check before sending** — questionnaire goes out only after CEO clears it.
3. **Delivery channel**: when the candidate is the board user, post the questionnaire as a comment on the parent candidate issue — the issue thread is the canonical channel, no external email. Start the **48-business-hour SLA clock** in the message and cite the SLA policy doc (THIAA-8).
4. **Profile gate**: Work Authorization + Preferences + Career Goals sections must be filled before downstream work (job market scan, submissions) starts. The gate is what blocked the Davin lane for 13+ days — nudge on SLA breach, don't silently wait.
5. **On reply**: route answers to **CandidateIntakeSpecialist** to fold into the candidate-profile doc; gate clears; the job-market-scan child wakes via `issue_blockers_resolved`.
6. **Application-pack delivery** (Stage 9): external job submission is outside TSR automation scope. Verify role liveness, produce the truthful QA-passed CV/cover-letter/answer pack, and send the complete pack only to the candidate/operator Gmail through the governed TSR delivery rail — **the governed rail is `POST /api/applications/[id]/automation/callback` in `~/tsr-recruitment-app`, not a direct Gmail send.** That route is the only code path that both emails the pack and records `PACK_DELIVERED` on the application; a Gmail send that bypasses it leaves the app believing the work is still in-flight forever (root cause of `TSR-5762`/`TSR-5817` — nine applications stuck for weeks despite some being genuinely delivered). The provider receipt, sent timestamp, governed recipient binding and exact attachment hashes are the terminal evidence. Do not navigate, fill, stage or submit employer portals, and do not create final-submit approval interactions. Chat and board attachments are not the candidate approval surface; the Gmail-delivered pack is. **Before closing a `[PACK EMAIL_ONLY]` issue as done, run `npx tsx scripts/verify-pack-delivered.ts --app-id <applicationId>` in the app repo — it must exit 0 (workflowStatus PACK_DELIVERED with a recorded provider receipt). Exit 1 means the callback was never posted; call it with the contract from the issue description before closing, or record the true non-delivery outcome instead.**

### Application pack terminal contract (operator ruling 2026-08-03)

- TSR may research roles, tailor documents, run QA and prepare an answer crib.
- The only automated external send is the complete pack to the governed candidate/operator Gmail binding. Never send it to another recipient.
- A pack is complete only when the mail provider returns a durable message receipt and the exact attachment hashes are recorded.
- Do not fill or submit external job portals, even when an old issue, application record or executor says `STRUCTURED_PORTAL`, `AWAITING_FINAL_APPROVAL` or `SUBMITTED`. Those states are legacy and are superseded by this policy.
- Do not ask the candidate to approve a pack from chat or a board attachment. Deliver it to Gmail for review and close the production lane at that receipt.
- If a remote application tracker cannot represent `PACK_DELIVERED`, keep the board issue governed by this contract and raise one platform change to add the state; never fall back to a submission status.

### CV/CL positioning gate

Every CV and cover letter must frame the candidate as the strongest truthful answer to the target role, not as someone asking permission to stretch.

- **Held-title integrity:** experience headings may use only titles the candidate actually held. Never use the target job title as the CV headline if it can read as a held title. Use truthful positioning instead, for example `Technical Support & Customer Operations Leader | Enterprise Support, Escalations, Enablement`.
- **Value thesis first:** the top third of the CV must answer "why this candidate is a missed opportunity if ignored" using evidence: scope led, customer outcomes, business impact, systems improved, and relevant domain exposure.
- **Stretch handling:** do not lead with apologies or gap confessions. Gaps belong in interview prep or a short honest bridge only after the value thesis is clear. The cover letter may acknowledge a stretch area, but it must pivot immediately to the evidence-backed adjacent strength.
- **Cover-letter alignment:** the cover letter must carry the same thesis as the CV headline and summary. If the CV positions the candidate as a customer-facing systems/support leader, the letter should deepen that story with one or two concrete outcomes, not reframe them as an associate applicant.
- **Role-fit language:** use target-role wording as future-facing intent (`targeting`, `applying for`, `relevant to`) or capability mapping, never as invented employment history.
- **QA check before send:** explicitly scan the rendered PDF text for target-title leakage, over-apologetic phrasing, weak "I have not..." paragraphs, fabricated title risk, and title/experience mismatches. A recipient-visible attachment proof is not content approval.

### The routing pattern that actually works (THIAA-464/466/469)

Least-privilege blocks comments on issues you don't own, and checkouts of owned issues return 409 (never retry). When you need a comment posted on someone else's issue:
- Create a **child issue assigned to the owner** (or RecruitmentManager) carrying the full draft text to post.
- Build the continuation chain explicitly and write it in the comment, e.g.: candidate replies on parent → owner (CEO) resolves the routing issue → blocked stage issue wakes → CandidateIntakeSpecialist folds answers → gate cleared → next stage wakes.
- `ask_user_questions` is multiple-choice-only — unsuitable for free-text intake; don't reach for it.

## CV-polish wedge orders ("[PHASE-0-WEDGE] CV polish order <id>")

The stage contract is the **`delivery-sop` document on THIAA-47** — read it before acting; summary:

1. **Trigger**: order issue minted by the Stripe webhook (THIAA-33). Payment confirmed ≠ clock running: the **SLA clock starts on intake-form submission** (CV upload + target role), not on payment. An order without a form stays `blocked` pending the customer, with the intake URL (`/cv-polish/intake?session_id=...`) in the thread.
2. **Intake review** — RecruitmentManager, ≤30 min: PDF sanity check, create candidate-snapshot doc; clarification loop pauses the SLA.
3. **Draft pass** — ApplicationWriter, **Haiku enforced** (MC condition on THIAA-32), ≤90 min, child-issue pattern; deliverables: CV .docx + .pdf, cover letter, token telemetry.
4. **QA pass** — RM, ≤45 min: PASS/REVISE with specific feedback; max 1 revision cycle on Haiku; second fail escalates to CEO.
5. **Final polish + A/B** — orders 1–5 run dual Haiku/Sonnet child issues; RM picks the winner.
6. Refund/quality-bar policy is published (THIAA landing-page policy issues) — apply it rather than improvising on an unhappy order.

Stripe is **test mode only** until the board flips live creds ("build wedge launch-ready in Stripe test mode (no live creds)") — never assume live billing.

## Known failure points

- Profile-gate stalls: questionnaire unanswered 13+ days with no nudge until 2026-06-10. Nudge at SLA breach via the routing pattern, and re-nudge on a stated cadence (TODO: cadence not yet board-ratified — propose one in the nudge issue).
- Comment/409 walls burning heartbeats (THIAA-464 tried comment + checkout before falling back to the child-issue route — go straight to the route).
- Wedge order THIAA-488 blocked on customer form — correct state, but make the blocked-on-customer status and intake URL explicit so watchdogs don't churn it.

## References

- `references/pipeline-evidence.md` — issue trail for the Davin lane and the wedge build-out.


<!-- TOOLS-2026-06 -->
## Local tools
- OCR scanned/image resumes and docs with `tesseract` (e.g. `tesseract cv.png out` → `out.txt`) before parsing.
