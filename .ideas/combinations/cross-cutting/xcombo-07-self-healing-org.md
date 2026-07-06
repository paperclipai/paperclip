# Cross-Cut 07 — The Self-Healing Org

**A different cut:** the industry's "self-healing systems" all heal *infrastructure* (a crashed service,
a bad deploy). This applies the same proven detect→diagnose→remediate→verify loop **one level up — to
the organization itself**: an org that notices it's understaffed, flaky, or mis-structured and *repairs
its own staffing and shape* without a human firefighting it. The novelty is the target (the workforce),
not the loop.

**Synthesizes:** 044 Agent Reliability SLOs · 048 Competency-Gated Job Postings (backfill) ·
052 Org Restructuring Simulator · 057 Incident Management & On-Call
*(refs: 009 trust demotion, 025 reassignment, 063 capacity forecast, combo 03 detectors)*
*(pulls from thematic combos 07, 09, 03)*

## Industry grounding (web research, June 2026)

The self-healing pattern is mature and quantified — which gives us both the loop shape and the
differentiation:

- **The canonical self-healing loop:** "combine continuous monitoring, AI-driven analysis, and automated
  remediation… detect abnormal behavior, diagnose failures, and execute corrective actions in real
  time," then **verify outcomes**. → adopt detect → diagnose → remediate → **verify** exactly.
- **It works, measurably:** agentic SRE "reduces MTTR by 80%," cutting recovery "from hours to minutes."
  → an org that auto-backfills a failed role recovers staffing in minutes, not the days a human would take
  to notice and re-hire.
- **The human role shifts to *reliability architect*:** "from firefighting to system design, resilience
  engineering, and improving the AI agents themselves." → the human sets SLO targets and remediation
  *policy*; the org heals *within* those bounds. (Maps to the Autonomy Dial, cross-cut 01.)
- **But all of it heals infra/incidents** — none of it heals *the org's own staffing and structure*.
  That's the open space this cut occupies.

## The unified idea — a closed self-healing loop over staffing & structure

Wire the four ideas into one continuous loop, each supplying one stage:

1. **Detect (044 + combo 03).** Per-agent reliability SLOs/error budgets surface a *flaky* agent
   (crashes, constant recovery, low completion); the Health Sentinel surfaces deadlocks/bottlenecks; an
   incident (057) fires for an operational failure. Continuous monitoring of org health, not just runs.
2. **Diagnose.** Classify the failure: is it the **agent** (misconfig/flaky runtime — pairs with provider
   diagnosis, idea 012), the **role** (unstaffed / overloaded — a capacity gap, idea 063), or the
   **structure** (a reviewer removed from a path, a span-of-control blowout — idea 052)? Diagnosis picks
   the remediation.
3. **Remediate — the org-level actions (the novel part).**
   - *Agent fault* → auto-constrain the agent (lower concurrency, drop trust stage 009, pause), and
     reassign its in-flight work (025) so the queue keeps moving.
   - *Role gap* → **auto-reopen a competency-gated job posting (048)** to backfill; a candidate is hired
     only on passing the acceptance test — *self-staffing*, not blind re-hire.
   - *Structural fault* → propose a reorg via the simulator (052) with impact preview, applied atomically
     (auto-Drain first) under the human-set policy.
   - *Operational incident* → on-call routing (057) pages the responder / runs the runbook, SEV1 can
     auto-Drain (combo 01).
4. **Verify.** The remediation must *prove* it worked: the backfill candidate passed its test (048), the
   agent's SLO recovers within the error budget, the deadlock cleared. If not, escalate to the next tier
   (another remediation, then a human). This verify-or-escalate step is what makes it healing, not flailing.
5. **Human as reliability architect.** The operator sets the SLO targets, the backfill/reorg *policies*,
   and the autonomy ceiling (cross-cut 01); the org self-heals within them and reports what it did
   (operator digest, combo 05) — "Research-bot failed its SLO, auto-paused, backfilled by a new hire that
   passed the test; staffing restored in 6 min."

## Why this is a *better* idea than the parts

Separately: reliability SLOs (044) just *flag* a bad agent; job postings (048) just *exist*; the reorg
simulator (052) is a *manual* tool; incidents (057) page a human. None *closes the loop*. Wired together —
detect → diagnose → remediate → verify — staffing and structure become self-repairing, which is the
property that makes a 24/7 autonomous org survivable without a human watching it degrade. It's also the
*organizational* complement to combo 09 (which heals data/infra/runtime) and the staffing complement to
combo 07-thematic (self-staffing): this one adds the **failure-triggered, verified** healing path.

## Phasing

1. Reliability SLOs + error budgets with the detect signal (044) and the diagnose classifier — read-only
   ("this agent is burning its budget") first.
2. Soft remediations: auto-constrain/demote/pause + reassign (009/025) on SLO burn, verified by recovery.
3. Auto-reopen-posting backfill (048) on role gaps, gated by the competency test (verify built in).
4. Structural remediation (052) + incident-triggered healing (057) under explicit human policy; full
   verify-or-escalate ladder.

## Ratings

- **Difficulty:** High — the stages mostly reuse other combos' machinery, but *closing the loop safely*
  is hard: diagnosis must be accurate (mis-diagnosing a provider outage as a flaky agent would demote a
  good agent), remediation must be bounded by policy (auto-reorg/auto-hire are high-blast-radius — keep
  them behind the human-set ceiling), and the verify step must be real or the loop oscillates.
- **Estimated time to complete:** ~6–8 engineer-weeks atop 044/048/052/057 existing.
- **Importance:** 7/10 — high value for large, long-running, multi-agent orgs (the workforce repairs
  itself, MTTR-for-staffing in minutes), but it's an advanced capstone that depends on the staffing and
  reliability primitives being in place, and its high-blast-radius actions demand the governance ceiling first.

## Sources

- [Self-Healing Software Systems — Impala Intech](https://impalaintech.com/blog/self-healing-software-systems/)
- [AI SRE Explained: Autonomous Agents Slash MTTR by 80% — Rootly](https://rootly.com/sre/ai-sre-explained-autonomous-agents-slash-mttr-80)
- [Agentic SRE: How Self-Healing Infrastructure Is Redefining Enterprise AIOps in 2026 — Unite.AI](https://www.unite.ai/agentic-sre-how-self-healing-infrastructure-is-redefining-enterprise-aiops-in-2026/)
- [Self-Healing Systems using AI-based Auto-Remediation — Infosys](https://www.infosys.com/iki/techcompass/self-healing-systems.html)
