DAILY OUTREACH QUEUE REFILL — DISTANCE FROM OBERBUCHSITEN + EXCEPTIONAL SWISS PROSPECTS

Goal: maintain, not blindly add to, one bounded outreach queue:
- up to 10 distance-prioritized prospects from Oberbuchsiten;
- plus up to 2 exceptional nationwide prospects outside the active distance band.

No outward email may be sent by this routine. Its terminal output is researched REV-06 work that
becomes an editable Alan approval card through the normal guarded path.

1. Call `espo_rank_prospects` exactly once with:
   `{"origin":"Oberbuchsiten","local_slots":10,"exceptional_slots":2,"limit":3,"create_task_pairs":true}`.
   This scans the complete Espo Account universe, suppresses prior contact, active work, approvals,
   Opportunities, do-not-contact targets and missing verified email, then uses verified CRM
   addresses plus OSRM road data for driving kilometres and minutes. The deterministic queue
   applies a minimum CRM qualification score of 60; “up to 10” must never be padded with weak
   nearby accounts.

2. Read only `distance_queue`. If `ok` is not true, report the precise blocker and stop. Never
   substitute guessed locations, canton-only selection, famous venues, straight-line distance, or
   manual web search for the deterministic result.

3. `slots_to_fill` is authoritative. It already counts active REV-06 work, pending approvals and
   Hold/revision states. If total is zero, report that the 10+2 queue is full and stop. This is a
   refill target, not permission to create 12 additional drafts every day.

4. The same deterministic call creates every selected pair atomically enough for this workflow:
   one REV-04 research task first and one REV-06 draft task blocked by that research. It copies the
   account, lane, score and driving evidence into both briefs and puts
   `[OUTREACH_LANE:local]` or `[OUTREACH_LANE:exceptional]` on the draft. Inspect
   `distance_queue.task_pairs`; do not call `create_task` yourself and do not call the ranker again.
   If any pair has `ok:false`, report that exact pair as failed. A later daily refill safely retries
   the remaining capacity after active work suppression.

5. Post one concise completion comment: full-universe coverage, active radius, occupied local and
   exceptional slots, slots refilled, and the created issue pairs. Do not paste tool traces.

Safety:
- Never send mail.
- Never create extra tasks outside `distance_queue.task_pairs`.
- A general mailbox never proves a named person receives it.
- Tres Hermanos is a Swiss company with its own cigar factory in the Dominican Republic.
- Distance is a prioritization signal; CRM fit and the 2 exceptional slots preserve high-value
  nationwide opportunities.
